# LinkedIn Toolkit — L0/L1/L2 Design

**Date:** 2026-08-07
**Status:** approved design, not yet implemented
**Scope:** L0 (session & infrastructure), L1 (cheap reads), L2 (metered searches). L3 writes,
L4 intelligence, and L5 orchestration are explicitly **out of scope** for this spec.

---

## 1. Purpose

A TypeScript toolkit that lets a coding agent read LinkedIn — profiles, companies, posts,
jobs, and Sales Navigator searches — end to end, with no human in the loop, driving the
operator's own logged-in Chrome over CDP.

The toolkit is a library of pure capability functions plus a thin CLI. It is not a server,
not a queue, and not an MCP server. Those can be layered on later without touching the core.

### Hard constraint

There is exactly **one** LinkedIn account and it cannot be burned. Every design decision
below that looks paranoid exists because of this constraint. When a trade-off is between
speed and account safety, safety wins without discussion.

---

## 2. Decisions

Recorded here, mirrored into `DECISIONS.md` as they are made.

### D1 — Network tap is the source of truth; DOM is for navigation only

LinkedIn's pages fetch Voyager / `salesApi*` JSON to render themselves. We let the page
fetch what it was always going to fetch, then read the body out of `Network.getResponseBody`.

- We never issue a request LinkedIn's own UI did not already issue.
- No data field is ever sourced from parsed HTML.
- DOM reads are permitted **only** for: locating click targets, reading pagination state,
  detecting challenges, and confirming render completion.

Rejected: DOM parsing as source of truth (obfuscated rotating class names, A/B variance,
incomplete behind "see more"). Rejected: forging Voyager requests directly with the session
cookie (fastest and most complete, but produces request patterns with no matching page
render — the loudest available detection signal).

### D2 — Raw-first storage

Every capture writes the untouched response body to an archive **before** any parsing.
Parsed rows are a projection of the archive, never the only copy.

Consequence: a wrong parser is fixed by re-parsing history, never by re-scraping. On a
single unburnable account, not having to re-scrape is worth more than the storage cost.

### D3 — Receipt on stdout, data in the store

Capability stdout is a fixed-size envelope (~200 tokens) regardless of result size. Bulk
data goes to Supabase and to the run archive. The agent reads the receipt, then queries
Supabase directly when it needs rows.

Rejected: printing full results to stdout (a 25-lead page is 30–50k tokens; a 10-page crawl
blows a context window on one call).

### D4 — Agent reads bulk data straight from Supabase

No read-command wrapper layer. The agent runs SQL. Full power, no extra code to maintain.
Accepted risk: the agent can write a query that returns more than it needed. Mitigated by
documenting query recipes in the capability docs, not by restricting access.

### D5 — Structured NDJSON logs plus bounded query capabilities

Logs are machine-readable event streams, not prose. The agent never reads a whole log file;
it calls `log:why` / `log:errors` / `log:drift`, which each return a bounded slice.

### D6 — `HALT_AND_NOTIFY` exits non-zero and stops

No desktop notification, no Slack, no file drop. Notification is out of scope. The agent
surfaces the non-zero exit and its receipt to the operator and does not proceed.

### D7 — Playwright is not used against the production account

Raw CDP only on the tab driving the real account. `connectOverCDP` enables `Runtime`,
`Page`, `DOM`, `Log`, and `Performance`, installs `Runtime.addBinding` and
`Page.addScriptToEvaluateOnNewDocument`, and creates a per-frame utility world — exactly the
surface this design avoids. Playwright may be used later against a throwaway profile for
structure discovery; that is out of scope here.

### D8 — Minimal CDP attach surface

Enable `Network` only. Do not send `Runtime.enable` (`consoleAPICalled` is the classic CDP
detection leak) or `Page.enable` (`captureScreenshot` does not require it). Carried forward
from the existing worker, which established this deliberately.

### D9 — Dedicated Chrome profile launched with `--remote-debugging-port`

The toolkit never attaches to Chrome opted in via `chrome://inspect`. That path shows a
once-per-Chrome-session **"Allow remote debugging?"** consent dialog, which puts a human back
in the loop on every browser restart, and it has HTTP discovery endpoints disabled (Chrome 150
returns 404 on `/json`, `/json/version`, `/json/list`).

Chrome is instead launched by the toolkit:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome \
  --remote-debugging-port=9223 \
  --user-data-dir="$HOME/.linkedin-os/chrome-profile" \
  --no-first-run --no-default-browser-check
```

**Port 9223, not 9222.** The operator's daily-driver Chrome holds 9222 via the
`chrome://inspect` toggle. Rather than depend on that being switched off, the automation
profile takes its own port and the two coexist. Attaching to the wrong Chrome would drive the
operator's personal session — the port separation makes that impossible.

