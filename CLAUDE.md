# LinkedinLeadsOS — Operating Manual

> Read at the start of every session, before anything else.
>
> **This project has no relationship to the parent `StartupStruggle/` directory or its
> dentist landing-page venture.** It only lives there so all projects sit in one place.
> Ignore `../CLAUDE.md` entirely. This file governs everything under `LinkedinLeadsOS/`.

## What this is

A TypeScript toolkit that lets a coding agent read LinkedIn end to end — profiles, companies,
posts, jobs, and Sales Navigator searches — with **no human in the loop**. It drives the
operator's own logged-in Chrome over CDP.

A library of pure capability functions plus a thin CLI. Not a server, not a queue, not an MCP
server. Those can be layered on later without touching the core.

## The hard constraint

There is exactly **one** LinkedIn account and it cannot be burned.

Every design decision that looks paranoid exists because of this. When a trade-off is between
speed and account safety, safety wins — do not re-open that argument.

## Current phase

**M1 — core skeleton.** Nothing is implemented yet. The design is approved and frozen at
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

Check `STATE.md` for what is actually built right now. Trust `STATE.md` over this line.

## Scope

**In:** L0 session and infrastructure · L1 cheap reads · L2 metered searches.

**Out, and not up for debate this phase:** all L3 writes (connect, message, comment, react,
follow, post, endorse, profile view) · L4 intelligence (ICP scoring, signal detection,
drafting) · L5 orchestration (campaigns, sequences, schedulers) · MCP surface · notifications
· multi-account · hosted execution.

## Non-negotiable rules

- **Network tap is the source of truth.** Data fields come from captured Voyager /
  `salesApi*` response bodies, never from parsed HTML. DOM reads are for navigation,
  pagination state, challenge detection, and render confirmation only.
- **Never forge a request LinkedIn's own UI did not already issue.** No direct Voyager calls
  with the session cookie, however tempting.
- **Raw first.** Archive the untouched response body before parsing anything. Parsed rows are
  a projection, never the only copy.
- **Never `Runtime.enable` or `Page.enable`.** `consoleAPICalled` is the classic CDP detection
  leak. Enable `Network` only.
- **Parsers are pure and tested offline against fixtures.** A parser change must be provable
  with zero LinkedIn requests.
- **The budget ledger cannot be bypassed by a flag.**
- **Challenges are never solved automatically.** Screenshot, checkpoint, exit 2, stop.

## Conventions

- Receipt on stdout, bulk data in Supabase. Never print large results.
- Exit codes carry the failure class: `0` ok · `2` challenge · `3` rate-limited · `4` auth
  dead · `5` parse drift · `6` transient · `7` budget exhausted.
- One capability = one directory under `src/capabilities/`, holding `index.ts`, `parse.ts`,
  `parse.test.ts`, `README.md`.
- Dates are absolute (`2026-08-07`), never "today" or "last week".
- Chrome runs on the dedicated profile at `~/.linkedin-os/chrome-profile`, launched with
  `--remote-debugging-port=9223`. Never attach to a `chrome://inspect` opt-in session, and
  never touch port 9222 — that is the operator's personal Chrome.

## Recording system

Write it down the moment it happens. Do not trust memory across sessions.

| File | What goes here | When |
|---|---|---|
| `CLAUDE.md` | This file — what it is, phase, rules, index | When phase or a rule changes |
| `DECISIONS.md` | Why X over Y, dated, append-only | The moment a real decision is made |
| `STATE.md` | Built / in progress / next | **At every checkpoint**, not at session end |
| `BACKLOG.md` | Deferred work + the approach settled at capture time | When something is punted with a known plan |
| `docs/specs/` | Approved designs | Per design cycle |
| `docs/capabilities/` | One contract doc per capability | When a capability is added or changed |

`STATE.md` is updated at every checkpoint specifically so a session that dies mid-task still
leaves an accurate state file behind.

## Reference, not a base

`/Users/talhat/Claude/Projects/OwnexLabsSales/dashboard/worker` is an earlier, partly working
scraper. It is a **parts donor, not a foundation** — read it, rewrite typed, never import it.

Worth taking: `engine/cdp.mjs` (human cursor paths, wheel notches, passive response capture,
focus emulation), `engine/page-scripts.mjs` (DOM navigation helpers), and the pagination and
resume logic in `engine/run-scrape.mjs`.

## Environment gotcha

Discover the CDP endpoint with `GET http://127.0.0.1:9223/json/version` and use its
`webSocketDebuggerUrl`. Do **not** hardcode the bare `/devtools/browser` path — Chrome 150
accepts it, Chrome 151 rejects it, and the automation profile runs 151. Do not rely on the
`DevToolsActivePort` file either; it is not reliably written.

(For context: the HTTP endpoints 404 on the operator's personal Chrome because it enabled
debugging via `chrome://inspect`. They work normally on the launch-flag profile.)

Claude Code's Bash sandbox blocks loopback TCP — probing CDP from Bash needs the sandbox
disabled for that call.

## Index

- Approved design → `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`
- What's built → `STATE.md`
- Why we did something → `DECISIONS.md`
- Deferred with a known approach → `BACKLOG.md`
- Capability contracts → `docs/capabilities/`
