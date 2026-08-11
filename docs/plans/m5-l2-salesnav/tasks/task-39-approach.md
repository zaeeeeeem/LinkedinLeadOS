# Task 39 approach — researched before implementation

The existing composition has four load-bearing boundaries. `runPaged` owns spend, archive
claims and checkpoint order; the network tap owns raw-first writes; `clickPagerControl` owns
the only permitted page turn; and `insertSearchResults` owns immutable
`(search_id,page,position)` provenance. Task 39 should join those boundaries without moving
work across them.

The reference worker confirms two useful behaviours and two behaviours this implementation
must not copy. It keeps one Sales Navigator `sessionId` across page turns and returns to the
page in the tab rather than inventing a cold page URL. It also waits for a changed result set
after a trusted pager click. Its DOM-card source and pager-label arrival check are superseded
by D351 and D407: this capability selects `salesApiLeadSearch` by endpoint name, parses its
archived body, and accepts page N only when the body's paging offset says N arrived.

The page source therefore does the following for each paid attempt: navigate only page 1;
click the measured Next control for later pages; run both challenge gates; wait for and drain
the named lead-search capture; parse it offline; require the expected body offset and the same
Sales Navigator `sessionId`; and return the exact tap archive ids in `PageLoad.archived`.
Those ids are the D403 resume proof. The page fingerprint is a hash of stable person urns, so
the checkpoint detects a repeated body without storing captured LinkedIn data.

Storage happens from every page the final paged checkpoint proves, not only from
`outcome.loaded`. That distinction is the resume gate: an adopted page and a page loaded by a
prior process are absent from the current session's in-memory list but present in the archive.
Re-reading each proved archive body after `runPaged` returns makes storage converge after a
hard kill without putting store writes between load and checkpoint. Existing positions are
then adopted by `insertSearchResults`; changed identities remain a visible refusal.

`search_id` is the run id. A fresh rerun receives a fresh immutable search definition, while a
resume keeps the same definition and provenance key. Reusing a saved-search id was rejected:
`insertSearch` is insert-only (D371), so the second observation would either overwrite history
or fail before loading. The saved-search id remains inside the preserved filter URL rather
than becoming the observation's identity.

The `runs` table currently has no store writer, so writing `search_results.run_ref` would fail
its real foreign key. Task 39 will add the minimal run-bookkeeping store path needed by this
first caller: create the parent before a fresh run, keep it on a hard kill, reopen it on
resume, and finish it on every classified success/error path the capability owns. This is
required by D94 rather than optional reporting.

The shared `salesnav.probe/pager.ts` is not changed. Task 37 is generalizing it concurrently;
Task 39 consumes only the stable `clickPagerControl` interface and therefore has no overlapping
edit.

## Discipline review checkpoint

1. **Partial-failure state:** a run parent survives before its search child; any later error
   finalizes that parent without replacing the original classified error. A proved page
   survives a kill before storage and is projected again from its named archive ids. Store
   batches are one page (at most 25 positions), so a later-page failure reports the earlier
   committed row count and resume adopts those immutable positions. The tap is drained and
   signal listeners are disposed in `finally`; the runner owns the tab lease release.
2. **Failure classification:** consumed challenge, budget, tap, pager, archive and store
   errors pass through. An unchanged clicked offset is a non-retryable operator-visible
   refusal; a changed named-body paging shape is exit 5; session/position ambiguity is a
   refusal because retrying could join result sets. A finish-row failure never hides the
   error that caused finalization.
3. **Claimed properties:** exact tap archive ids, challenge-checkpoint preservation,
   body-offset arrival, stable-session-before-click, page-bounded store writes, partial-store
   counts, archive re-projection, fingerprint corroboration, parse-drift classification and
   `--no-store` are named tests. Deliberate mutations of the first three resume/storage safety
   boundaries and the latter two classification/flag branches go red.
4. **First composition:** the typed `SalesNavLeadsDeps` default object proves the real pager
   source, paged loop and store functions meet at compile time; the composition test feeds
   two archive-proved pages through projection into two immutable store batches.
