import { join } from "node:path";
import { z } from "zod";
import { defineCapability, type CapabilityContext } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { receiptPath } from "../../core/run/paths.js";
import { buildFeedDomMap } from "../../core/fixtures/feed-dommap.js";
import { absoluteTimeLeaves } from "../../core/fixtures/activitymap.js";
import { RECEIPT_ENDPOINT_CAP } from "../profile.capture/index.js";
import { captureFeed, unreadBelow, type FeedCaptureResult } from "./capture.js";
import { FEED_DOCUMENT_NAME } from "./patterns.js";
import { parseFeed } from "./parse.js";
import { DEFAULT_FEED_LIMIT, MAX_FEED_PASSES, passesFor } from "./constants.js";

const args = z
  .object({
    /** How many feed items to read. Bounds the scroll work as well as the
     *  output: a feed does not end, so an unbounded read would be a read to the
     *  ceiling every time (D325). */
    limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_FEED_LIMIT),
    /** An explicit pass count. A count from the operator is an instruction, not
     *  a hint (D320) — but it is still capped, because this page has no bottom. */
    scrolls: z.coerce.number().int().min(0).max(MAX_FEED_PASSES).optional(),
    captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
    layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
  })
  .strict();

function noSnapshot(): CapabilityError {
  return new CapabilityError({
    code: "FEED_GET_NO_SNAPSHOT",
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message: "the feed page loaded but no DOM snapshot was archived, so nothing may be parsed",
  });
}

function noContainer(path: string): CapabilityError {
  return new CapabilityError({
    code: "FEED_GET_CONTAINER_MISSING",
    exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: 'the archived snapshot carries no [data-testid="mainFeed"] container',
    evidence: path,
  });
}

/**
 * `feed.get` — read the operator's own `/feed/`.
 *
 * One page load, one bounded read, one DOM snapshot, parsed offline from the
 * archived bytes. It is both the Task 32 probe and the capability, because the
 * feed is the operator's own data and §7 defines no feed table: the run reports
 * its measurement on the same receipt as its rows.
 *
 * **What the measurement found (D280).** Run `01KZMZ5BQD2MKSN8EV7WRG38P0`,
 * 2026-08-10: 26 responses archived, zero hits on all six watched feed
 * endpoints, and a 5.2MB `/feed/` document with no Big Pipe island in it. No
 * captured body on this surface carries a feed item's fields, so the DOM
 * exception D325 granted ahead of the measurement is in use rather than
 * preferred. The probe fields stay on every receipt so that stops being true
 * loudly if LinkedIn ever starts answering with JSON.
 *
 * **Storage is archive-only** until a migration is approved (D283). The receipt
 * carries per-item rows without post text; the text is in the archive.
 */
type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;

/**
 * The one thing this capability composes that a test cannot drive offline: the
 * live capture. Injected so the composition around it — the snapshot refusal,
 * the container refusal, the receipt's counts — is provable with zero LinkedIn
 * requests, exactly as `post.get`'s is.
 */
export type FeedGetDeps = {
  capture(ctx: Context, o: { passes: number }): Promise<FeedCaptureResult>;
};

const defaultDeps: FeedGetDeps = { capture: (ctx, o) => captureFeed(ctx, o) };