**Endpoint discovery is `GET /json/version` → `webSocketDebuggerUrl`.** Verified 2026-08-07:
the bare path `ws://host:port/devtools/browser` is accepted by Chrome 150 but **rejected by
Chrome 151**, which the automation profile runs. The `DevToolsActivePort` file is also not
reliably written — it was absent while the port was live. HTTP discovery is the only path
that works on the launch-flag profile, and it works there precisely because the flag path
does not disable those endpoints.

Verified 2026-08-07: this launch shows no consent dialog, `/json/version` responds normally,
and `Storage.getCookies` confirms `li_at` present with a 2027-08-07 expiry.

The LinkedIn and Sales Navigator session is moved into this dedicated profile by **logging in
manually, once**. Cookies are not copied from the daily-driver profile — one manual login on
the same machine and IP is unremarkable to LinkedIn; a session cookie materializing in a fresh
profile is not.

Side benefit: the automation profile is isolated, so ordinary browsing cannot interfere with a
run and a run cannot disturb ordinary browsing.

Preflight starts Chrome if it is not already running on the debug port, and reuses it if it is.
Chrome's own version will move underneath us — nothing may depend on version-specific behavior.

### D10 — One resident worker tab, navigated between targets

Capabilities own their tab entirely. Given a URL, the toolkit opens what it needs; the operator
never pre-opens anything.

Shape: `Target.createTarget { url, background: true }` once per session, then `Page.navigate`
between targets, closed at session end. Rejected: a tab per item — 120 profiles/day is 120
open-close cycles and a cold render each time; one tab moving between profiles is what a human
reading them looks like.

`background: true` keeps the operator's window from being yanked mid-run. Focus emulation
(D8, `Emulation.setFocusEmulationEnabled`) must be asserted on the tab immediately after
creation: a background tab has its timers clamped and never fires `IntersectionObserver`, which
is precisely how LinkedIn lazy-renders. The existing worker measured a 7×`setTimeout(120)` loop
taking 43.9s instead of 0.9s in this state.

This is also why the tab lease (§8) is single-holder — there is one worker tab by construction.

---

## 3. Architecture

```
                        cap CLI  (thin, one subcommand per capability)
                            |
                     capability registry  ──►  manifest (cap list --json)
                            |
   ┌────────────────────────┴───────────────────────────┐
   │                   capabilities                     │
   │   L1 readers            L2 searches                │
   └────────────────────────┬───────────────────────────┘
                            |
   ┌────────────────────────┴───────────────────────────┐
   │                       core (L0)                    │
   │  session · tab lease · foreground · human input    │
   │  network tap · run context · events · budget       │
   │  challenge detector · archive · supabase           │
   └────────────────────────────────────────────────────┘
                            |
                  CDP  ws://127.0.0.1:9222/devtools/browser
                            |
                  operator's real logged-in Chrome
```

Every capability is an async function with the same shape:

```ts
type Capability<Args, Data> = {
  name: string;                        // "profile.get"
  risk: "read-cheap" | "read-metered";
  cost: (args: Args) => CostEstimate;  // page loads, search credits
  args: ZodSchema<Args>;
  run(ctx: RunContext, args: Args): Promise<Receipt<Data>>;
};
```

The CLI is generated from the registry. Adding a capability means adding one directory; no
CLI wiring is written by hand.

---

## 4. The contract

### 4.1 Receipt (stdout, success)

```json
{
  "ok": true,
  "run_id": "01JQ7X...",
  "capability": "salesnav.leads.list",
  "counts":   { "requested": 25, "captured": 25, "usable": 23, "skipped": 2 },
  "stored":   { "table": "sn_leads", "run_ref": "01JQ7X...", "rows": 23 },
  "warnings": [{ "code": "PARSE_FIELD_MISSING", "field": "headline", "n": 2 }],
  "cost":     { "search_credits": 1, "page_loads": 3, "elapsed_ms": 48210 },
  "artifacts":{ "events": "runs/01JQ7X.../events.ndjson", "raw": "runs/01JQ7X.../raw/" },
  "next":     "select * from sn_leads where run_ref = '01JQ7X...'"
}
```

### 4.2 Receipt (stdout, failure)

```json
{
  "ok": false,
  "run_id": "01JQ7X...",
  "capability": "salesnav.leads.list",
  "error": {
    "code": "CHALLENGE_PRESENTED",
    "retryable": false,
    "action": "HALT_AND_NOTIFY",
    "evidence": "runs/01JQ7X.../shots/challenge.png",
    "message": "Sales Navigator returned a verification interstitial"
  },
  "partial": { "stored": 12, "resume_token": "page=3;cursor=urn:li:..." },
  "cost": { "search_credits": 1, "page_loads": 2, "elapsed_ms": 21044 }
}
```

