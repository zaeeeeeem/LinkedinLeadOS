import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse } from "../../core/challenge/classify.js";
import type { ChallengeDetection } from "../../core/challenge/classify.js";
import { CHALLENGE_PRECEDENCE } from "../../core/challenge/classify.js";
import { summarizeCaptures } from "../profile.capture/patterns.js";
import type { EndpointRow } from "../profile.capture/patterns.js";
import { RECEIPT_ENDPOINT_CAP } from "../profile.capture/index.js";
import { readLikeAHuman } from "../profile.capture/read.js";
import { captureDomSnapshot } from "../profile.capture/snapshot.js";
import type { DomSnapshotResult } from "../profile.capture/snapshot.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import {
  FIRST_CAPTURE_TIMEOUT_MS, SETTLE_MS_MAX, SETTLE_MS_MIN, SNAPSHOT_TIMEOUT_MS,
} from "../profile.capture/constants.js";
import { absoluteTimeLeaves, buildActivityDomMap } from "../../core/fixtures/activitymap.js";
import {
  ACTIVITY_PATTERNS, BROAD_PATTERN_NAME, activityDocumentPatterns, isActivityIsh,
  sessionUrnHits, urnInventory,
} from "./patterns.js";
import { ACTIVITY_SURFACES, normalizeActivityUrl, looksLikePostPermalink } from "./url.js";
import { MAX_INVENTORIED_BODIES } from "./constants.js";

const args = z
  .object({
    /** A `/in/<vanity>/recent-activity/…` url, a bare vanity slug, or a post
     *  permalink (`/feed/update/urn:li:activity:…` or `/posts/…`). */
    url: z.string().min(1),
    /** Which tab, when the url does not name one. Refused when it disagrees
     *  with a url that does. */
    surface: z.enum(ACTIVITY_SURFACES as unknown as [string, ...string[]]).optional(),
    /** Scroll passes. Omitted: a randomized 3–6. `0` captures above the fold only. */
    scrolls: z.coerce.number().int().min(0).max(12).optional(),
    captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
    layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
  })
  .strict();

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message, evidence,
  });
}


/**
 * How much of the feed was left unread, in pixels. `0` when it was read to the
 * bottom, or when the page could not be measured at all.
 *
 * A function rather than three lines inline, because the distinction it turns
 * on is invisible at the call site and cannot be staged end to end: it reads
 * `travelled` — where the scroller ended up — and never `scrolled`, which is
 * distance dispatched and counts a pass back up as progress. `readLikeAHuman`
 * takes a back-pass a quarter of the time, so 600 down, 300 up, 300 down is
 * 1200px of `scrolled` at position 600, and the wrong one of these reports a
 * 900px page as fully read from halfway down. The capability cannot inject an
 * rng to force that sequence; a unit test on this can.
 */
export function feedShortfall(
  reading: { travelled: number; scrollable: number | null } | null,
): number {
  if (reading === null || reading.scrollable === null) return 0;
  return Math.max(0, reading.scrollable - reading.travelled);
}

/** Highest-precedence detection of a set, by the same ordering the gate uses. */
function worstOf(detections: ChallengeDetection[]): ChallengeDetection {
  return detections.reduce((worst, d) =>
    CHALLENGE_PRECEDENCE.indexOf(d.kind) < CHALLENGE_PRECEDENCE.indexOf(worst.kind) ? d : worst,
  );
}

/**
 * `activity.capture` — open one page of the person-activity family and archive
 * everything it fetches, plus the rendered DOM.
 *
 * **This is Task 26's probe, and it parses nothing.** It exists so that
 * `profile.posts`, `profile.activity` and `post.get` are written against a
 * measured page instead of a remembered one (D152): where the post urn, the
 * author urn, the text, the timestamp and the counts actually live is a
 * question this capability's archive answers and no plan may assert.
 *
 * It reuses `profile.capture`'s machinery rather than forking it — the same
 * scroller measurement, the same human pacing, the same DOM snapshot, the same
 * raw-first archive, the same two challenge gates. What differs is the surface:
 * a different url family, a different relevance predicate (a post body names
 * its author, so "carries person data" is true of everything here), and a
 * receipt that reports the subject-vs-stranger question this page raises and
 * the profile page does not.
 *
 * Every number it reports is a count. No captured urn, name or post text
 * reaches stdout.
 */
