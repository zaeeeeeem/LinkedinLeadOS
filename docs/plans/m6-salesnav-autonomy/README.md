# M6 Plan — Sales Navigator Autonomy: the Filter Self-Test Loop

**Date drafted:** 2026-08-11 · **Spec:** `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`
§9 L2 (`salesnav.filters.build` / `filters.apply`), "The filter self-test loop", §11 M6.
**Status: DRAFT — pending operator approval.** Nothing here runs live before approval.

M6 delivers the piece that removes the operator from targeting: a typed filter spec the
agent composes, a **pure offline URL builder**, a **metered apply-and-verify** step, a
**measured filter vocabulary** the builder draws ids from, and one proven end-to-end loop —
spec → build → apply → count → iterate → hand the converged URL to `salesnav.leads.list`.
After M6, the operator supplies intent ("US software CEOs at 11–50-person companies"), not
URLs.

## Scope cuts, stated up front

- **The classic search family is out of M6 entirely** — `classic.search.people` /
  `companies` / `posts`, `jobs.search`. Operator decision 2026-08-11: M6 is Sales Navigator
  autonomy only. Where classic lands (if ever) is a future operator call; recorded at
  approval as a plan-level decision so no session re-opens it.
- **The loop is the agent, not a capability.** The spec is explicit: *the agent iterates*.
  M6 ships the primitives (`build`, `apply`, the vocabulary); no `filters.loop`
  orchestrator, no scheduler, no campaign object — that is L5 and out of scope.
- **L3 writes stay out, including on this surface's own chrome.** The filter panel sits
  next to "Save search", list-add controls and lead links. Nothing in M6 clicks any of
  them. The two granted clicks (D400 pager, D408 saved-searches button) remain the only
  two; `filters.apply` needs **zero clicks** — it is a navigation.
- **`--pages` stays at 2 everywhere.** The third-page session-pin measurement (BACKLOG,
  D413) is still deferred and nothing in M6 depends on it: `apply` reads page 1 only.

## What is already measured — the research this plan stands on (2026-08-11, zero spend)

All from archives M5 already paid for; every claim below names its body.

**1. The complete filter catalog is on disk, captured free on every search page load.**
`salesApiSearchFilterLayout?q=viewModes` (81,800 bytes, e.g. run
`01KZQNM34D61NTBDQNDVSZ45AV` body `0014-3ff85d03efb79a26`) enumerates **every filter for
both verticals** — 32 LEAD types and 14 ACCOUNT types under `singleFilterMetadata`, plus
GEOGRAPHY/REGION/POSTAL_CODE and HEADQUARTERS_LOCATION under `aggregatedFilterMetadata` —
46 distinct `type` values in one body (35 LEAD rows + 17 ACCOUNT rows, with six names shared).
Two are aggregate presentation parents, leaving 44 request-emittable type names (D423). Per
filter it states: `typeaheadSupported`,
`facetTypeaheadType`, `rawTextSupported`, `exclusionSupported`, `dynamicFetch`,
`presentationType` (MULTI_SELECT / MULTI_ENTITY_WITH_MULTI_SELECT / SINGLE_SELECT /
TOGGLE / TEXT / RANGE_DROPDOWN / RANGE_TEXT), and for ANNUAL_REVENUE the full inline
`acceptedValues`. This body is fetched by the UI on every `/sales/search/*` load, so the
catalog re-measures itself for free on every future run — it is the natural drift sentinel.

**2. The URL grammar is measured, not guessed.** Captured `salesApiLeadSearch` /
`salesApiAccountSearch` request URLs (runs `01KZQFCFMVYKAC082JXDRVCAN3`,
`01KZQ5TXC23T3FFBJ72P8CE85J`, `01KZP693DEWVP0S90K7C7XQ997`) show the full shape:

```
q=searchQuery&query=(filters:List(
  (type:COMPANY_HEADCOUNT,values:List((id:B,text:1-10,selectionType:INCLUDED),(id:C,...))),
  (type:REGION,values:List((id:103644278,text:United States,selectionType:INCLUDED))),
  (type:INDUSTRY,values:List((id:4,text:Software Development,selectionType:INCLUDED))),
  (type:JOB_OPPORTUNITIES,values:List((id:JO1,...))),
  (type:DEPARTMENT_HEADCOUNT_GROWTH,rangeValue:(min:10),selectedSubFilter:8)
))&start=0&count=25&decorationId=...
```

Three value shapes are proven: **entity values** `(id,text,selectionType)`, **range
values** `rangeValue:(min[,max])` with optional `selectedSubFilter`, and the saved-search
form `q=savedSearch&savedSearchId=`. `trackingParam=(sessionId:…)` appears only on page ≥2
requests — a cold built URL carries none and LinkedIn mints the session (D360, D413).

