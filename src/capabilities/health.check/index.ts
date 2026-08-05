import { z } from "zod";
import { defineCapability } from "../../cli/types.js";

/**
 * A page that is not LinkedIn and makes no request at all. The worker tab is
 * born here (D10); navigating to it explicitly is what exercises `Page.navigate`
 * and the readyState poll without spending anything.
 */
export const NEUTRAL_PAGE = "about:blank";

/**
 * `health.check` — the whole L0 stack, exercised end to end, touching no LinkedIn
 * page and spending no budget.
 *
 * It is the M1 gate: launch or reuse Chrome, connect CDP, read the session cookie,
 * take the tab lease, open a background worker tab, navigate it, assert foreground,
 * log events, write a receipt, tear everything down. If this returns ok, every
 * piece of L0 composes.
 */
export const capability = defineCapability({
  name: "health.check",
  risk: "local",
  summary: "Exercise the L0 stack — Chrome, CDP, login cookie, lease, worker tab — without touching LinkedIn.",
  args: z.object({}).strict(),
  needsBrowser: true,
  // A logged-out profile is a fact this capability exists to *report*. Halting
  // with exit 4 would mean the one command that diagnoses a broken session
  // refuses to run precisely when the session is broken.
  needsAuth: false,
  cost: () => ({ page_loads: 0, search_pages: 0, profile_opens: 0 }),
  run: async ({ run, browser, login, budget, flags }) => {
    const { session, tab, tap, lease } = browser;

    run.log("nav.start", { phase: "health", detail: { url: NEUTRAL_PAGE } });
    const navStarted = Date.now();
    await tab.navigate(NEUTRAL_PAGE);
    run.log("nav.done", {
      phase: "health",
      duration_ms: Date.now() - navStarted,
      detail: { url: NEUTRAL_PAGE },
    });

    const foreground = await tab.ensureForeground();
    run.log("render.wait", {
      phase: "health",
      detail: { via: foreground.via, hidden: foreground.state?.hidden ?? null },
    });

    const version = await session.client.send<{ product?: string; protocolVersion?: string }>(
      "Browser.getVersion",
    );
    run.log("cdp.send", { phase: "health", detail: { method: "Browser.getVersion" } });

    const url = await tab.currentUrl();

    return {
      counts: { requested: 1, captured: 1, usable: foreground.ok ? 1 : 0, skipped: 0 },
      warnings: foreground.ok
        ? []
        : [{ code: "TAB_NOT_FOREGROUND", n: 1, field: "the worker tab still reports itself hidden" }],
      data: {
        chrome: {
          port: session.endpoint.port,
          // The evidence the M1 gate turns on: `true` on a cold start, `false`
          // when an already-running Chrome was reused.
          launched: session.endpoint.launched,
          product: version.product ?? null,
          protocol: version.protocolVersion ?? null,
        },
        tab: { target_id: tab.targetId, session_id: tab.sessionId, url },
        foreground: { ok: foreground.ok, via: foreground.via, hidden: foreground.state?.hidden ?? null },
        tap: { running: tap.running, watching: tap.watching },
        login,
        lease: {
          run_id: lease.run_id,
          pid: lease.pid,
          host: lease.host,
          capability: lease.capability,
          acquired_at: lease.acquired_at,
        },
        budget: { ledger: budget.path, usage: await budget.usage() },
        flags: { no_store: flags.noStore, force_release: flags.forceRelease },
        artifacts: run.artifacts(),
      },
      next: `cat ${run.artifacts().events}`,
    };
  },
});

export default capability;
