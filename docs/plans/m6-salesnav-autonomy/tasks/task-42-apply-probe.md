# Task 42 — Apply-side probe: does LinkedIn honor a URL we built? (live)

**Model:** Opus · **Depends on:** Task 41 · **Decisions owned:** D430–D439 (check free
first) · **Probe budget: max 6 page loads / 6 search pages, and the design target is 4/4.**
Every navigation is to a URL built by Task 41's `build` from vocabulary rows with
provenance — the probe composes nothing by hand.

## Objective

Measure — never assume — what happens when the browser cold-loads a search URL **we**
composed rather than one the UI produced. Everything `filters.apply` will claim rests on
this task's answers. Runs through the capability runner (extend `salesnav.probe` or a
sibling; no ad-hoc scripts), under lease, ledger, challenge gate, raw-first archive.

## The questions, each answered from captured bodies

1. **Echo fidelity.** Navigate one built LEAD URL reconstructing the archived CXO spec
   (all ids measured). Does the UI issue `salesApiLeadSearch` with our query verbatim?
   Field for field: reordered? `text:` preserved/dropped? `recentSearchParam` injected?
   The comparison is built-query vs **captured request URL** — the two D412/D413 lessons
   say the address bar is inadmissible.
2. **The invalid-id experiment.** One URL with one deliberately corrupted id in an
   otherwise valid spec (e.g. REGION id with a digit changed). Measure: request fired
   as-is? Filter dropped from the echo? Error surface? Interstitial? **This is the
   silent-mistargeting failure mode; `apply`'s verification is designed off what this
   measures.** Screenshot + archive regardless of outcome; if it renders anything that
   smells like a challenge, the challenge gate rules (stop, screenshot, exit 2) apply
   unchanged.
3. **Raw text.** One URL using `(text:…,selectionType:INCLUDED)` with no id on
   CURRENT_TITLE (measured `rawTextSupported:true`). Honored? Echoed how? Result count
   plausible (nonzero for "CEO")?
4. **Zero results and count trustworthiness.** Compose the raw-text or valid spec
   narrowly enough to plausibly land near zero (e.g. an absurd title string) — measure
   the empty state's body shape and that `paging.total` exists and is 0, not absent.
   (D357 measured the *unfiltered* empty state; the *filtered* one is a different page
   state and unmeasured.)
5. **Free riders, confirmed while there:** the filter-layout body arrives on these loads
   (catalog re-measurement is free — hash it against the fixture); does any captured
   body on a built-URL load enumerate **selected** filters or closed-enum option values?
   (If dropdown-value bodies appear without interaction, Task 43's coverage need
   shrinks — measure, don't hope.)

Batch the questions: 1+5 on load one, 2 on load two, 3 on load three, 4 on load four.
A batch that dies to the still-open CDP fault (BACKLOG/D402) may be retried within
budget; the fault evidence (close code instrumentation if present by then) is recorded
either way.

## Constraints

- Page 1 only, never a pager click, never `--pages` — this probe reads counts, not rows.
  No result row is stored: archive-only, like every probe. `search_results` gains 0 rows.
- Specs target the operator's real audience family (CXO/software) — real enough to be
  meaningful, never aimed at an individual.
- Third-party data: receipts carry counts and verdicts only; the invalid-id experiment's
  write-up names the corrupted id, never any returned entity.
- Operator supervises; each run separately approved, as every live invocation is.

## Deliverables

Archived runs; promoted fixtures for the built-URL request/response pair (subject-scoped);
`FILTER-MAP.md` extended with the echo rules (what LinkedIn preserves, injects, rewrites,
drops); the verification contract for Task 44 written as decisions in D430–D439 — in
particular **the honored/rewritten/dropped verdict's exact evidence rules**; spend used
vs budgeted on the STATE.md line.

## Acceptance criteria

- Every question above answered with an archive id attached, or explicitly recorded as
  unanswerable with what was measured and why.
- Offline suite green including new fixture-pinning tests; typecheck clean.
- Ledger/archive/receipt spend agreement, three numbers from three places.
- A clean stop (challenge, seat, CDP fault) is an acceptable outcome for a batch —
  honesty over completion, pacing over finishing today (M5 CONTEXT rule 3).