**3. Resolved (type, id, displayValue, selectionType) tuples exist in operator-owned
bodies.** `salesApiSavedSearchesV2` returns each saved search's `filters` fully resolved —
a free, measured vocabulary source that costs nothing new to harvest. Captured request URLs
are a second such source.

**4. What is NOT anywhere in captured bodies — the honest gaps:**

- **Closed-enum option lists** (COMPANY_HEADCOUNT's full A–I buckets, SENIORITY_V2 ids,
  COMPANY_TYPE, TENURE bands…): `dynamicFetch:false` and no `acceptedValues` inline
  (except ANNUAL_REVENUE). Their values appear only when the UI's dropdown opens.
  **Where they come from is unmeasured.**
- **Typeahead vocabularies** (GEO ids beyond `103644278 United States`, INDUSTRY beyond
  `4`, TITLE, FUNCTION ids…): the typeahead endpoint has **never been captured** — no run
  ever typed into the filter bar. Thousands of options; each id exists only when the UI
  fetches it in response to typing.
- **Echo/normalization behavior of a *built* URL**: every measured `q=searchQuery` request
  so far came from a URL the UI itself produced. Whether LinkedIn honors, rewrites, or
  silently drops filters from a URL *we* compose is unmeasured — and "silently drops" is
  the failure `apply` exists to catch.

## How the vocabulary problem is solved without new grants

This was the open question at plan time and it decomposes cleanly:

1. **Schema/catalog** — already free (finding 1). Promoted to a fixture, pinned by tests.
2. **Ids already resolved in operator data** — harvested offline from archives (finding 3).
3. **Everything else — the thousands of options — comes from an operator-driven harvest
   session (Task 43):** the capability opens the worker tab on the search page, then
   **observes only** while the *operator* types and clicks through the filter bar by hand.
   Every typeahead response, dropdown enum fetch and interim search body lands in the
   archive through the ordinary tap; an offline harvester then builds the vocabulary. The
   human does the interacting, so no click or type grant is needed, no request is forged,
   and the captured bodies are things LinkedIn's own UI issued — the letter and the spirit
   of every rule. One thorough session per audience family (geos, industries, seniorities,
   functions, titles) funds the builder indefinitely; closed enums are small and captured
   completely the first time their dropdown opens.
4. **If coverage gaps persist** — the agent needs a geo id no session ever typed — Task 43
   ends with a written `[DECISION NEEDED]` on an **agent typing grant** (focus + keystrokes
   into the typeahead box, a new interaction class), argued against the D409 four-part
   test with the harvest session's measurements attached. Not assumed, not implemented
   ahead of the grant. Raw text (`rawTextSupported:true`, e.g. CURRENT_TITLE) is the
   measured zero-vocabulary fallback where LinkedIn offers it.

## Why this plan is shaped the way it is

M4/M5's lesson holds: every task that started from a live measurement landed; every task
that started from an assumption was re-cut. The archive research above is the measurement
this plan starts from — but it covers only the *read* side. The two live unknowns (echo
fidelity of built URLs; where option values come from) each get a measuring task before
any capability depends on the answer.

**Build is pure and free; apply is where money and honesty meet.** A builder bug wastes a
metered search page per bad URL and — worse — a *silently dropped filter* mis-targets an
audience while looking green. So `apply`'s verification never trusts the address bar or
the render: it compares the **captured request URL** the UI actually issued, and the
response's own `paging`, against the spec, and reports every filter as honored / rewritten
/ dropped. The D412/D413 lessons (percent-encoding, address-bar lies) are load-bearing
grammar here, not trivia.

**Search pages remain the scarcest budget.** Every apply is 1 page load + 1 search page.
The loop's convergence budget is bounded per session, and iteration count is a designed
number in the task file, not "until it looks right".

## Plan layout

| File | Role |
|---|---|
| `CONTEXT.md` | What every task agent **reads first** — M5 CONTEXT by reference plus the M6 rules |
| `RECORDING.md` | What every task agent **updates** — M5 RECORDING plus vocabulary provenance and echo evidence |
| `tasks/task-NN-*.md` | One task each: objective, constraints, acceptance criteria |

## Task order and dependencies

```
41 filter grammar + catalog fixtures + filters.build + archive-harvested vocab (offline)
41 ─► 42 apply-side probe: echo fidelity of built URLs (live, small)
41 ─► 43 vocabulary harvest session (live, operator-driven, observe-only)
42 ─► 44 salesnav.filters.apply capability (offline build + live gate)
43, 44 ─► 45 the self-test loop, end to end (live gate; the M6 gate)
```

- 41 is first and offline — grammar, catalog and builder exist before any metered page,
  exactly as Task 35 preceded every M5 live step. Its vocabulary is seeded only from
  archives already on disk.
- 42 needs 41 (it navigates URLs 41 built) and is deliberately tiny: it answers one
  question — does LinkedIn honor a URL we composed, and how do we *prove* which filters
  applied — in ≤4 metered pages.