`action` is a closed enum, identical across every capability:

| action | agent behavior |
|---|---|
| `RETRY_BACKOFF` | sleep per `retry_after_ms`, retry same run_id |
| `RETRY_ONCE` | retry immediately, once |
| `RESUME` | re-invoke with same run_id, resumes from checkpoint |
| `SKIP_ITEM` | record failure, continue to next item |
| `HALT_AND_NOTIFY` | stop, exit non-zero, do not retry |
| `REAUTH` | session dead; stop, operator must log in |

### 4.3 Exit codes

The agent may branch on the exit code alone without parsing JSON.

| code | meaning |
|---|---|
| 0 | ok |
| 2 | challenge / captcha presented |
| 3 | rate-limited by LinkedIn |
| 4 | auth or session dead |
| 5 | parse drift (response shape changed) |
| 6 | transient (network, CDP, timeout) |
| 7 | local budget exhausted |
| 1 | anything else / usage error |

### 4.4 Universal flags

Accepted by every capability.

| flag | effect |
|---|---|
| `--run-id=<id>` | resume an existing run instead of starting a new one; idempotent |
| `--dry-run` | return the plan and cost estimate; zero LinkedIn requests |
| `--fields=a,b,c` | inline a projection of the data in the receipt, for small results |
| `--no-store` | archive and log but skip the Supabase write |
| `--budget=<n>` | cap page loads for this invocation |

### 4.5 Manifest

`cap list --json` returns every capability with its args schema, output schema, risk class,
and cost function. This is how an agent that lost its context rediscovers the toolkit.

---

## 5. Logging and artifacts

```
runs/<run_id>/
  summary.json        the receipt, persisted
  events.ndjson       one typed JSON object per event
  raw/                captured response bodies, gzipped
  shots/              screenshots at decision points and on every failure
```

Event shape:

```json
{ "ts":"2026-08-07T06:40:12.441Z", "run_id":"01JQ7X...", "seq":142,
  "level":"info", "event":"capture.hit", "phase":"page-2",
  "item_ref":"lead-14", "duration_ms":812,
  "detail": { "url_pattern":"salesApiLeadSearch", "status":200, "bytes":48211 } }
```

`event` comes from a closed set: `cdp.send`, `cdp.event`, `nav.start`, `nav.done`,
`render.wait`, `capture.hit`, `capture.miss`, `parse.ok`, `parse.miss`, `store.write`,
`budget.spend`, `challenge.detected`, `checkpoint.save`, `checkpoint.resume`, `error`.

### Log query capabilities

| command | returns |
|---|---|
| `cap log:why --run=<id> --item=<ref>` | every event for one item |
| `cap log:errors --run=<id>` | failures and counts only |
| `cap log:drift --since=7d` | `parse.miss` grouped by field and capability |
| `cap log:runs --since=24h` | run summaries, one line each |

Each returns a bounded slice. Debugging costs hundreds of tokens, not hundreds of thousands.

### Retention

`raw/` bodies are gzipped. Pruned after 30 days **except** the first successful capture of
each distinct response shape, which is promoted to `fixtures/` and kept forever.

---

## 6. Fixtures and offline testing

`fixtures/<capability>/<shape-hash>.json` holds real captured response bodies, promoted from
run archives.

Every parser is a pure function `(rawBody) => ParsedRow[]` tested entirely against fixtures.
Consequence: an agent can develop and prove a parser fix with **zero** LinkedIn requests and
zero ban risk. This is what makes agentic iteration on this project safe at all.

Fixtures are **not committed**. `fixtures/` is gitignored in full, because captured bodies
contain real prospect data and the operator's own identifiers. The directory is created by
running the toolkit; a fresh clone has no fixtures until it captures some. Parser tests skip
with a clear message rather than fail when a required fixture is absent.

---

## 7. Data model (Supabase, local Docker first)

Identity is LinkedIn's own URN. Never a synthesized key.

- person: `urn:li:fsd_profile:ACwAAA...` — stable across name and vanity-URL changes
- company: numeric company id
- job: job posting id
- post: activity urn

### Tables

