import {
  compareQueryEcho,
  parseSearchSessionId,
  type QueryEcho,
} from "../../core/salesnav-query/echo.js";
import type { Warning } from "../../core/run/receipt.js";

export {
  parseSearchPaging as parseApplyPaging,
  queryDigest,
  bodyDigest,
  requestQuery,
  QueryEchoError,
} from "../../core/salesnav-query/echo.js";
export type { SearchPaging, FilterEchoVerdict, RecentSearchEchoVerdict } from "../../core/salesnav-query/echo.js";

/** The session LinkedIn minted for this execution, from the named response body
 *  only — never the request URL (page 1 carries no `trackingParam`) and never
 *  the address bar (D413). */
export const parseApplySessionId = parseSearchSessionId;

export type ApplyVerdict = QueryEcho & {
  /** Every built filter honored and no filter type injected — nothing that
   *  changes *who* was searched. This is the flag the convergence loop reads:
   *  it is the only shape that means "LinkedIn searched the audience I
   *  described" (D456). */
  audience_clean: boolean;
  /** `audience_clean` **and** the request envelope unchanged. Strictly stronger,
   *  and measured to be false on an ordinary healthy load: LinkedIn injects
   *  `recentSearchParam:(doLogHistory:true)` into a query built without one
   *  (D457), which is a logging flag and not an audience change. */
  clean: boolean;
  /** The captured query is byte-identical to the built one. `exact` implies
   *  `clean`; `clean` does not imply `exact`, because a query can be re-spelled
   *  without any filter subtree changing. */
  exact: boolean;
  honored: number;
  rewritten: number;
  dropped: number;
  injected: number;
};

/**
 * The whole verdict, computed from the builder's query and the raw `query`
 * parameter of the named captured request — never from the landed URL and never
 * from the rendered page (D433).
 *
 * Pure. Filter values stay inside; only type names, counts and verdicts leave.
 */
export function applyVerdict(built: string, captured: string): ApplyVerdict {
  const echo = compareQueryEcho(built, captured);
  const counted = (verdict: string) => echo.filters.filter((filter) => filter.verdict === verdict).length;
  const rewritten = counted("rewritten");
  const dropped = counted("dropped");
  const injected = echo.injected_filter_types.length;
  const recentChanged = echo.recent_search !== "honored" && echo.recent_search !== "absent";
  const audienceClean = rewritten === 0 && dropped === 0 && injected === 0;
  return {
    ...echo,
    honored: counted("honored"),
    rewritten,
    dropped,
    injected,
    audience_clean: audienceClean,
    clean: audienceClean && !recentChanged,
    exact: built === captured,
  };
}

/**
 * A rewritten, dropped or injected filter is a loud non-zero warning, never a
 * silently smaller audience (M6 CONTEXT rule 3). One warning per class, so a
 * spec with six drops does not bury the receipt.
 */
export function verdictWarnings(verdict: ApplyVerdict): Warning[] {
  const warnings: Warning[] = [];
  const named = (wanted: string) => verdict.filters.filter((filter) => filter.verdict === wanted).map((filter) => filter.type);
  const rewritten = named("rewritten");
  const dropped = named("dropped");
  if (rewritten.length > 0) warnings.push({ code: "FILTER_REWRITTEN", field: rewritten.join(", "), n: rewritten.length });
  if (dropped.length > 0) warnings.push({ code: "FILTER_DROPPED", field: dropped.join(", "), n: dropped.length });
  if (verdict.injected_filter_types.length > 0) {
    warnings.push({
      code: "FILTER_INJECTED",
      field: verdict.injected_filter_types.join(", "),
      n: verdict.injected_filter_types.length,
    });
  }
  if (verdict.recent_search !== "honored" && verdict.recent_search !== "absent") {
    warnings.push({ code: "RECENT_SEARCH_ECHO_CHANGED", field: verdict.recent_search, n: 1 });
  }
  return warnings;
}
