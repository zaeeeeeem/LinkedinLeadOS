---
name: linkedin-session
description: Use when starting any work that touches LinkedIn through this toolkit — before running any capability, when a session begins, when unsure about budgets, exit codes, invocation syntax, or what is allowed. The other skills (build-lead-list, research-lead, monitor-account, recover-session) assume this one has been read first.
---

# LinkedIn Session — Foundation

This toolkit reads LinkedIn through the operator's own logged-in Chrome over CDP. There is
exactly **one** LinkedIn account and it cannot be burned. Everything below exists to protect
it. You decide *what* to read and *why* — your strategy is yours; these are the rails it
runs on.

## Invoking capabilities

```sh
npm run cap -- <capability> --flag=value          # normal form
./node_modules/.bin/tsx src/cli/index.ts <capability> --flag=value
```

Every value is `--flag=value` (never `--flag value`). Use the **direct tsx form whenever an
argument carries private filter values or specs** — npm echoes the expanded command line
before the receipt and would print them (D432).

Universal flags on every capability: `--dry-run` (plan only, opens no browser) ·
`--no-store` (capture + parse, skip Supabase) · `--budget=<n>` (lower this invocation's
page-load allowance; can never raise) · `--run-id=<id>` (resume/append an existing run) ·
`--force-release` · `--fields=` · `--help`.

Receipts land on stdout; bulk data lands in Supabase or the run archive. Never print bulk
results, third-party names, or message text.

Query stored rows through the local Supabase (`npm run db:start` if it's down):

```sh
docker exec -i supabase_db_linkedinleadsos psql -U postgres -d postgres -c "select ..."
```

Verify a run's writes with an independent query like this, not by trusting the receipt.

## Preflight

1. `npm run cap -- health.check` — **zero cost**, touches no LinkedIn page. It proves the
   whole L0 stack: Chrome up, CDP answering, login cookie present, tab lease free, and it
   reports the current budget window counts under `data.budget`. Run it first in a session
   and whenever another capability fails for reasons its receipt can't explain.
2. Chrome runs on the dedicated profile `~/.linkedin-os/chrome-profile` with
   `--remote-debugging-port=9223`. Discover CDP via `GET http://127.0.0.1:9223/json/version`
   and use its `webSocketDebuggerUrl` — never hardcode `/devtools/browser`, never touch
   port 9222 (that is the operator's personal Chrome). Claude Code's Bash sandbox blocks
   loopback TCP; probing CDP from Bash needs the sandbox disabled for that one call.

## The budget ledger

Append-only at `runs/budget.ndjson`. **No flag bypasses it.** Three spend kinds:
`page_load`, `search_page`, `profile_open`.

- Global (§8): **60 page loads/hour · 400/day · 50 search pages/day · 120 distinct
  profiles/day**, shared across all capabilities.
- Per-capability daily sub-caps on top (default: 150 page loads / 25 search pages /
  60 distinct profiles; each capability's README states its own — e.g. `profile.get`
  200/0/90, `salesnav.filters.apply` 10/10/0). A refusal is exit 7 and its `evidence`
  names which cap bit (`"scope":"global"` vs `"scope":"capability"`).
- Distinct-profile spend is deduped per day: re-reading the same person costs no second
  `profile_open`.
- Raising any cap requires a fresh, dated operator grant recorded in DECISIONS.md. Never
  edit `src/core/budget/constants.ts` on your own; a past grant never carries over.

Plan spend before a batch: read `data.budget` from `health.check`, count what your plan
costs (each capability README states its per-invocation cost), leave headroom.

## Exit codes — what each one means you do next

| exit | class | your move |
|---|---|---|
| 0 | ok | continue (0 results is a finding, not a failure) |
| 1 | usage | fix the argument; nothing was spent unless the receipt says so |
| 2 | challenge | **stop everything.** Screenshot + checkpoint are already saved. Tell the operator. Never solve or retry |
| 3 | rate-limited | stop the whole session, not just this capability. No probing "to check" |
| 4 | auth dead | stop; operator must log in manually on the automation profile |
| 5 | parse drift | LinkedIn changed shape. The raw archive has the evidence; fix the parser **offline** (see recover-session) |
| 6 | transient | one retry, then treat as real |
| 7 | budget | wait for the window; never work around it |

## Hard rules (digest — CLAUDE.md is authority)

- Data comes from captured network bodies. Five named DOM exceptions exist (profile, job,
  post, feed, inbox readers) — already built in; you never add one.
- Never forge a request LinkedIn's UI didn't issue. No direct Voyager calls with the cookie.
- Exactly two granted clicks exist (results pager, Saved-searches button) — already built
  in. Anything that would notify a third party (connect, message, react, follow, save) is
  an L3 write: out of scope, stop and ask, no exceptions.
- Raw response bodies are archived before parsing; parsers are pure and fixed offline
  against fixtures, zero live requests.
- When speed and account safety conflict, safety wins. Don't re-open that argument.

## Introspection is free

The `log.*` family costs nothing and reads only local files:
`log.runs --since=24h` (what ran) · `log.errors --run=<id>` (what went wrong) ·
`log.why --run=<id> --item=<ref>` (one item's full story) · `log.drift --since=7d` (which
parsers are decaying). Reach for these before re-spending page loads to re-observe
something a past run already observed.

## Record as you go

Real decision made → `DECISIONS.md` (dated, append-only). Checkpoint reached →
`STATE.md`. A click taken under the D409 standing test → named on the receipt **and**
written to DECISIONS.md the same session. Deep contract per capability:
`src/capabilities/<name>/README.md` — when this skill and a README disagree, the README
wins.
