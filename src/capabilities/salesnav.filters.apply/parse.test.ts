import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestQuery } from "../../core/salesnav-query/echo.js";
import { applyVerdict, parseApplySessionId, verdictWarnings } from "./parse.js";

/**
 * The one measured echo on disk: Task 42's approved CXO load. Every claim about
 * what LinkedIn actually did comes from this pair and nothing else (D453).
 */
const MEASURED_DIR = join(
  "src/core/salesnav-query/test-fixtures/archive/01KZSZF6MXC6HHP9Z4RQBHXP19/raw",
);
const MEASURED_ID = "0016-5e81b94c63cd41b8";

function measuredMeta(): { url: string; status: number } {
  return JSON.parse(readFileSync(join(MEASURED_DIR, `${MEASURED_ID}.meta.json`), "utf8"));
}

function measuredBody(): string {
  return gunzipSync(readFileSync(join(MEASURED_DIR, `${MEASURED_ID}.json.gz`))).toString("utf8");
}

/**
 * Synthetic pairs. These test **our comparator**, not LinkedIn: no archive
 * claims a rewrite, a drop or an injection ever happened on the wire (D431,
 * D435, D453). They are never promoted to a fixture and never cited as evidence
 * of LinkedIn behavior.
 */
const SYNTHETIC_BUILT =
  "(filters:List((type:REGION,values:List((id:103644278,text:United%20States,selectionType:INCLUDED))),(type:INDUSTRY,values:List((id:4,text:Software%20Development,selectionType:INCLUDED)))))";

describe("apply verdict — the one measured echo", () => {
  it("reports the archived CXO load as an exact, clean honor", () => {
    const captured = requestQuery(measuredMeta().url);
    const verdict = applyVerdict(captured, captured);
    expect(verdict).toMatchObject({
      exact: true,
      clean: true,
      honored: 1,
      rewritten: 0,
      dropped: 0,
      injected: 0,
      recent_search: "honored",
    });
    expect(verdict.filters).toEqual([{ type: "PERSONA", verdict: "honored" }]);
    expect(verdictWarnings(verdict)).toEqual([]);
  });

  it("reads the executed session id from the measured body's tracking block", () => {
    expect(parseApplySessionId(measuredBody())).toBe("SCRUBBED_SESSION");
  });

  it("answers null rather than inventing a session id when the field is absent", () => {
    expect(parseApplySessionId('{"paging":{"total":1,"count":1,"start":0}}')).toBeNull();
    expect(parseApplySessionId('{"metadata":{"tracking":{"sessionId":""}}}')).toBeNull();
  });
});

