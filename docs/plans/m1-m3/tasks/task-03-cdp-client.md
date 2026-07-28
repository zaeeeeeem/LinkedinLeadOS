# Task 3 — CDP transport client

**Model:** Opus · **Depends on:** Task 1 · **Spec:** §2 D7/D8, §3

## Objective

A minimal CDP transport: one WebSocket connection carrying request/response pairs and
protocol events. Transport only — it knows nothing about tabs, LinkedIn, or capabilities.

## Why it matters

Every byte to and from Chrome flows through this. A race bug here (mismatched reply,
leaked pending promise, event delivered after unsubscribe) is silent and poisons
everything above it. This is why it is an Opus task despite its small size.

## Constraints

- Production code uses Node's built-in `WebSocket` client. No Playwright, no
  puppeteer, no CDP wrapper library (D7 — those enable the exact attach surface D8
  forbids). A server-side WebSocket library is acceptable as a **dev dependency only**,
  to run a fake CDP server in tests.
- The client never enables any CDP domain itself. Callers decide what to enable.
- Every failure mode maps to the Task 1 error type with a transient class: connect
  failure, per-command timeout, protocol error reply, connection death.

## Deliverables

- Connect to a CDP WebSocket URL with a bounded connect timeout.
- Send a command (optionally scoped to a `sessionId`) and get its matching reply;
  per-command timeout; protocol `error` replies become rejections.
- Subscribe/unsubscribe to protocol events (messages without an `id`), preserving
  `sessionId` on delivery — the network tap depends on that.
- Detect connection death (close, keepalive failure) and reject all pending sends;
  expose a dead flag; a keepalive that stays quiet while traffic is flowing.
- Clean close that stops timers and rejects nothing spuriously.

## Acceptance criteria

Offline tests against a fake CDP server prove at minimum: matched request/response
resolution; protocol-error rejection; command timeout; event fan-out that stops after
unsubscribe; pending sends rejected and dead flag set when the server drops; connect
failure to a dead port. All pass; typecheck clean; no LinkedIn or real Chrome involved.