export const capability = defineCapability({
  name: "activity.capture",
  risk: "read-cheap",
  summary: "Open one person-activity or post page and archive every response and the rendered DOM, raw.",
  args,
  needsBrowser: true,
  cost: (a) =>
    looksLikePostPermalink(a.url)
      // A permalink is a post, not a person. It costs a page load and opens
      // nobody's profile — counting it as a `profile_open` would spend the
      // day's distinct-person budget on posts (D222).
      ? { page_loads: 1, search_pages: 0, profile_opens: 0 }
      : { page_loads: 1, search_pages: 0, profile_opens: 1 },
  run: async ({ run, args: a, browser, budget }) => {
    const { tab, tap, cursor, archive } = browser;

    // Before anything is opened or spent. A typo costs nothing.
    const target = normalizeActivityUrl(a.url, {
      ...(a.surface === undefined ? {} : { surface: a.surface as never }),
    });
    const warnings: Warning[] = [];
    const opensProfile = target.personRef !== undefined;

    // Both limits are consulted before either is recorded, so a run refused by
    // the daily profile cap has not also burned a page load, and vice versa.
    await budget.check({ kind: "page_load", n: 1 });
    if (opensProfile) await budget.check({ kind: "profile_open", ref: target.personRef! });

    const patterns = [
      ...ACTIVITY_PATTERNS,
      // One watch, or two: a `/posts/` permalink redirects to `/feed/update/`,
      // and the document that answers is at a path the target never named.
      ...activityDocumentPatterns(target),
    ];
    // Registered, and released again in the `finally` below. A capability that
    // delegates to this capture more than once on the same session — `profile.activity`
    // opens the comments tab and then the reactions tab — shares one tap, and a watch
    // name is unique within it (`TAP_DUPLICATE_PATTERN`). Leaving them registered made
    // the second capture fail fatally after the first had already spent its page load.
    const releaseWatches = patterns.map((pattern) => tap.watch(pattern));
    const since = tap.cursor;

    // Spent before the navigation, not after: a crash mid-load must leave the
    // ledger over-counting, never under-counting (§8).
    await budget.spend({ kind: "page_load", n: 1 });
    if (opensProfile) await budget.spend({ kind: "profile_open", ref: target.personRef! });

    // A background tab is timer-clamped and never fires IntersectionObserver,
    // and an activity feed is nothing *but* lazily-rendered cards.
    const foreground = await tab.ensureForeground();
    run.log("render.wait", {
      phase: "capture",
      detail: { via: foreground.via, hidden: foreground.state?.hidden ?? null },
    });
    if (!foreground.ok) {
      warnings.push({
        code: "TAB_NOT_FOREGROUND",
        n: 1,
        field: "the worker tab still reports itself hidden; feed cards may not have loaded",
      });
    }

    const checkpointState = { target, phase: "navigate" as string };
    run.log("nav.start", {
      phase: "capture", item_ref: target.ref, detail: { surface: target.surface },
    });
    const navStarted = Date.now();
    await tab.navigate(target.url);
    run.log("nav.done", {
      phase: "capture", item_ref: target.ref, duration_ms: Date.now() - navStarted,
    });

    let reading: Awaited<ReturnType<typeof readLikeAHuman>> | null = null;
    let snapshot: DomSnapshotResult | null = null;
    try {
      checkpointState.phase = "post-navigation-gate";
      await assertNoChallenge({ tab, run, state: checkpointState });

      checkpointState.phase = "await-first-capture";
      await tap.waitFor(BROAD_PATTERN_NAME, {
        since,
        timeoutMs: a.captureTimeoutMs ?? FIRST_CAPTURE_TIMEOUT_MS,
      });

      checkpointState.phase = "read";
      reading = await readLikeAHuman({
        tab,
        cursor,
        ...(a.scrolls === undefined ? {} : { passes: a.scrolls }),
        ...(a.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: a.layoutTimeoutMs }),
      });
      run.log("render.wait", {
        phase: "capture",
        detail: {
          layout_settled: reading.layout.settled,
          layout_waited_ms: reading.layout.waitedMs,
          layout_polls: reading.layout.polls,
          passes: reading.passes,
          notches: reading.notches,
          scrolled: reading.scrolled,
          paused_ms: reading.pausedMs,
          // Which element actually scrolls, measured rather than assumed. The
          // activity feed may be its own scroll container, and D115 is the
          // standing proof that guessing this wrong captures an empty page.
          scroller: reading.viewport?.scroller ?? null,
          scroller_candidates: reading.viewport?.scrollerCandidates ?? null,
        },
      });

      // Late fetches triggered by the last scroll. Passive: nothing is
      // requested and nothing is spent — only time.
      await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

      checkpointState.phase = "snapshot";
      snapshot = await captureDomSnapshot({
        tab, archive, targetUrl: target.url, timeoutMs: SNAPSHOT_TIMEOUT_MS,
      });
      run.log(snapshot.archived === null ? "capture.miss" : "capture.hit", {
        phase: "capture",
        item_ref: target.ref,
        ...(snapshot.archived === null ? { level: "warn" as const } : {}),
        detail: {
          kind: "dom-snapshot",
          file: snapshot.archived?.file ?? null,
          bytes: snapshot.archived?.bytes ?? 0,
          rendered: snapshot.rendered,
          container: snapshot.probe?.container ?? null,
          failure: snapshot.failure,
        },
      });

      checkpointState.phase = "pre-success-gate";
      await assertNoChallenge({ tab, run, state: checkpointState });
    } finally {
      // Raw-first is not conditional (D2). Every body already on the wire is
      // archived before this function returns, on the throwing paths too.
      await tap.drain();
      // Only after the drain: releasing a watch stops bodies being fetched for it,
      // so dropping them earlier would lose exactly the late responses D2 requires.
      // Captures already taken are unaffected — `unwatch` touches no archive.
      for (const release of releaseWatches) release();
    }

    const captures = tap.captures();
    const summary = summarizeCaptures(captures, tap.misses(), patterns, { isRelevant: isActivityIsh });

    // The status gate, over what the page fetched rather than over the page.
    const detections: ChallengeDetection[] = [];
    for (const capture of captures) {
      const verdict = classifyResponse({ status: capture.status, url: capture.url });
      if (!verdict.clean) detections.push(verdict);
    }
    const halting = detections.filter((d) => d.kind !== "unrecognized");
    if (halting.length > 0) {
      throw await recordChallenge({
        detection: worstOf(halting),
        tab,
        run,
        state: { ...checkpointState, phase: "response-status-gate" },
      });
    }
    if (detections.length > 0) {
      // D111: a status-derived `unrecognized` on one subresource is reported
      // and left to the operator, not treated as a halt.
      warnings.push({
        code: "RESPONSE_STATUS_UNRECOGNIZED",
        n: detections.length,
        field: detections.map((d) => d.detail).join("; "),
      });
    }

    if (reading !== null && !reading.layout.settled) {
      warnings.push({
        code: "PAGE_NOT_LAID_OUT",
        n: 1,
        field:
          `nothing on the page ever measured taller than the viewport within the layout ` +
          `window (${reading.layout.waitedMs}ms, ${reading.layout.polls} polls) — neither the ` +
          `document nor any inner scroller (D115); feed cards will not have fetched`,
      });
    }

    // A feed that was not read to the bottom has captured a prefix of itself,
    // and the count of posts on the receipt would describe the scroll rather
    // than the person. Visible, because a short capture and a short feed must
    // not produce the same receipt.
    //
    // Compared on `travelled` — where the scroller ended up — and never on
    // `scrolled`, which is distance dispatched and counts a back-pass as
    // progress. `readLikeAHuman` takes a pass back up a quarter of the time, so
    // 600 down + 300 up + 300 down is 1200px of `scrolled` at position 600, and
    // this warning would fall silent on a 900px page at exactly the moment the
    // capture was short. `scrollable` is the *last* measurement, not the first:
    // a lazy feed grows as it renders (D228).
    const scrollable = reading?.scrollable ?? null;
    const remaining = feedShortfall(reading);
    if (reading !== null && scrollable !== null && remaining > 0) {
      warnings.push({
        code: "FEED_NOT_EXHAUSTED",
        n: remaining,
        field:
          `the scroller still had ${remaining}px below the last pass (${reading.passes} ` +
          `passes, ended at ${reading.travelled}px of ${scrollable}px) — this capture is a ` +
          `prefix of the feed, not all of it`,
      });
    }

    // The DOM snapshot's three distinct outcomes, each with its own code
    // because each sends the operator somewhere different.
    if (snapshot === null || snapshot.failure === "probe-failed") {
      warnings.push({
        code: "DOM_SNAPSHOT_FAILED",
        n: 1,
        field:
          `the rendered-DOM snapshot could not be read from the page, so this probe has no ` +
          `content fixture: ${snapshot?.detail ?? "the read was never reached"}`,
      });
    } else if (snapshot.failure === "archive-failed") {
      warnings.push({
        code: "DOM_SNAPSHOT_NOT_ARCHIVED",
        n: 1,
        field:
          `the snapshot was read from the page but could not be written to the raw archive, ` +
          `so nothing may parse it (D2): ${snapshot.detail ?? "unknown"}`,
      });
    } else if (!snapshot.rendered) {
      const c = snapshot.probe?.container;
      warnings.push({
        code: "ACTIVITY_CONTAINER_NOT_RENDERED",
        n: 1,
        field:
          `the snapshot is archived but the page's main container did not render ` +
          `(selector ${c?.selector === null || c === undefined ? "not found" : c.selector}, ` +
          `${c?.textChars ?? 0} chars of text, ${c?.sections ?? 0} sections) — ` +
          `this is not a fixture anyone may write a parser against`,
      });
    }

    // Identity. `sessionUrnsOf` is the one implementation of "who is the
    // operator" (D133) — never re-derived here, only counted against.
    const sessionUrns = sessionUrnsOf(captures);
    if (sessionUrns.length === 0) {
      // Without it the subject-vs-stranger check cannot be made at all, and a
      // probe that cannot make it must say so rather than report a clean sweep
      // (D131, one surface on).
      warnings.push({
        code: "SESSION_IDENTITY_UNAVAILABLE",
        n: 1,
        field:
          "no /voyager/api/me body was captured, so no urn on this page could be checked " +
          "against the operator's own identity — the D119 trap is unmeasured on this run",
      });
    }

    // Bounded on purpose: a page can archive dozens of megabyte bodies, and a
    // urn sweep over every one of them is the kind of unbounded work review has
    // already caught here once. What was skipped is reported, not dropped.
    const relevant = captures.filter((c) => isActivityIsh(c.body));
    const inventoried = relevant.slice(0, MAX_INVENTORIED_BODIES);
    // Inventoried across the run, not per body and summed: one author appearing
    // in ten feed bodies is one person, and this count is read as "how many
    // distinct people were on this page". Summing counted them ten times.
    const acrossRun = urnInventory(inventoried.map((c) => c.body).join("\n"));
    const bodySessionHits = inventoried.reduce(
      (n, c) => n + sessionUrnHits(c.body, sessionUrns),
      0,
    );

    // The DOM half of the same sweep: what the rendered page carries, how it
    // binds a time to a post, and whether the operator is the only person on it.
    const domMap = snapshot?.probe?.html === undefined
      ? null
      : buildActivityDomMap(snapshot.probe.html, { sessionUrns });
    const domAbsoluteTimes = domMap === null ? 0 : absoluteTimeLeaves(domMap);

    if (domMap !== null && domMap.timeLeaves.length > 0 && domAbsoluteTimes === 0) {
      // The `posted_at` question, raised by the run that can answer half of it.
      // §7 wants an absolute time; if neither the DOM nor a captured body
      // carries one, that is an operator decision and not a conversion any of
      // Tasks 27–29 may invent on its own.
      warnings.push({
        code: "POSTED_AT_RELATIVE_ONLY",
        n: domMap.timeLeaves.length,
        field:
          `every time rendered on this page is relative ("3d"); no absolute timestamp is in ` +
          `the DOM. Check the promoted field map's posted_at_epoch / posted_at_iso probes ` +
          `before deciding how person_posts.posted_at is populated`,
      });
    }

    if (summary.profile_ish === 0) {
      // Not a failure: the archive is the product, and this run produced one.
      // But an ok receipt must never read as "we got the posts".
      warnings.push({
        code: "NO_ACTIVITY_PAYLOAD",
        n: 1,
        field: `${summary.captured} linkedin api responses archived, none carrying post, comment or reaction data`,
      });
    }
    if (summary.unmatched_profile_ish > 0) {
      warnings.push({
        code: "PATTERN_MISMATCH",
        n: summary.unmatched_profile_ish,
        field: "activity payloads arrived on endpoints no specific pattern matched — see data.capture.endpoints",
      });
    }
    if (summary.misses > 0) {
      warnings.push({
        code: "CAPTURE_MISSES",
        n: summary.misses,
        field: "watched responses seen but not delivered — see capture.miss events",
      });
    }
    if (summary.captured === 0) {
      throw transient(
        "ACTIVITY_NO_CAPTURE",
        "the activity page loaded but no LinkedIn api response was archived",
        `run=${run.runId}`,
      );
    }

    const shown = summary.endpoints
      .filter((r) => r.profile_ish || r.unpredicted)
      .slice(0, RECEIPT_ENDPOINT_CAP);

    return {
      counts: {
        requested: 1,
        captured: summary.captured,
        usable: summary.profile_ish,
        skipped: summary.misses,
      },
      warnings,
      data: {
        target: { surface: target.surface, url: target.url, ref: target.ref },
        foreground: { ok: foreground.ok, via: foreground.via },
        reading: reading
          ? {
              passes: reading.passes,
              notches: reading.notches,
              scrolled_px: reading.scrolled,
              travelled_px: reading.travelled,
              scrollable_px: scrollable,
              paused_ms: reading.pausedMs,
              viewport: reading.viewport,
              layout: reading.layout,
            }
          : null,
        snapshot: {
          archived: snapshot?.archived?.file ?? null,
          bytes: snapshot?.archived?.bytes ?? 0,
          rendered: snapshot?.rendered ?? false,
          failure: snapshot?.failure ?? null,
          container: snapshot?.probe?.container ?? null,
          html_chars: snapshot?.probe?.htmlChars ?? 0,
          page_text_chars: snapshot?.probe?.textChars ?? 0,
        },
        // The whole measurement, as counts. Nothing here is a urn, a name or a
        // line of post text — those live in the archive, which is the product.
        probe: {
          session_urns_known: sessionUrns.length,
          bodies_inventoried: inventoried.length,
          bodies_not_inventoried: relevant.length - inventoried.length,
          body_urns_distinct: acrossRun.distinct,
          body_urns_total: acrossRun.total,
          // Which families hit `MAX_URNS_PER_FAMILY`. Dropped, this
          // under-reports silently at exactly the scale that matters — the same
          // failure `bodies_not_inventoried` exists to prevent, one layer down.
          body_urns_truncated: acrossRun.truncated,
          body_session_urn_hits: bodySessionHits,
          dom: domMap === null ? null : {
            card_ref_scope_resolved: domMap.scope.profileId !== null,
            card_ref_cards: domMap.scope.cards.length,
            urn_attributes: domMap.urnAttributes.map((h) => ({
              attribute: h.attribute,
              family: h.family,
              elements: h.count,
              session_owned: h.sessionHits,
            })),
            time_leaves: domMap.timeLeaves.length,
            time_leaves_absolute: domAbsoluteTimes,
            time_leaves_bound_to_a_urn: domMap.timeLeaves.filter((l) => l.boundTo !== null).length,
            urn_families: domMap.families,
            session_urns_present: domMap.sessionUrnsPresent,
            truncated: domMap.truncated,
          },
        },
        capture: {
          patterns: summary.patterns,
          captured: summary.captured,
          activity_ish: summary.profile_ish,
          unmatched_activity_ish: summary.unmatched_profile_ish,
          misses: summary.misses,
          endpoints: shown,
          endpoints_omitted: summary.endpoints.length - shown.length,
        },
        tap: tap.stats(),
        artifacts: run.artifacts(),
      },
      next:
        `npm run fixtures:promote -- --run=${run.runId} --capability=profile.posts --surface=activity` +
        `   # then read fixtures/profile.posts/FIELD-MAP.md`,
    };
  },
});

export type ActivityEndpointRow = EndpointRow;

export default capability;