describe("apply verdict — comparator behavior on synthetic pairs", () => {
  it("classifies a filter whose subtree differs as rewritten, and warns", () => {
    const captured = SYNTHETIC_BUILT.replace("id:4,text:Software%20Development", "id:96,text:Information%20Technology");
    const verdict = applyVerdict(SYNTHETIC_BUILT, captured);
    expect(verdict.filters).toEqual([
      { type: "REGION", verdict: "honored" },
      { type: "INDUSTRY", verdict: "rewritten" },
    ]);
    expect(verdict).toMatchObject({ exact: false, clean: false, honored: 1, rewritten: 1, dropped: 0 });
    expect(verdictWarnings(verdict)).toContainEqual({ code: "FILTER_REWRITTEN", field: "INDUSTRY", n: 1 });
  });

  it("classifies an absent built type as dropped, and warns", () => {
    const captured = "(filters:List((type:REGION,values:List((id:103644278,text:United%20States,selectionType:INCLUDED)))))";
    const verdict = applyVerdict(SYNTHETIC_BUILT, captured);
    expect(verdict.filters).toEqual([
      { type: "REGION", verdict: "honored" },
      { type: "INDUSTRY", verdict: "dropped" },
    ]);
    expect(verdict).toMatchObject({ clean: false, dropped: 1 });
    expect(verdictWarnings(verdict)).toContainEqual({ code: "FILTER_DROPPED", field: "INDUSTRY", n: 1 });
  });

  it("reports a captured type that was never built as injected, and warns", () => {
    const injected = "(type:SENIORITY_LEVEL,values:List((id:6,text:CXO,selectionType:INCLUDED)))";
    const captured = `${SYNTHETIC_BUILT.slice(0, -2)},${injected}))`;
    const verdict = applyVerdict(SYNTHETIC_BUILT, captured);
    expect(verdict.injected_filter_types).toEqual(["SENIORITY_LEVEL"]);
    expect(verdict).toMatchObject({ clean: false, injected: 1, honored: 2 });
    expect(verdictWarnings(verdict)).toContainEqual({ code: "FILTER_INJECTED", field: "SENIORITY_LEVEL", n: 1 });
  });

  it("treats a reordered subtree as rewritten rather than guessing equivalence", () => {
    const captured = SYNTHETIC_BUILT.replace(
      "(id:103644278,text:United%20States,selectionType:INCLUDED)",
      "(text:United%20States,id:103644278,selectionType:INCLUDED)",
    );
    const verdict = applyVerdict(SYNTHETIC_BUILT, captured);
    expect(verdict.filters[0]).toEqual({ type: "REGION", verdict: "rewritten" });
  });

  it("warns when the recent-search envelope changes", () => {
    const built = `(recentSearchParam:(doLogHistory:true),filters:List((type:REGION,values:List((id:103644278,text:United%20States,selectionType:INCLUDED)))))`;
    const captured = "(filters:List((type:REGION,values:List((id:103644278,text:United%20States,selectionType:INCLUDED)))))";
    const verdict = applyVerdict(built, captured);
    expect(verdict.recent_search).toBe("dropped");
    expect(verdictWarnings(verdict)).toContainEqual({ code: "RECENT_SEARCH_ECHO_CHANGED", field: "dropped", n: 1 });
  });

  it("groups several rewrites and drops into one warning per class", () => {
    const built = "(filters:List((type:REGION,values:List((id:1,text:A,selectionType:INCLUDED))),(type:INDUSTRY,values:List((id:2,text:B,selectionType:INCLUDED))),(type:FUNCTION,values:List((id:3,text:C,selectionType:INCLUDED)))))";
    const captured = "(filters:List((type:REGION,values:List((id:9,text:A,selectionType:INCLUDED))),(type:INDUSTRY,values:List((id:8,text:B,selectionType:INCLUDED)))))";
    const warnings = verdictWarnings(applyVerdict(built, captured));
    expect(warnings).toContainEqual({ code: "FILTER_REWRITTEN", field: "REGION, INDUSTRY", n: 2 });
    expect(warnings).toContainEqual({ code: "FILTER_DROPPED", field: "FUNCTION", n: 1 });
  });

  it("refuses to guess a verdict from an unparseable or duplicated query", () => {
    expect(() => applyVerdict(SYNTHETIC_BUILT, "not a query")).toThrowError(/cannot be compared|filters list/);
    const duplicated = "(filters:List((type:REGION,values:List((id:1,text:A,selectionType:INCLUDED))),(type:REGION,values:List((id:2,text:B,selectionType:INCLUDED)))))";
    expect(() => applyVerdict(SYNTHETIC_BUILT, duplicated)).toThrowError(/repeats filter type REGION/);
  });
});

/**
 * D457, measured live in run `01KZT4AJWX4G59KMHZM2R2JGP4`: LinkedIn prepends
 * `recentSearchParam:(doLogHistory:true)` to a query built without one. It is a
 * logging flag, not a filter, so it must not read as an audience change (D456).
 */
describe("the measured recent-search injection", () => {
  const BUILT_THREE =
    "(filters:List((type:REGION,values:List((id:103644278,text:United%20States,selectionType:INCLUDED))),(type:INDUSTRY,values:List((id:4,text:Software%20Development,selectionType:INCLUDED))),(type:SENIORITY_LEVEL,values:List((id:310,text:CXO,selectionType:INCLUDED)))))";
  const CAPTURED_THREE = BUILT_THREE.replace("(filters:", "(recentSearchParam:(doLogHistory:true),filters:");

  it("keeps the audience clean while reporting the envelope change", () => {
    const verdict = applyVerdict(BUILT_THREE, CAPTURED_THREE);
    expect(verdict).toMatchObject({
      audience_clean: true,
      clean: false,
      exact: false,
      honored: 3,
      rewritten: 0,
      dropped: 0,
      injected: 0,
      recent_search: "injected",
    });
    expect(verdictWarnings(verdict)).toEqual([
      { code: "RECENT_SEARCH_ECHO_CHANGED", field: "injected", n: 1 },
    ]);
  });

  it("still refuses to call an audience clean when a filter is dropped", () => {
    const dropped = CAPTURED_THREE.replace(
      ",(type:SENIORITY_LEVEL,values:List((id:310,text:CXO,selectionType:INCLUDED)))",
      "",
    );
    expect(applyVerdict(BUILT_THREE, dropped)).toMatchObject({ audience_clean: false, clean: false, dropped: 1 });
  });
});
