# RECORDING — what every M6 task updates

**`docs/plans/m5-l2-salesnav/RECORDING.md` applies in full**, and through it m1-m3 and
m4: `STATE.md` at every checkpoint, commit-message property rule, `DECISIONS.md` in your
reserved range (checked free first), capability READMEs, task-file corrections in the same
commit, per-page spend evidence as three numbers from three places, challenge markers as
decisions. M6 adds:

## Vocabulary provenance (41, 43)

- Every vocabulary row records **which archived body or request URL it came from** (run
  id + archive id, or the URL's meta file). A STATE.md checkpoint that adds vocabulary
  states: rows added, per facet type, and the source runs. A spot audit instruction lives
  in the store's README so any session can verify a random row to its source.
- Operator-private ids (ACCOUNT_LIST, LEAD_LIST, PERSONA, saved-search ids, CRM anything)
  are recorded as **operator-scoped** rows, excluded from any committed fixture, and never
  appear in a commit message or receipt example.

## Echo evidence (42, 44, 45)

Any run that navigates a built URL delivers, on its STATE.md line: the built query, the
**captured** request query (from the request's meta, not the address bar), the per-filter
verdict (honored / rewritten / dropped), and `paging.total` — with the archive id of the
search body named. A write-up that quotes the receipt without the archive id is
incomplete by definition.

## Harvest sessions (43)

Each session's run record states: what the capability did (open, navigate, observe — and
explicitly that it performed zero interactions), what the operator did by hand (facets
visited, roughly what was typed — the operator's own words, never reconstructed
keystrokes), bodies captured per endpoint, vocabulary rows harvested per facet, and how
operator-triggered metered searches were counted against the ledger. Any UI control the
operator used that the toolkit has never inventoried gets a one-line note — future
grant discussions start from these notes.

## Loop evidence (45)

The gate write-up records the full iteration table: iteration number, spec delta from the
previous iteration (which knob turned, why), built URL, per-filter verdict, `paging.total`,
running spend. Then the handoff: the converged URL, the `leads.list` run id it fed, and
that run's own three-numbers spend evidence. The table is the spec for L4's future
automation of the same judgment — write it so a machine could follow it.

## Decisions that must not be buried

- The typing grant, if requested: a written `[DECISION NEEDED]` with the D409 four-part
  analysis and the harvest measurements attached, in Task 43's write-up — the grant
  itself, if given, lands at D470+ with the operator's wording.
- Any filter type whose applied behavior contradicts the catalog (says
  `exclusionSupported` but the echo drops the exclusion, etc.) — a decision in the
  observing task's range, plus a builder validation update in the same commit.
- Result-access limits the gate observes (totals vs pages actually reachable) — recorded
  as measured numbers for the M7+ planner, never extrapolated.
