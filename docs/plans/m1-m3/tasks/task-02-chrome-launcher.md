# Task 2 — Chrome launcher and endpoint discovery

**Model:** Opus · **Depends on:** Task 1 · **Spec:** §2 D9

## Objective

A module that guarantees the automation Chrome is running and returns a usable CDP
browser WebSocket URL — reusing an already-running instance, launching one when absent.

## Why it matters

Attaching to the wrong Chrome would drive the operator's personal logged-in session.
Port separation (9223 automation vs 9222 personal) is what makes that impossible, and
this module is where that separation is enforced.

## Constraints

- Discovery is `GET http://127.0.0.1:<port>/json/version` → `webSocketDebuggerUrl`,
  nothing else. The bare `/devtools/browser` path and the `DevToolsActivePort` file are
  both forbidden — Chrome 151 rejects the former, the latter is unreliably written (D9).
- Default port 9223 and profile `~/.linkedin-os/chrome-profile` are constants of this
  module. Nothing anywhere may default to 9222.
- Launch must be detached (survives the CLI process) and must produce **no consent
  dialog** — that is what the launch-flag path exists to avoid.
- Failures raise the Task 1 error type with a transient failure class and a retry-capable
  action, so callers can back off without special-casing this module.

## Deliverables

- Discovery: given a port, return the browser WebSocket URL or throw; plus a cheap
  "is Chrome up on this port" probe.
- Launcher: ensure Chrome is available on the automation port — reuse or launch, wait
  bounded time for the endpoint, report whether it launched or reused.
- Offline tests for discovery against a local fake `/json/version` HTTP server: success,
  dead port, malformed response. The launcher's spawn path is not unit-tested — it is
  verified live.

## Acceptance criteria

- All tests pass offline; typecheck clean.
- Live check (needs sandbox-disabled Bash for loopback): calling the launcher yields
  `port 9223` and a `ws://127.0.0.1:9223/devtools/browser/…` URL, whether Chrome was
  already running or not, with no dialog and without touching port 9222.
