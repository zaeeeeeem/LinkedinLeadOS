# CONTEXT — read this first, every M6 task

**`docs/plans/m5-l2-salesnav/CONTEXT.md` applies in full**, and through it m1-m3 and m4.
All eight M5 rules still bind: search-page scarcity, the paged-run spend order, the
defended surface, the two granted clicks and only those, search rows never minting
entities, third-party names off receipts, labeled bodies proven before relied on, the
reference worker as parts donor.

Then read, as always: `CLAUDE.md`, the spec (§9 L2 + "The filter self-test loop"),
`DECISIONS.md`, `STATE.md`, your task file, and the actual source of every module you
consume — for M6 that almost always means `src/capabilities/salesnav.leads.list/` and
`salesnav.accounts.list/` (the URL handling and session-pin code you must not fork),
`src/core/paged/`, `src/core/budget/`, and `src/capabilities/salesnav.probe/`.

## The M6 rules — what the self-test loop adds

**1. The builder never invents an id. Ever.**

This is the truthfulness rule wearing a new coat. Every `(type, id)` pair `filters.build`
emits must resolve to a vocabulary row whose provenance names a captured body or an
archived request URL. An id from memory, from another LinkedIn tool's docs, from a blog
post, or from "industry 4 is probably Software" is **forbidden even when it would work** —
an unverifiable id that happens to match today is drift waiting to mis-target an audience
silently. No vocabulary row → `build` refuses with the missing term named, and the answer
is more harvest (Task 43), raw text where measured as supported, or asking the operator.
`build` never guesses and never falls back silently.

**2. Build is pure; apply is the only spender; the loop is the agent.**

`build` makes zero requests — it must be provably runnable offline forever (parser-grade
tests, no network import anywhere in its dependency graph). `apply` spends exactly 1 page
load + 1 search page per invocation, through the ordinary budget ledger with its own
sub-cap, and reads **page 1 only** — pagination belongs to `leads.list`/`accounts.list`.
The iterate-until-converged behavior lives in the agent session driving the CLI, not in
any capability: no capability loops applies internally, so a runaway loop is structurally
impossible rather than merely capped.

**3. Verification reads the wire, not the wish.**

`apply`'s verdict compares three things, all captured: the URL the builder emitted, the
**request URL the UI actually issued** for `salesApiLeadSearch`/`salesApiAccountSearch`,
and the response body's own `paging`. The address bar is known to lie on this surface
(D413); the render is not consulted. Every filter in the spec is reported **honored /
rewritten / dropped**, and a dropped or rewritten filter is a loud non-zero-warning
verdict, never a silently smaller audience. Zero results is a *finding* (exit 0, count 0),
not a failure; a request that never fired is exit 5 with the archive named.

**4. Percent-encoding is load-bearing grammar.**

D412 was found by one `%` in a base64 session id. The query grammar nests `()`, `,`, `:`
inside a URL parameter, ids may contain characters the encoder must not double-encode, and
`text:` values carry spaces and unicode. The builder owns one encoder and one decoder,
round-trip-tested against **every** archived measured URL byte-for-byte, plus adversarial
cases (commas in text values, `+` in ids, unicode). No capability hand-assembles a query
string outside the builder.

**5. The harvest session observes; the human drives.**

Task 43's capability opens the worker tab, navigates once, and then **takes no action** —
no click, no keystroke, no scroll — while the operator works the filter bar by hand.
Everything else is the ordinary tap: raw-first archive, challenge gate, receipts with
counts only. The operator's interactions will trigger real metered searches; those are
counted honestly (the task settles how, in its decision range) — over-count before
under-count, as always. The session's captures are the **only** sanctioned source of
typeahead and dropdown vocabulary until an explicit D470+ grant says otherwise.

**6. This surface's chrome is a minefield of L3 writes — inventory before touching.**

"Save search", "Create lead list", bell icons, and every result row's own controls sit
centimetres from the filter panel. M6 tasks never click them, never focus them, and the
harvest task's receipt states that the *capability* performed zero interactions so the
record is explicit about who did what. If the operator's own hand saves a search during a
harvest session, that is the operator's act on their own account — note it in the run
record, do not undo it, do not repeat it.

**7. The catalog is pinned and drift is a verdict, not a surprise.**

The promoted `salesApiSearchFilterLayout` fixture pins the 46-type body catalog and separately
reports its 44 request-emittable types (D423): per-vertical
type sets, `rawTextSupported`, `exclusionSupported`, presentation types. The builder
validates specs against it. Because the live body arrives free on every search page load,
`apply` re-checks the catalog hash opportunistically and reports
`FILTER_CATALOG_DRIFT` when LinkedIn's schema moves — exit stays honest (5 if the drift
breaks the run's own claim, warning otherwise). A drifted catalog is re-promoted from the
new archive offline, never patched by hand.

**8. Convergence is arithmetic on measured counts, with named bands.**

The loop tightens or loosens a spec against `paging.total`. The bands (too big / target /
too small), which knobs the agent may turn between iterations, and the iteration budget
per session are **written numbers in Task 45**, not vibes. Two measured facts bound the
logic: LinkedIn caps result *access* well below large totals (the M5 pager showed 660
total / 25 per page; access limits beyond that are unmeasured — treat as unknown, record
what the gate observes), and `paging.total` is an estimate LinkedIn may round — the loop
targets bands, never exact numbers.

## Choosing live targets

Apply-probe and gate specs are composed from harvested vocabulary and target audiences the
operator would genuinely use (the CXO/software persona from M5 is the natural seed — its
ids are already in archived URLs). Never compose a spec around a named individual; never
target an audience whose rows the operator would mind sitting append-only in
`search_results`. Keep every live step at its minimum: one page proves an echo; one loop
proves the loop.