- 43 needs 41 (the harvester writes into 41's vocabulary store) and can run before or
  after 42; it spends page loads but initiates no search itself.
- 44 needs 42's fixtures (D152: no verification parser before a fixture from a real
  built-URL load exists).
- 45 is the gate and needs everything: vocabulary deep enough to compose with, apply
  proven, and `salesnav.leads.list` unchanged from M5 as the consumer.
- Offline tasks may run in parallel worktrees; live runs stay serialized by the tab lease
  and the ledger.

## Decision-number ranges

The live high-water mark in `DECISIONS.md` is **D413**. Plan-approval decisions take
**D414–D419** (classic-family cut, harvest-session model, vocabulary-provenance rule,
apply-verification rule). Task ranges, checked free before use as always:

Task 41 → **D420–D429** · Task 42 → **D430–D439** · Task 43 → **D440–D449** ·
Task 44 → **D450–D459** · Task 45 → **D460–D469**.

**Operator decisions taken between tasks start at D470** (the typing grant, if it is ever
asked for and given, lands there — not inside a task's range).

## Model assignment

Split by consequence of a silent bug, as before. The builder and the verification
comparator are the autonomy safety surface — a silent bug there mis-targets audiences or
wastes the scarcest budget while reporting green.

| Model | Tasks |
|---|---|
| **Opus** | 41 (grammar + builder) · 42 · 43 · 44 · 45, and every live gate step |
| **Sonnet** | none reserved; 41's fixture-pinning test files may be delegated at the operator's call |

If a delegated piece reviews weak, re-run on Opus — do not hand-patch.

## Review protocol

Unchanged from m1-m3/m4/m5: fresh Opus reviewer per task against the task file,
`CONTEXT.md` and the diff; findings fixed before the next task; second-opinion review at
the operator's call for everything live (42, 43, 45, and 44's gate).

## Milestone gate

**M6 gate** = all of the following, live and operator-supervised where live:

- `salesnav.filters.build`: offline — round-trips **every** archived measured URL
  (parse → spec → build → byte-identical query), refuses invalid specs (unknown type for
  the vertical, exclusion where unsupported, malformed range), and builds only from
  vocabulary rows with named provenance. Zero LinkedIn requests, ever.
- `salesnav.filters.apply`: one default-flags run on a built URL, exit 0, with the
  verification verdict (honored / rewritten / dropped, per filter) read from the
  **captured request and response bodies**, never the address bar or the render — and the
  result count on the receipt. Verified independently: archive holds the named search
  body; ledger holds exactly 1 page load + 1 search page; the `searches` row (if Task 44
  decides to write one) matches.
- **The loop, once, for real:** starting from a typed audience intent and the vocabulary,
  the agent converges to a target result-count band in ≤ the task's iteration budget,
  then `salesnav.leads.list` runs its normal default gate **on the converged URL** and
  passes exactly as in M5. That handoff — intent to stored, provenance-tagged lead rows
  with no operator-supplied URL anywhere in the chain — is the definition of M6 done.
- The vocabulary store contains **only** rows whose provenance names a captured body or
  archived request URL; a spot audit of N random rows resolves each to its source.
- No new DOM exception; the CLAUDE.md click inventory unchanged at two (or extended only
  by an explicit D470+ operator grant, recorded before use).

Every gate verified independently of receipts — archives, ledger, Supabase. Nothing after
M6 starts before this gate.

### M6 gate result — PASSED, 2026-08-12 (D477)

Checked item by item, each verified independently of receipts:

- [x] **`salesnav.filters.build` offline** — round-trips every archived measured URL, refuses the
      invalid specs named above, builds only from provenance-bearing rows. 0 LinkedIn requests.
      Suite 1,863/1,863, `tsc --noEmit` clean.
- [x] **`salesnav.filters.apply` on default flags** — five runs, exit 0 each. Verdicts read from the
      captured request and response bodies; archive holds the named search body; ledger holds
      exactly 1 page load + 1 search page per run; the `searches` row matches.
- [x] **The loop, once, for real** — typed intent → 4 applies (one halted on a rewrite, D476) →
      converged at 1,285 inside the 300–2,000 band → `leads.list` default flags on the converged
      URL → 50 provenance-tagged rows. No operator-supplied URL anywhere in the chain.
- [x] **Vocabulary provenance** — every id in the converged spec resolves to a row naming a captured
      body or archived request URL. The one row added this session (`requestText` on LEAD/REGION
      `102095887`) names its request-url archive and is request-url-only by validation.
- [x] **No new DOM exception; click inventory unchanged at two** — the gate's only click was
      `leads.list`'s `Next` pager control under the existing D400 grant. No D470+ interaction grant
      was needed or taken.

Spend: **7 search pages / 7 page loads against 9 planned.** Ran under D475, a temporary operator
grant overriding D466; both raised numbers restored and verified immediately after.
