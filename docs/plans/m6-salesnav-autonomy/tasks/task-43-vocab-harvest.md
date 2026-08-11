# Task 43 — Vocabulary harvest: operator drives, capability observes (live, operator-in-the-loop)

**Model:** Opus · **Depends on:** Task 41 (store + harvester exist) · **Decisions owned:**
D440–D449 (check free first) · **Budget: max 4 page loads initiated by the capability.**
Operator-triggered requests during the session are accounted under this task's D-range
decision (below), over-count before under-count.

## Objective

Fill the vocabulary the builder is allowed to draw from — the thousands of typeahead
options and the closed-enum lists that exist **nowhere** in any body captured to date —
without granting the toolkit a single new interaction. The capability opens the page;
the **operator's own hand** types and opens dropdowns; the tap archives everything the
UI fetches; an offline harvester turns the archives into provenance-tagged vocabulary.

This session is also the **measurement bank for any future typing grant**: every control
anchor, endpoint shape and request pattern the operator's interaction reveals gets
recorded, so a D470+ grant discussion argues from archives, not speculation.

## Session design

- `salesnav.filters.harvest` (or a probe face): lease, ledger, challenge gate, tap with
  a wide `sales-api-any` net **plus** named watches for whatever typeahead/option
  endpoints appear (their names are unmeasured — discovering them is a deliverable).
  Opens the worker tab, navigates to `/sales/search/people`, prints "observing — drive
  the filter bar; Ctrl-C/pause-file to finish", and **performs zero interactions
  thereafter** (no click, no keystroke, no wheel). A second session covers
  `/sales/search/company`.
- The operator, by hand, in the worker tab: opens each closed-enum dropdown once
  (headcount, seniority, function, company type, tenure bands, relationship…); types
  agreed prefixes into each typeahead facet (geography: US states + major metros;
  industry: the letters that surface the software/health/dental families; titles:
  the CXO family) — the target list is agreed with the operator **before** the session
  and written in the run record.
- Teardown archives everything; the harvester then runs offline: classify bodies by
  endpoint, extract `(facetType, id, displayValue)` rows, write vocabulary with
  provenance = this run's archive ids. Re-runnable against the same archives
  idempotently.

## Decisions this task must land (D440–D449)

1. **Spend accounting for operator-driven searches.** Each operator interaction that
   fires `salesApiLeadSearch`/`AccountSearch` is a real metered search LinkedIn served.
   Settle: counted as ledger `search_page` lines under this capability (recommended
   direction — the ledger's job is honesty about account exposure, not blame), with the
   session paced/kept short accordingly. Typeahead requests are not search pages;
   whether they cost anything is itself a measurement to record.
2. **Two drivers, one tab.** D10's rule exists to prevent two *automations* colliding.
   Here the capability deliberately stops driving before the human starts, and resumes
   only at teardown. Record the boundary explicitly (capability navigates → announces →
   never sends another input event until teardown) as the sanctioned exception shape,
   or reject the worker-tab design in favor of an operator-tab observation mode if
   review finds the boundary unenforceable — decide, don't drift.
3. **Operator-private vocabulary scope** (lists, personas, CRM facets): stored
   operator-scoped, never committed, never in fixtures.
4. **The typing grant question.** After harvesting: is coverage sufficient for the
   audiences the venture actually targets? If gaps remain structural (arbitrary future
   geos), write the `[DECISION NEEDED]` with the D409 four-part analysis over the
   *measured* typeahead controls and endpoints. Do not implement ahead of any grant.

## Constraints

- The capability's zero-interaction claim is pinned: its receipt states inputs sent
  (must be 0 after navigation), and the run record separates "capability did" from
  "operator did" (RECORDING.md).
- No harvesting from the operator's *personal* Chrome, ever — the session runs in the
  automation profile's worker tab or not at all.
- Third-party names: typeahead suggestion display values for **taxonomy** facets (geos,
  industries, seniorities, titles) are vocabulary, not third-party personal data — but
  CURRENT_COMPANY/CONNECTION_OF suggestions surface real entities tied to the operator's
  graph; harvest taxonomy facets only unless a decision says otherwise.
- Challenge mid-session: normal rules — screenshot, exit 2, stop; the operator stops
  interacting immediately.

## Deliverables

Archived session(s); endpoint map for typeahead/option fetches (names, shapes, when
fired) in `FILTER-MAP.md`; vocabulary rows per facet with counts on the STATE.md line;
harvester + tests (offline, against the session's archives); the four decisions above;
the typing-grant `[DECISION NEEDED]` if warranted.

## Acceptance criteria

- Vocabulary lookup answers the venture's real composition questions: "United States",
  at least 10 US states/metros, the software + dental industry ids, full headcount and
  seniority enums, the CXO title family — each row auditing back to a named archive.
- Suite green, typecheck clean; harvester idempotent (second run adds 0 rows).
- Ledger reflects the session per decision 1; capability-initiated loads ≤ 4.
- Zero interactions by the capability, stated on the receipt and consistent with the
  event log.