| table | holds |
|---|---|
| `runs` | run_id, capability, args, status, cost, started/ended, exit_code |
| `raw_captures` | run_id, url_pattern, status, shape_hash, storage path, captured_at |
| `persons` | urn (pk), vanity, name, headline, location, current_company_urn, first_seen, last_seen |
| `person_experience` | person_urn, company_urn, title, start, end, is_current |
| `person_posts` | urn (pk), person_urn, text, posted_at, reactions, comments |
| `companies` | urn (pk), name, vanity, website, industry, size_range, hq, about, first_seen, last_seen |
| `company_posts` | urn (pk), company_urn, text, posted_at, reactions, comments |
| `company_people` | company_urn, person_urn, discovered_at |
| `jobs` | id (pk), company_urn, title, location, posted_at, workplace_type, description |
| `searches` | search_id, kind (sn_leads/sn_accounts/classic_people/...), filter_url, filter_json, created_at |
| `search_results` | search_id, page, position, person_urn or company_urn, run_ref |
| `budget_ledger` | ts, capability, run_id, page_loads, search_credits |
| `parse_drift` | ts, capability, field, shape_hash, n |

Entity tables are upserted on urn with `last_seen` bumped. `search_results` is append-only —
the same lead appearing in two searches is two rows, one entity.

### Freshness

Each entity row carries `last_seen`. Capabilities take `--max-age=<duration>`; if a row is
fresher than that, the capability returns it from the store and spends zero page loads. This
is the single largest saving available and it is on by default with a 7-day window.

---

## 8. Safety model

### Budget ledger

Enforced locally, before any request leaves the machine.

| limit | default |
|---|---|
| page loads / hour | 60 |
| page loads / day | 400 |
| Sales Nav search pages / day | 50 |
| distinct profiles opened / day | 120 |

Exceeding a limit returns exit code 7 with `action: HALT_AND_NOTIFY`. Limits live in config
and are tunable, but the ledger cannot be bypassed by a flag.

### Pacing

Carried forward from the existing worker, which established these deliberately:

- Bézier cursor paths with randomized bow, per-point jitter, and a corrected overshoot on
  ~20% of moves. Never a teleport to the target.
- Real `mouseWheel` events in 40–120px notches. Never `scrollIntoView`.
- `Emulation.setFocusEmulationEnabled` so a background tab is not timer-clamped and does not
  report `visibilityState: "hidden"` while "viewing" profiles.
- Randomized inter-action delays; no fixed cadence anywhere.

### Challenge detection

Checked before every parse and after every navigation. On detection: screenshot, checkpoint,
exit 2, `HALT_AND_NOTIFY`. Never retried automatically, never solved automatically.

### Tab lease

Exactly one capability may hold the LinkedIn tab at a time, enforced by a lockfile carrying
the holder's run_id and pid. A stale lock (dead pid) is reclaimable; a live one is not. Two
concurrent runs fighting one tab is a correctness bug and a detection signal.

### Session preflight

Before any capability touches LinkedIn, in order:

1. Chrome is running on the debug port with the dedicated profile — if not, launch it (D9).
2. CDP reachable and the browser endpoint answers.
3. The profile is logged in to LinkedIn; if not, exit 4 `REAUTH`.
4. Budget available for the estimated cost; if not, exit 7.
5. Tab lease acquired.

Fails fast with the right exit code rather than half-running.

---

## 9. Capability inventory

Contracts live in `docs/capabilities/<name>.md`, one file each.

### L0 — core modules (not CLI capabilities)

`chrome-launcher` · `session` · `tab-lease` · `worker-tab` · `foreground` · `human-input`
· `network-tap` · `run-context` · `events` · `archive` · `budget` · `challenge` · `store`
· `registry`

### L1 — cheap reads

| capability | notes |
|---|---|
| `profile.get` | `--sections=basics,experience,education,skills,certs,recommendations` |
| `profile.posts` | `--limit`, `--since` |
| `profile.activity` | reactions and comments the person made |
| `company.get` | about, website, size, industry, HQ |
| `company.posts` | `--limit`, `--since` |
| `company.people` | `--limit`, `--title=`, `--name=`; returns profile URLs |
| `company.jobs` | open postings |
| `job.get` | full posting detail |
| `post.get` | post detail, optional `--reactors`, `--commenters` |
| `feed.get` | operator's own feed |
| `inbox.list` | conversation list, read-only |
| `inbox.thread` | one thread, read-only |

### L2 — metered searches

| capability | notes |
|---|---|
| `salesnav.leads.list` | paged; captures inner data incl. profile URL and company URL |
| `salesnav.accounts.list` | paged; captures company URL and inner account data |
| `salesnav.filters.build` | composes a Sales Nav `query=(filters:List(...))` URL from a typed filter spec |
| `salesnav.filters.apply` | navigates to a built URL, verifies the filter set actually applied, returns the result count |
| `salesnav.savedsearch.list` | operator's saved searches |
| `classic.search.people` | non-Sales-Nav people search |
| `classic.search.companies` | non-Sales-Nav company search |
| `classic.search.posts` | post/content search |
| `jobs.search` | job search with filters |

