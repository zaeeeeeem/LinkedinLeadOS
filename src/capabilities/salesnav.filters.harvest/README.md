# `salesnav.filters.harvest`

Operator-driven, observe-only Sales Navigator filter vocabulary capture. The capability opens
exactly one automation-profile worker-tab search page (`people` or `company`), passes control
to the operator, and then sends **zero clicks, keystrokes or wheel events**. It passively
archives the wide Sales Navigator/LinkedIn data net until one Ctrl-C, a `PAUSE` file in the
run directory, the time limit, or the declared search-page budget ends the session.

`--operator-plan` is required and is persisted verbatim in `run.json` before contact so the
run record says what the operator intended to visit and type in the operator's own words. The
receipt records only that the plan exists, counts, endpoint paths, and the zero-input claim; it
does not reconstruct keystrokes or emit captured vocabulary values.

## Cost and accounting

Each invocation initiates exactly 1 page load. Before navigation it charges the **full declared
session search allowance**, so a crash during the human phase can waste budget but cannot erase
search exposure from the ledger. UI-issued `salesApiLeadSearch` / `salesApiAccountSearch`
requests are then deduplicated by CDP request id across captures and misses and reconciled
against that allowance. `--search-page-budget` defaults to 12 and may not exceed 25; unused
units remain deliberately over-counted.

Daily sub-caps are 4 page loads, 25 search pages and 0 profile opens. The four-page load cap is
Task 43's hard capability-initiated budget across the planned Lead and Account sessions; a flag
cannot raise it. A failed live invocation needs new operator approval before another one.

## Stop and failure modes

- One Ctrl-C asks the observer to finish; a second terminates immediately.
- Creating `<run-dir>/PAUSE` also finishes without an input event.
- A challenge response or final DOM challenge gate screenshots, checkpoints and exits under
  the ordinary challenge rules. Nothing is solved or retried.
- The session stops when its search-page budget is reached. Do not continue interacting after
  the stop message or after a challenge appears.

The live session is measurement, not a parser. Under D152, typeahead/dropdown extraction is
added only after the real archive identifies the endpoint shapes. Offline re-harvest then uses
`salesnav.filters.vocab`; no Supabase table is written by this capability.