export function createFeedGetCapability(deps: FeedGetDeps = defaultDeps) {
  return defineCapability({
  name: "feed.get",
  risk: "read-cheap",
  summary: "Read the operator's own feed from one bounded page read; items are archived, never stored.",
  args,
  needsBrowser: true,
  // One page load, and nothing else. A feed reader records zero search pages
  // and opens nobody's profile — the items are other people's content, but no
  // profile is visited to obtain them.
  cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
  run: async (ctx) => {
    const passes = ctx.args.scrolls ?? passesFor(ctx.args.limit);
    const captured = await deps.capture(ctx, { passes });
    const { snapshot, reading, summary } = captured;

    if (snapshot?.archived == null || snapshot.probe?.html === undefined) throw noSnapshot();
    const snapshotPath = receiptPath(join(ctx.run.paths.raw, snapshot.archived.file));

    // Parsed offline, from the archived bytes — never from a live DOM read.
    const html = await ctx.browser.archive.readText(snapshot.archived.file);
    const parsed = parseFeed(html, {
      limit: ctx.args.limit,
      sessionVanities: captured.sessionVanities,
    });
    if (!parsed.ok) throw noContainer(snapshotPath);

    // The probe half, on the same receipt. A measurement that only ran once is
    // a measurement nobody notices going stale.
    const domMap = buildFeedDomMap(snapshot.probe.html, {
      sessionUrns: captured.sessionUrns,
      sessionVanities: captured.sessionVanities,
    });

    const scrollable = reading?.scrollable ?? null;
    ctx.run.log("parse.ok", {
      phase: "feed.get",
      detail: {
        items: parsed.items.length,
        cards: parsed.container.cards,
        unresolved_authors: parsed.unresolved,
        with_urn: parsed.items.filter((i) => i.value.urn !== null).length,
      },
    });

    return {
      counts: {
        requested: ctx.args.limit,
        captured: parsed.container.cards,
        usable: parsed.items.length,
        skipped: parsed.unresolved,
      },
      warnings: [
        ...captured.warnings,
        ...parsed.warnings.map((w) => ({ code: w.code, n: w.n, field: w.field })),
      ],
      data: {
        // Every field below came from the rendered DOM, and says so.
        source: "dom-snapshot",
        target: { url: "https://www.linkedin.com/feed/", limit: ctx.args.limit, passes },
        read: {
          items: parsed.items.length,
          cards_rendered: parsed.container.cards,
          container_children: parsed.container.children,
          unresolved_authors: parsed.unresolved,
          with_urn: parsed.items.filter((i) => i.value.urn !== null).length,
          operator_items: parsed.items.filter((i) => i.value.is_operator).length,
          // Stated plainly so a caller cannot read silence as completeness. A
          // feed does not end; every read of one is a prefix (D325).
          partial: parsed.partial,
          unread_below_px: unreadBelow(reading),
        },
        // Per item, without the post body. The text stays in the archive: ten
        // post bodies on stdout is a large result, which receipts do not carry.
        items: parsed.items.map((i) => i.value),
        storage: { mode: "archive-only" },
        snapshot: snapshotPath,
        // The condition D325 attached to the grant, re-measured on every run.
        probe: {
          feed_ish_bodies: summary.profile_ish,
          // The feed *API* patterns only. The document watch is `specific` too
          // and always hits — counting it here would report "1" on a run where
          // no feed endpoint answered, which is the exact claim D280 makes.
          feed_api_pattern_hits: summary.patterns
            .filter((p) => p.tier === "specific" && p.name !== FEED_DOCUMENT_NAME)
            .reduce((n, p) => n + p.hits, 0),
          session_urns_known: captured.sessionUrns.length,
          session_vanities_known: captured.sessionVanities.length,
          bodies_inventoried: captured.bodySweep.inventoried,
          bodies_not_inventoried: captured.bodySweep.notInventoried,
          body_urns_distinct: captured.bodySweep.inventory.distinct,
          dom: {
            container_found: domMap.container.found,
            cards: domMap.items.filter((i) => i.hasTextBox).length,
            cards_author_labelled: domMap.items.filter((i) => i.authorLabelled).length,
            cards_author_linked: domMap.items.filter((i) => i.authorLinked).length,
            cards_urn_resolved: domMap.items.filter((i) => i.urnResolved).length,
            cards_multi_person_link: domMap.items.filter((i) => i.personLinks > 1).length,
            urn_attribute_candidates: domMap.urnCandidates.length,
            time_leaves: domMap.base.timeLeaves.length,
            time_leaves_absolute: absoluteTimeLeaves(domMap.base),
          },
        },
        reading: reading === null ? null : {
          passes: reading.passes,
          notches: reading.notches,
          scrolled_px: reading.scrolled,
          travelled_px: reading.travelled,
          scrollable_px: scrollable,
          paused_ms: reading.pausedMs,
          viewport: reading.viewport,
          layout: reading.layout,
        },
        capture: {
          patterns: summary.patterns,
          captured: summary.captured,
          feed_ish: summary.profile_ish,
          unmatched_feed_ish: summary.unmatched_profile_ish,
          misses: summary.misses,
          endpoints: summary.endpoints
            .filter((r) => r.profile_ish || r.unpredicted)
            .slice(0, RECEIPT_ENDPOINT_CAP),
        },
        tap: ctx.browser.tap.stats(),
        artifacts: ctx.run.artifacts(),
      },
      next:
        `npm run fixtures:promote -- --run=${ctx.run.runId} --capability=feed.get` +
        `   # then read fixtures/feed.get/FIELD-MAP.md`,
    };
  },
  });
}

export const capability = createFeedGetCapability();

export default capability;