### The filter self-test loop

`salesnav.filters.build` is what removes the operator from the loop. The agent describes an
audience as a typed spec; build emits a URL; `apply` navigates and reports the result count
and which filters LinkedIn actually honored. The agent iterates spec → build → apply → count
until the audience is the right size, then hands the URL to `salesnav.leads.list`.

`apply` is metered and counts against the search budget. `build` is pure and free — it makes
no request, so the agent can generate and validate URL syntax offline before spending.

---

## 10. Repo layout

```
LinkedinLeadsOS/
  CLAUDE.md              read every session: what this is, phase, rules, index
  DECISIONS.md           append-only, dated, why X over Y
  STATE.md               built / in progress / next — updated at every checkpoint
  docs/
    specs/               this file and successors
    capabilities/        one contract doc per capability
  src/
    core/                L0 modules, one directory each
    capabilities/        one directory per capability
    cli/                 registry-driven, no hand-written wiring
    store/               supabase client, migrations, typed queries
  supabase/              local Docker config and migrations
  fixtures/              promoted raw captures, per capability — gitignored (see §6)
  runs/                  run archives — gitignored
  tests/                 parser tests, all offline against fixtures
```

Each `src/capabilities/<name>/` holds: `index.ts` (the capability), `parse.ts` (pure),
`parse.test.ts` (offline), and `README.md` (what it returns, what it depends on).

**Why one directory per capability:** an agent picking this up cold reads one directory and
can work. It never needs the whole repo in context. This is the structural answer to context
loss across sessions.

### Context durability

- `CLAUDE.md` is read at session start and states the current phase.
- `STATE.md` is updated at every checkpoint, not at session end — a session that dies
  mid-task still leaves an accurate state file.
- `DECISIONS.md` is append-only, so a decision made on turn 6 is still visible on turn 400.
- Capability READMEs mean a contract never has to be re-derived from the implementation.

---

## 11. Build order

Each milestone is independently verifiable. Nothing later starts before the previous is
proven against the real account.

0. **M0 — profile migration.** ✅ **Done 2026-08-07.** Dedicated profile created at
   `~/.linkedin-os/chrome-profile`, logged into Google and LinkedIn by hand, verified over
   CDP on port 9223 — `li_at` present, expires 2027-08-07.
1. **M1 — core skeleton.** Chrome launcher, CDP session, worker tab, tab lease, event logger,
   run context, archive, receipt envelope, exit codes, `cap list --json`. Verified by a no-op
   capability that launches or reuses Chrome, opens a worker tab, logs, writes a receipt, and
   tears down cleanly with no consent dialog and no leftover tab.
2. **M2 — storage.** Supabase local in Docker, migrations, typed client, upsert-by-urn,
   freshness check, budget ledger.
3. **M3 — first reader end to end: `profile.get`.** Network tap, challenge detection,
   raw archive, parser, offline fixture test, Supabase write. This milestone proves the
   whole architecture on one capability.
4. **M4 — the rest of L1.** Company, posts, jobs, feed, inbox. Each one is now a small
   addition against a proven core.
5. **M5 — L2 Sales Navigator.** Leads and accounts list with pagination, checkpointing,
   and resume. Ports the good parts of the existing worker engine.
6. **M6 — filter builder and the self-test loop.** The last piece that removes the operator
   from targeting.

Existing code at `/Users/talhat/Claude/Projects/OwnexLabsSales/dashboard/worker` is a
reference and a parts donor, not a base. Specifically worth porting: `engine/cdp.mjs` human
input and passive capture, `engine/page-scripts.mjs` DOM navigation helpers, and the
pagination and resume logic in `engine/run-scrape.mjs`. It is not imported; it is read and
rewritten typed.

---

## 12. Out of scope

Stated explicitly so no session re-litigates them:

- All L3 writes — connect, message, comment, react, follow, post, endorse, profile view
- L4 intelligence — ICP scoring, signal detection, voice-matched drafting, reply classification
- L5 orchestration — campaigns, sequences, schedulers, approval gates, warm-up ladders
- MCP server surface
- Notifications of any kind
- Multi-account support and account rotation
- Any hosted or remote execution; this runs on the operator's machine against their Chrome

---

## 13. Open items

None blocking. Two to settle during M2:

- Exact Supabase local port and whether the schema is namespaced (`li.*`) or public.
- Whether `person_experience` needs full history or only current role for L1's purposes.
