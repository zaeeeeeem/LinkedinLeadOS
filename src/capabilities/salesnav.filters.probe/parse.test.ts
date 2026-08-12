import { describe, expect, it } from "vitest";
import { bodyDigest, compareQueryEcho, FilterProbeParseError, parseSearchFilterMetadata, parseSearchPaging, queryDigest, requestQuery } from "./parse.js";

describe("salesnav.filters.probe parsing", () => {
  it("reads paging.total including the measured zero-result shape", () => {
    expect(parseSearchPaging('{"paging":{"total":0,"count":25,"start":0},"elements":[]}'))
      .toEqual({ total: 0, count: 25, start: 0 });
  });

  it.each([
    "{}",
    '{"paging":{"total":0,"count":25}}',
    '{"paging":{"total":-1,"count":25,"start":0}}',
    '{"paging":{"total":"0","count":25,"start":0}}',
    "not-json",
  ])("refuses a search body without complete integer paging: %s", (body) => {
    expect(() => parseSearchPaging(body)).toThrow(FilterProbeParseError);
  });

  it("reports passive option and selected-filter evidence without returning values", () => {
    const body = JSON.stringify({ metadata: { filters: [
      { singleFilterMetadata: { type: "SENIORITY_LEVEL", values: [{ id: "1", displayValue: "One" }, { id: "2", displayValue: "Two" }] } },
      { singleFilterMetadata: { type: "PERSONA", values: [{ id: "private", displayValue: "Private", selectionType: "INCLUDED" }] } },
      { aggregatedFilterMetadata: { type: "GROUP" } },
    ] } });
    expect(parseSearchFilterMetadata(body)).toEqual({
      filter_blocks: 3,
      value_rows: 3,
      selected_value_rows: 1,
      selected_filter_types: ["PERSONA"],
    });
    expect(JSON.stringify(parseSearchFilterMetadata(body))).not.toContain("private");
  });

  it("treats absent response filter metadata as no passive enumeration", () => {
    expect(parseSearchFilterMetadata('{"paging":{"total":0,"count":25,"start":0}}')).toEqual({
      filter_blocks: 0, value_rows: 0, selected_value_rows: 0, selected_filter_types: [],
    });
  });

  it("reads the captured request query without decoding its structural grammar", () => {
    const query = "(filters:List((type:REGION,values:List((id:1,text:New%20York,selectionType:INCLUDED)))))";
    expect(requestQuery(`https://www.linkedin.com/sales-api/salesApiLeadSearch?q=searchQuery&query=${query}&start=0`))
      .toBe(query);
  });

  it("refuses a captured request with no query parameter", () => {
    expect(() => requestQuery("https://www.linkedin.com/sales-api/salesApiLeadSearch?q=searchQuery"))
      .toThrowError(/no query parameter/);
  });

  it("hashes query and body bytes deterministically and separately", () => {
    expect(queryDigest("a")).toBe(queryDigest("a"));
    expect(queryDigest("a")).not.toBe(queryDigest("b"));
    expect(bodyDigest("a")).toBe(queryDigest("a"));
  });

  it("classifies exact, rewritten, dropped and injected captured-wire filters without returning values", () => {
    const built = "(recentSearchParam:(doLogHistory:true),filters:List((type:REGION,values:List((id:1,text:A,selectionType:INCLUDED))),(type:INDUSTRY,values:List((id:2,text:B,selectionType:INCLUDED))),(type:FUNCTION,values:List((id:3,text:C,selectionType:INCLUDED)))))";
    const captured = "(recentSearchParam:(id:9,doLogHistory:true),filters:List((type:REGION,values:List((id:1,text:A,selectionType:INCLUDED))),(type:INDUSTRY,values:List((id:4,text:B,selectionType:INCLUDED))),(type:SENIORITY_LEVEL,values:List((id:5,text:D,selectionType:INCLUDED)))))";
    expect(compareQueryEcho(built, captured)).toEqual({
      filters: [
        { type: "REGION", verdict: "honored" },
        { type: "INDUSTRY", verdict: "rewritten" },
        { type: "FUNCTION", verdict: "dropped" },
      ],
      injected_filter_types: ["SENIORITY_LEVEL"],
      recent_search: "rewritten",
    });
  });

  it("treats subtree field reordering as a rewrite and distinguishes absent from injected recentSearchParam", () => {
    const built = "(filters:List((type:REGION,values:List((id:1,text:A,selectionType:INCLUDED)))))";
    const reordered = "(recentSearchParam:(doLogHistory:true),filters:List((values:List((id:1,text:A,selectionType:INCLUDED)),type:REGION)))";
    expect(compareQueryEcho(built, reordered)).toEqual({
      filters: [{ type: "REGION", verdict: "rewritten" }],
      injected_filter_types: [],
      recent_search: "injected",
    });
    expect(compareQueryEcho(built, built).recent_search).toBe("absent");
  });

  it("refuses duplicate filter types instead of hiding an ambiguous echo", () => {
    const built = "(filters:List((type:REGION,values:List((id:1,selectionType:INCLUDED)))))";
    const duplicate = "(filters:List((type:REGION,values:List((id:1,selectionType:INCLUDED))),(type:REGION,values:List((id:2,selectionType:INCLUDED)))))";
    expect(() => compareQueryEcho(built, duplicate)).toThrowError(/repeats filter type REGION/);
  });
});
