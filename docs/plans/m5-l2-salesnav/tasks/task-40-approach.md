# Task 40 approach — researched before implementation

The accounts runner has the same four boundaries Task 39 proved: `runPaged` owns spend,
archive claims and checkpoint order; the network tap owns raw-first writes;
`clickPagerControl` owns the permitted page turn; and `insertSearchResults` owns immutable
`(search_id,page,position)` provenance. Accounts needs no new machinery at any boundary.

The vertical-specific differences are semantic and stay explicit. The named response is
`salesApiAccountSearch`; the parser keys rows on the plain `entityUrn`; the source pins the
company-search route and its Sales Navigator session; and storage writes `company_urn` with
no `person_urn`. Page fingerprints therefore hash company urns, never `trackingId` and never
the leads-only `objectUrn`.

Two implementation shapes were considered. Generalizing the leads source and capability
would reduce textual duplication, but it would introduce a shared abstraction proved live on
only the leads vertical immediately before the first accounts page-2 measurement. Mirroring
Task 39 keeps each vertical's opposite identity rule visible and reviewable, while both still
compose the same typed `src/core/paged/` export; that is the safer choice until two live
verticals establish a real common seam.

The live gate is a fresh default two-page run only. Resume is inherited from Task 39 and is
not paid for again. The gate accepts page 2 solely from the named account-search body's
`paging.start`/`paging.count`, treats a non-advance as a failure, and records any shape change
as a decision rather than silently widening the page-1 parser.

## Discipline review checkpoint

1. **Partial-failure state:** the Task 39 lifecycle is preserved: run/search parents precede
   result writes; tap drain and signal disposal remain in `finally`; proved archives survive
   a kill before storage; page-bounded inserts report prior committed rows on a later failure.
2. **Failure classification:** challenge, budget, tap, pager, archive and store errors pass
   through unchanged. Missing or changed paging is parse drift; a clicked page that does not
   advance and session/position ambiguity are non-retryable refusals.
3. **Claimed properties:** tests name endpoint selection, body-offset arrival, stable company
   fingerprints, company-only provenance, archive re-projection, page-bounded writes,
   `--no-store`, and the direct `runPaged` composition. The identity and composition claims
   are mutation-checked before the gate.
4. **First composition:** a compile-time assignment pins the real `runPaged` export into the
   accounts dependency contract, and the composition test feeds two account archive bodies
   through that dependency into two immutable store batches.
