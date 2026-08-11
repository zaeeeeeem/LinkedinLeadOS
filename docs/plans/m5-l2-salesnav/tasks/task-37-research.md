# Task 37 research checkpoint — 2026-08-11

## What this repo already proves

The closest operator-owned-data readers are `feed.get`, `inbox.list`, and
`inbox.thread`. Their probe-and-capability pattern is: spend before navigation,
watch broadly enough to expose endpoint drift, archive raw bodies and the
snapshot, classify challenges, then parse only archived bytes. When a labeled
body exists it wins; a missing labeled body is visible rather than silently
treated as an empty list. The parser is injected behind the capture composition
so its refusal, privacy, and bounds can be proved offline.

Task 37 should use that composition with one important simplification: saved
search fields have no DOM exception, so a labeled body is mandatory. A default
run should return counts plus bounded saved-search rows; no search result row is
opened or parsed, and storage stays archive-only until the operator settles the
separate `searches`-row timing question.

## What the reference worker did

The reference worker has no saved-search-list implementation. It starts from an
already-open `linkedin.com/sales/search` tab and reads lead cards from the DOM.
That avoids discovering how the saved-search panel is reached, but cannot meet
this task's objective. Its broader Sales Navigator lessons still apply: it uses
human input and paced page turns, but it also hard-codes port 9222, trusts DOM
cards where this repo measured labeled search bodies, and has no raw-first
saved-search contract. It is therefore evidence for pacing, not a parser or
navigation donor here.

## Better way now, and the blocker

The archived `/sales/` snapshot from run `01KZP61QK0N7CMNJ38PFTB8PSC` contains
one `Saved searches` control. It is a `button` with
`data-x--link--saved-searches` and has no `href`; none of that run's captured
network bodies contains a saved-search payload. LinkedIn's current help likewise
instructs the operator to click Saved Searches from the homepage:
<https://www.linkedin.com/help/sales-navigator/answer/a106022>.

A guessed deep link would cost fewer implementation lines but would violate
D357's UI-produced-url rule and could measure a route this build never offers.
Reusing `salesnav.probe` on `/sales/` is safer but cannot reveal the panel's
request, because the panel is not opened. The evidence-backed route is one
bounded, resolved-or-refused, trusted click on exactly that control, then passive
capture of the UI-issued response. Its cost is a new operator grant and a click
resolver specific to this control; its benefit is that the request is genuinely
UI-produced and the first fixture comes from a real load.

## Choice

Stop before code or live contact. D400 says the only toolkit click is a
pagination control, so Task 37 cannot lawfully open the measured saved-search
panel today. Do not write a parser before that real fixture exists (D152), and do
not synthesize an unmeasured route.

**[DECISION NEEDED]** Grant or refuse one additional click class: the unique,
enabled `button[data-x--link--saved-searches]` on `/sales/`, resolved or refused,
clicked through `HumanCursor`, with no descendant clicks. Recommendation: grant
that exact control only; it reads the operator's own data, creates no third-party
state, and is the only measured path to the list.

The later storage decision remains separate: recommend archive-only at list time
and mint `searches` rows at first execution, when Task 39/40 can bind the saved
search to a real run and Task 38's migration contract is present. Receipt labels
should be allowed because they are the operator's own words and the identifier
needed to choose a search; third-party result names remain forbidden.
