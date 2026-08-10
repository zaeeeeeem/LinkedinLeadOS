# Task 39 — `salesnav.leads.list` end to end + resume live gate (live)

**Model:** Opus · **Depends on:** Tasks 35, 36, 38 · **Spec:** §7, §9 L2, §11 M5 ·
**Decisions owned:** D380–D389
**Budget: the live gate is the expensive one — max 8 search pages** across the default
run and the kill-and-resume run combined. Keep default page count small (2–3 pages proves
pagination); resume proves the contract, not scale.

## Objective

Wire the leads parser (Task 38), the paged-run contract (Task 35) and the search store
(Task 38) into `salesnav.leads.list`, and pass the M5's hardest gate: **a run killed
mid-pagination resumes to completion without re-spending a proven page.** This is the
capability that proves the whole paged architecture, the way `profile.get` proved L1.

## Constraints

- **Consume, do not re-derive, the Task 35 contract.** Spend→load→archive→checkpoint per
  page; resume verifies against the archive on disk. If you find yourself re-implementing
  checkpoint or ledger logic in this capability, stop — extend Task 35's module.
- **Runs through the runner** with lease, ledger/sub-caps, challenge gate, raw-first
  archive, human-input pacing between pages (§8: randomized dwell, real wheel, no fixed
  cadence). Reuse the proven composition end to end.
- **Pagination exactly as Task 36 measured it.** If Task 36 found a URL form, cold-load
  each page. If it found a click-only control, that decision must already be granted
  (D323 precedent) before this task writes any click — otherwise this task is blocked.
- **Default flags pass the gate (M4 CONTEXT rule 5).** `--limit`/`--pages` have sane
  defaults; if the gate needs a non-default flag to pass, the default is wrong — fix it.
- **Storage per Task 38:** append-only `search_results` with page/position provenance;
  a `searches` row per the approved model; **no entity table touched**.
- **Re-running a search spends again by design** — `search_results` is append-only and
  freshness does not apply to searches. The receipt says so; there is no cache to hunt.
- **Challenges are D60:** a Sales Nav interstitial is screenshot + checkpoint + exit 2,
  never solved; the run is resumable afterward. Record any new marker (Task 36 / RECORDING).
- Verification is independent of the receipt (M4 CONTEXT rule 6): Supabase query, archive
  listing, ledger read.

## Deliverables

`src/capabilities/salesnav.leads.list/{index.ts,README.md}` (parser from Task 38);
`cost()` reporting search_page (+ page_load per Task 35's decision); the two live gate
runs with full independent evidence; decisions D380–D389; `STATE.md` checkpoint(s) with
the three-numbers-equal spend evidence.

## Acceptance criteria

- Offline suite green; typecheck clean.
- **Live gate, default flags, run A:** exit 0, no unhandled challenge, within budget,
  lease released. Rows in `search_results` verified by direct Supabase query, each with
  correct search_id/page/position; a `searches` row present; raw bodies on disk for every
  page the ledger charged; `search_page` ledger lines = distinct pages loaded exactly once.
- **Live gate, kill-and-resume, run B:** start a multi-page run, **kill it mid-pagination**
  (operator-supervised), resume via `--run-id`, and prove: pages before the kill are not
  re-loaded or re-spent (ledger + archive), pages after complete exactly once, final
  `search_results` has no duplicate `(search_id, page, position)`, and the total
  `search_page` count equals the number of distinct pages actually loaded. Read every one
  of these from Supabase/archive/ledger, never the receipt.
- Entity tables provably untouched by the search run (query `persons`/`companies`
  `last_seen` before and after).
- **Discipline gate** — all four review shapes walked, with review shape 1 applied to the
  kill points specifically.
