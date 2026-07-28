# Task 9 — Network tap

**Model:** Opus · **Depends on:** Tasks 3, 4, 6, 7 · **Spec:** §2 D1/D2

## Objective

The passive capture layer everything rests on (D1): watch the worker tab's own network
traffic for URL patterns, and when a watched response completes, read its body out of
Chrome and archive it raw. We never issue a request — we read what the page fetched.

## Why it matters

The tap silently missing a response **is the whole product failing** — the capability
above it reports "nothing captured" on a page that rendered fine. The failure modes are
all timing: body requested before the response finished loading, buffer evicted, events
arriving out of order, response for a request the tap saw too late.

## Constraints

- Purely passive: subscribe to the network events the enabled `Network` domain already
  emits, correlate response metadata with loading completion per request id, and only
  then fetch the body. Getting the body before the resource finished loading returns
  incomplete data or errors — sequence deliberately.
- Every captured body goes through the Task 7 archive **before** the tap hands it to
  anyone (D2).
- Scope to the worker tab's session — traffic from other targets must not leak in.
- A watched pattern that never arrives must resolve into a bounded-wait failure (Task 1
  error type, transient), not a hang. A body fetch that fails (evicted buffer) is a
  recorded miss, not a crash.
- Capture hits and misses are logged as events (Task 6) so `log:why` can answer "what
  did we see on this page".

## Deliverables

A tap that can: register watch patterns, start/stop listening, expose everything
captured so far, and await the next capture matching a pattern with a timeout. Offline
tests drive it with a fake CDP client emitting synthetic protocol event sequences,
covering at minimum: a watched response captured and archived; an unwatched one
ignored; out-of-order finish/response sequences; body-fetch failure recorded as a miss;
wait-for resolving on match and failing at timeout; stop actually stopping.

## Acceptance criteria

All tests pass offline; typecheck clean. Real-traffic behavior is proven later by
Task 15's live capture, not here.
