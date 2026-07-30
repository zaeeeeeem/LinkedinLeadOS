# Task 12 — Capability registry, CLI, and `health.check` — M1 gate

**Model:** Opus · **Depends on:** Tasks 1–11 · **Spec:** §3, §4.4–4.5, §8 (session preflight), §11 M1

## Objective

The integration layer: a typed capability definition, a registry the CLI is generated
from, the universal flags, the session preflight, and a first no-op capability that
proves the whole L0 stack live.

## Why it matters

First moment all eleven pieces run together against real Chrome. Needs whole-system
reasoning: lifecycle ordering, teardown on every path, and the guarantee that adding a
future capability means adding one directory with zero hand-written CLI wiring.

## Constraints

- A capability declares: name, risk class, an args schema (validated before anything
  runs), a cost estimate function, whether it needs the browser, and its run function
  receiving a prepared context (run context, session, tab, tap, input, budget). The
  spec's §3 sketch is the intent; the exact shape is yours to design well.
- The CLI is generated from the registry — one subcommand per capability, plus a listing
  command whose JSON manifest (name, risk, cost, args schema) is how a context-less
  agent rediscovers the toolkit (§4.5).
- Universal flags from §4.4 behave identically for every capability: resume by run id,
  dry-run (plan + cost estimate, **zero** LinkedIn requests), field projection into the
  receipt, skip-store, and a budget cap that can only lower limits.
- Session preflight in spec §8 order: Chrome up → CDP reachable → logged in (else exit
  4) → budget available (else exit 7) → tab lease acquired. Fail fast with the right
  exit code rather than half-running. Login state must be determined within D1/D8
  limits — no forged requests, no extra CDP domains.
- The tab lease never expires on age (D16), so a crashed run whose pid gets recycled by
  an unrelated process wedges the tab with no way out but deleting the file by hand. The
  CLI must expose the remedy: a lease inspection in the listing/health surface and a
  `--force-release` that drops the lock after showing the operator whose it is.
- Every exit path — success, any failure class, crash — emits exactly one receipt on
  stdout and releases the lease and tab. No leftover tab, ever.
- `health.check` exercises the stack without touching LinkedIn: launch/reuse Chrome,
  worker tab on a neutral page, log events, write and persist a receipt, tear down.
  Give it a README (per RECORDING.md).

## Deliverables

Registry + definition helper, argv/flag parsing, the CLI entrypoint, preflight, and
`health.check`. Offline tests for: registration and manifest content, args-schema
rejection, flag parsing, and dry-run making zero network calls. Live verification for
the rest.

## Acceptance criteria

- Offline tests pass; typecheck clean.
- **M1 gate, live:** running `health.check` through the real CLI twice (once with
  Chrome down, once with it already up) produces ok receipts with correct
  launched/reused evidence, exit 0, events on disk, no consent dialog, no leftover tab,
  operator's window untouched. The listing command returns the manifest.
