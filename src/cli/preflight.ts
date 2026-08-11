import { CapabilityError, EXIT } from "../core/run/receipt.js";
import type { Warning } from "../core/run/receipt.js";
import type { EventFields, EventName } from "../core/run/events.js";
import type { LeaseRecord, LeaseState } from "../core/lease/tab-lease.js";
import type { CostEstimate, LoginState, SessionLike, TabLike, UniversalFlags } from "./types.js";
import type { RunBudget } from "./budget.js";

/** LinkedIn's session cookie. Its presence is the only login signal available
 *  without issuing a request LinkedIn's UI did not issue (D1). */
export const LINKEDIN_SESSION_COOKIE = "li_at";

/** What preflight needs of the browser-level CDP client. */
export type CookieReader = {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T>;
};

type RawCookie = { name: string; domain: string; expires?: number; session?: boolean };

function authFailure(state: LoginState): CapabilityError {
  return new CapabilityError({
    code: "SESSION_NOT_LOGGED_IN",
    exit: EXIT.AUTH,
    action: "REAUTH",
    retryable: false,
    message:
      `the automation profile has no valid LinkedIn session cookie (${state.cookie}); ` +
      `log in by hand on the ~/.linkedin-os/chrome-profile Chrome, then retry`,
    evidence: JSON.stringify(state),
  });
}

/**
 * Reads the automation profile's LinkedIn session cookie over CDP.
 *
 * `Storage.getCookies` is a browser-level command that needs no domain enabled,
 * so this stays inside D8's attach surface, and it issues **zero** LinkedIn
 * requests — nothing here forges anything (D1). Verified on Chrome 151:
 * `Network.getAllCookies` does not exist at browser level, `Storage.getCookies`
 * does.
 *
 * Only the cookie's presence and expiry ever leave this function. Cookie values
 * are the account itself; a receipt is not where they belong, and the call
 * returns every cookie in the profile, not only LinkedIn's.
 */
export async function checkLogin(client: CookieReader): Promise<LoginState> {
  let cookies: RawCookie[];
  try {
    const r = await client.send<{ cookies: RawCookie[] }>("Storage.getCookies");
    cookies = r?.cookies ?? [];
  } catch (cause) {
    // Not "logged out": a probe that did not answer proves nothing, and exit 4
    // does not merely halt — it instructs the operator to log in again, which is
    // itself an event LinkedIn watches (D63). A CDP hiccup is retryable.
    if (cause instanceof CapabilityError) throw cause;
    throw new CapabilityError({
      code: "LOGIN_PROBE_FAILED",
      exit: EXIT.TRANSIENT,
      action: "RETRY_BACKOFF",
      retryable: true,
      message: `could not read the profile's cookies to determine login state: ${String(cause)}`,
    });
  }

  const li = cookies.find(
    (c) => c.name === LINKEDIN_SESSION_COOKIE && c.domain.includes("linkedin.com"),
  );
  if (!li) return { logged_in: false, cookie: "missing" };

  const expiresMs = typeof li.expires === "number" && li.expires > 0 ? li.expires * 1000 : null;
  if (expiresMs !== null && expiresMs <= Date.now()) {
    return { logged_in: false, cookie: "expired", expires_at: new Date(expiresMs).toISOString() };
  }
  return {
    logged_in: true,
    cookie: "present",
    ...(expiresMs === null ? {} : { expires_at: new Date(expiresMs).toISOString() }),
  };
}

export type EventSink = { log(event: EventName, fields?: EventFields): unknown };

/** Everything preflight reaches the outside world through, injected so the whole
 *  sequence is exercisable offline. Production passes the real modules once, in
 *  `run.ts`. */
export type PreflightDeps = {
  openSession(): Promise<SessionLike>;
  acquireLease(o: { runId: string; capability: string; path?: string }): Promise<LeaseRecord>;
  releaseLease(o: { runId: string; path?: string }): Promise<boolean>;
  inspectLease(path?: string): Promise<LeaseState>;
  forceReleaseLease(path?: string): Promise<{
    released: boolean;
    state: LeaseState;
    priorHolder: LeaseRecord | null;
  }>;
};

export type PreflightInput = {
  runId: string;
  capability: string;
  needsBrowser: boolean;
  needsAuth: boolean;
  estimate: CostEstimate;
  flags: UniversalFlags;
  budget: RunBudget;
  events?: EventSink;
  leasePath?: string;
  /** A target recorded by this exact run before a hard kill. */
  workerTargetId?: string;
  deps: PreflightDeps;
  /**
   * Handed a teardown thunk as soon as this preflight holds anything at all.
   * The thunk reads the live `Prepared`, so it releases whatever has been
   * acquired by the time it is called — which is what makes it correct in the
   * window between taking the lease and opening the tab.
   */
  onCleanup?: (fn: () => Promise<void>) => void;
};

/** What preflight leaves behind for the runner to hand to the capability and,
 *  whatever happens next, to tear down. */
