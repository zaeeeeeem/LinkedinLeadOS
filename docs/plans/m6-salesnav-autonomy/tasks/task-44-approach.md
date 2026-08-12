# Task 44 approach — researched before implementation

`salesnav.filters.apply` is the metered half of the M6 loop. It takes a typed `FilterSpec`,
runs Task 41's provenance-backed builder before any spend, navigates once, and reports —
from captured bodies only — which filters LinkedIn actually searched on and how big the
audience is. It reads page 1 and stops; pagination stays in `salesnav.leads.list` /
`salesnav.accounts.list`.

Four boundaries already exist and none of them needs new machinery. The budget ledger owns
spend and its ordering. The network tap owns raw-first archiving. Task 41's `buildFilterUrl`
owns the query grammar and the refusal of any unproven id. `insertSearch` owns the immutable
search definition row. Apply composes them; it forks none of them.

## What is measured, and what is therefore possible

Every claim this capability makes traces to run `01KZSZF6MXC6HHP9Z4RQBHXP19`, archive
`0016-5e81b94c63cd41b8` — Task 42's one approved CXO load.

- The **captured request query** is in that capture's `.meta.json` `url`. It is the only
  admissible echo evidence; the address bar lies on this surface (D413).
- The **paging** block is `$.paging` with integer `total` / `count` / `start`.
- The **executed session id** is `$.metadata.tracking.sessionId` —
  `oA4C51gbRjqLAXYZH+Sr3A==` in that body. This is a labeled body field on a labeled Voyager
  response, so reporting it needs no DOM exception and no address-bar read. The page-1
  *request* carries no `trackingParam`, which is why the response body is the only source
  (D451).
- The **catalog** arrives free on the same load as `salesApiSearchFilterLayout` and is hashed
  against the pinned fixture, exactly as the probe does it.

## What is not measured, and is therefore not built

The task file asks for fixtures covering a rewritten filter, a dropped filter, a raw-text
echo and a zero-result body. **None of those four shapes has ever been observed on the wire**
— D431 records why the invalid-id and raw-text loads are unanswerable under the
provenance-only builder contract, and D435 records that no measured filter combination is
known to yield zero. Manufacturing an archive for any of them would be inventing LinkedIn
behavior, which M6 CONTEXT rule 1 forbids.

The resolution is a distinction the task file does not draw but the truthfulness rule
requires (D453): a **measured-echo fixture** claims LinkedIn did something, and there is
exactly one — the clean CXO honor. **Comparator unit tests** claim only that our own
comparison function classifies a given pair of query strings correctly, and those may be
synthetic, because the input is our string, not LinkedIn's conduct. Every synthetic pair is
named as such in its test and none is promoted to `fixtures/` or cited as evidence of
LinkedIn behavior. `PAGING_SOURCE_INDIRECT` is likewise not emitted: no indirect paging
source has ever been observed, and a warning that cannot fire is a false promise on a
receipt.

## Shape decisions

**Spec-only, no URL argument** (D450), following D430. A `--url` input would let a caller
hand apply a query assembled outside the builder, bypassing vocabulary validation — the one
thing the builder exists to prevent. The loop composes specs, not strings.

**Both verticals** (operator's call, 2026-08-12). LEAD routes to `/sales/search/people` and
watches `salesApiLeadSearch`; ACCOUNT routes to `/sales/search/company` and watches
`salesApiAccountSearch`. Both routes and both endpoints are measured in M5 archives, and the
vocabulary registry already holds ACCOUNT rows for eight facets. The vertical is read from
the spec and drives one route constant and one endpoint constant; nothing else branches.

**The comparator is promoted, not copied** (D452). Task 42's `compareQueryEcho`,
`parseSearchPaging`, `requestQuery` and the digest helpers move to
`src/core/salesnav-query/echo.ts` behind a neutral `QueryEchoError`. The probe keeps its
`FilterProbeParseError` codes by wrapping, so its measured contract and its receipts are
byte-identical to before; a probe test pins that. Two copies of the verdict rule would be
two chances to drift on the one comparison the milestone's safety rests on.

**Storage writes one `searches` row with zero `search_results`** (operator's call, D454).
`search_id` is the run id, `kind` is `sn_leads` / `sn_accounts`, `filter_url` is the built
URL, and `filter_json` carries the verdict, counts, paging and session id. It is written
**after** the verdict exists — apply's row is a record of an execution, not a plan — using
insert-only `insertSearch`, because apply is single-shot and has no resume path to adopt a
prior row. `--no-store` skips it and says so on the receipt. The row makes `searches` mean
"a search that was executed", widening the previous "a search whose rows were read"; that
widening is the decision, taken deliberately.

Note the asymmetry this creates and accept it explicitly: `filter_url` carries real filter
values into the operator's own Supabase, exactly as `salesnav.leads.list` already stores an
operator-supplied URL. Stdout keeps its stricter rule — the receipt carries type names,
verdicts, counts and hashes, never a filter value (D432).

**The D411 precheck is not adopted here.** Task 44's file permits it only by changing the
shared Task 35 contract properly. That is a separate change with its own decision and test
set, and apply does not need it: the builder already refuses every URL-derived impossibility
it can see, before any budget call.

## Discipline review checkpoint

1. **Partial-failure state.** The build refuses before `check`, so a bad spec costs nothing.
   `check` precedes `spend`, `spend` precedes `navigate`, and the tap watches are released in
   `finally` with a drain, as in the probe. The store row is written only after the verdict is
   proved, so a crash mid-run leaves the archive and no half-true row; a crash after the write
   leaves a row whose every field is already corroborated by the named archive. Nothing is
   updated or deleted, so a re-run is a new run id and a new row rather than a mutation.
2. **Failure classification.** Budget, auth, challenge and transient errors pass through their
   existing classes unchanged (7 / 4 / 2 / 6). Exit 5 is reserved for evidence failures: no
   named search response captured, a captured request with no `query`, missing or non-integer
   paging, a response that does not identify page 1, more than one distinct search query on
   one navigation, or a query either side cannot be parsed. A build refusal is exit 1 except
   for catalog/registry/provenance codes, which are drift. Catalog hash drift is a warning
   unless it breaks the run's own claim.
3. **Claimed properties.** Tests name: build-refuses-before-spend; the check/spend/navigate
   ordering; the LEAD and ACCOUNT endpoint and route selection; verdict read from the captured
   request rather than the landed URL; dropped and rewritten filters producing non-zero
   warnings; session id read from `metadata.tracking.sessionId`; page-1 enforcement; the
   `searches` row's contents and its `--no-store` skip; and the sub-cap constants. Four
   mutations are checked to bite before the gate.
4. **First composition.** A compile-time assignment pins the real `insertSearch` export into
   apply's dependency contract, and the composition test drives a spec through the real
   builder, the real comparator and that dependency into one immutable search row.