export type Prepared = {
  session: SessionLike | null;
  tab: TabLike | null;
  lease: LeaseRecord | null;
  login: LoginState;
  warnings: Warning[];
};

/**
 * Spec §8's preflight, in its order: Chrome up → CDP reachable → logged in →
 * budget available → tab lease → worker tab.
 *
 * The order is the contract. Each step fails with its own exit class and stops,
 * rather than half-running: a budget-exhausted invocation must not have opened a
 * tab, and a logged-out profile must not have spent a page load finding out.
 *
 * Whatever it managed to acquire before failing is attached to the thrown error
 * as `partial` — see `teardown`, which the runner calls on every path including
 * this one.
 */
export async function preflight(input: PreflightInput): Promise<Prepared> {
  const prepared: Prepared = {
    session: null,
    tab: null,
    lease: null,
    login: { logged_in: false, cookie: "unknown" },
    warnings: [],
  };

  input.onCleanup?.(async () => {
    await teardown(prepared, input);
  });

  try {
    // 1 + 2. Chrome on the dedicated profile and port, and a CDP socket that
    // answers. `BrowserSession.open` is both, and classifies both (D13, D15).
    if (input.needsBrowser) {
      prepared.session = await input.deps.openSession();

      // 3. Logged in. Cookie-only: a navigation to linkedin.com would cost a page
      // load off a metered account just to learn whether we may spend page loads.
      prepared.login = await checkLogin(prepared.session.client);
      input.events?.log("cdp.send", {
        detail: { step: "login-probe", cookie: prepared.login.cookie, logged_in: prepared.login.logged_in },
      });
      if (input.needsAuth && !prepared.login.logged_in) throw authFailure(prepared.login);
    }

    // 4. Budget available for the estimate. `profile_open` is deliberately not
    // checked here: it is deduped by profile ref (§8), and this layer has no refs
    // to offer, so a preflight check would either need a fake ref — which counts a
    // profile nobody opened — or would have to guess. It is enforced at the spend,
    // where the ref exists, by the same evaluation (D71).
    if (input.estimate.page_loads > 0) {
      await input.budget.check({ kind: "page_load", n: input.estimate.page_loads });
    }
    if (input.estimate.search_pages > 0) {
      await input.budget.check({ kind: "search_page", n: input.estimate.search_pages });
    }

    // 5. The tab lease. Last, because everything above can fail without ever
    // touching the tab, and a lease held during a failing preflight is a lease
    // another run is being refused for no reason.
    if (input.needsBrowser) {
      if (input.flags.forceRelease) {
        const forced = await input.deps.forceReleaseLease(input.leasePath);
        if (forced.released) {
          prepared.warnings.push({
            code: "TAB_LEASE_FORCE_RELEASED",
            n: 1,
            field: forced.priorHolder
              ? `run ${forced.priorHolder.run_id} (pid ${forced.priorHolder.pid}, ${forced.priorHolder.capability}, ${forced.priorHolder.host})`
              : `an unreadable lease file (${forced.state.state})`,
          });
        }
      }
      prepared.lease = await input.deps.acquireLease({
        runId: input.runId,
        capability: input.capability,
        ...(input.leasePath === undefined ? {} : { path: input.leasePath }),
      });

      // 6. The worker tab, created in the background on a blank page (D10) —
      // after the lease, so two runs never both own one.
      prepared.tab = await prepared.session!.openWorkerTab(undefined, input.workerTargetId);
    }
    return prepared;
  } catch (e) {
    // Anything already acquired is released here rather than left to the caller's
    // good intentions: preflight is the one place that knows how far it got.
    await teardown(prepared, input);
    throw e;
  }
}

/**
 * Releases everything preflight acquired, in the reverse order it acquired it,
 * and never throws — teardown running after a failure must not replace the reason
 * the run ended.
 *
 * The lease goes last, after the tab is actually closed. Releasing it first would
 * let the next run claim the tab while this one is still closing it, which is the
 * two-drivers-on-one-tab state §8 exists to prevent.
 */
export async function teardown(
  prepared: Prepared,
  input: Pick<PreflightInput, "runId" | "leasePath" | "deps">,
): Promise<Warning[]> {
  const problems: Warning[] = [];

  if (prepared.session) {
    try {
      await prepared.session.close();
    } catch (cause) {
      problems.push({ code: "TEARDOWN_SESSION_FAILED", n: 1, field: String(cause) });
    }
    prepared.session = null;
    prepared.tab = null;
  }

  if (prepared.lease) {
    try {
      await input.deps.releaseLease({
        runId: input.runId,
        ...(input.leasePath === undefined ? {} : { path: input.leasePath }),
      });
    } catch (cause) {
      problems.push({ code: "TEARDOWN_LEASE_FAILED", n: 1, field: String(cause) });
    }
    prepared.lease = null;
  }

  return problems;
}
