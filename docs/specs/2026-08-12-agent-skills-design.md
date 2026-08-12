# Agent Skills for Driving LinkedinLeadsOS — Design

Date: 2026-08-12. Status: approved approach (Option A), spec pending user review.

## Purpose

Skill files that let any model, in any session, drive the built L0–L2 system correctly by
**use case** — not feature documentation. A session should be able to load one skill and
execute a whole job (build a lead list, research a lead, triage the inbox, recover a broken
session) without re-deriving the safety rules or the CLI surface from CLAUDE.md and 30
capability READMEs.

Scope: current system only. No outreach, no L3, no aspirational content. Skills describe
what exists as of M6 (D477).

## Shape

Five skills under `.claude/skills/<name>/SKILL.md` in this repo, standard Claude Code skill
format (YAML frontmatter: `name`, `description`; description written to trigger on the use
case's natural phrasings).

One **foundation** skill holds the invariants once; four **use-case** skills each begin with
"invoke `linkedin-session` first" and stay task-shaped. Rationale: rules change in one
place; use-case skills stay short enough to hold in context whole.

Skills point to authority rather than duplicate it: exact flag lists and output shapes live
in `src/capabilities/<name>/README.md`; skills carry the *sequence, the decision points, and
the stop conditions*, plus only the flags the sequence actually uses. When a skill and a
README disagree, README wins and the skill is the defect.

## The five skills

### 1. `linkedin-session` (foundation)

Preflight and ground rules for every task that touches LinkedIn.

- Chrome: dedicated profile, port 9223, discover CDP via `GET /json/version` (never
  hardcode the browser path, never port 9222). Bash sandbox blocks loopback — state the
  workaround.
- `health.check` before any capability; interpret its receipt.
- Budget ledger: how to read remaining budget, that no flag bypasses it, exit 7 = wait,
  never retry-loop.
- Exit-code contract: 0 ok · 2 challenge (screenshot exists, STOP, tell operator) · 3
  rate-limited (stop, don't probe) · 4 auth dead (stop, operator) · 5 parse drift (offline
  fix path) · 6 transient (one retry max) · 7 budget (wait for window).
- Hard-rules digest: never forge requests, network tap is truth (with the five named DOM
  exceptions), the two granted clicks only, challenges never auto-solved, raw archived
  first, receipts on stdout / bulk in Supabase.
- Recording ritual: decisions to DECISIONS.md, state to STATE.md at checkpoints.

### 2. `build-lead-list` (use case: ICP intent → stored leads)

The M6 loop as an SOP.

- Input: typed audience intent (geography, titles, industry, headcount…). No
  operator-supplied URL anywhere.
- Sequence: `salesnav.filters.vocab` lookup (harvested vocabulary, request-text spellings —
  the REGION label/requestText mismatch gotcha) → `filters.build` (pure, 0 cost) →
  `filters.apply` (1 page load + 1 search page; read back *which filters LinkedIn actually
  applied*) → convergence decision in the driving agent: compare applied vs intended,
  adjust, re-apply. Iteration cap stated explicitly (the loop lives in the agent, so the
  skill carries the cap).
- Acceptance: all intended constraints confirmed applied; result count sane for the ICP.
- Then `salesnav.leads.list` pagination under the daily sub-caps; what a partial harvest
  looks like and why it's fine.
- Verification: independent Supabase query for stored rows, not the receipt.
- LEAD vs ACCOUNT variants: when each, and the cost difference.

### 3. `research-lead` (use case: one person or company → dossier)

- Cheap-first ordering: L1 reads before anything metered.
- Person: `profile.get` (DOM-exception reader — rows are DOM-tagged, identity
  resolved-or-refused) → `profile.posts` / `profile.activity` as needed.
- Company: `company.get` → `company.people` / `company.jobs` / `company.posts` selectively,
  driven by what the dossier question actually needs — not "run everything".
- Posts: `post.get` reads the post only by default; comments/reactions opt-in and bounded;
  a partial thread is reported partial.
- Jobs: `job.get` (DOM exception, offline parse).
- Output: dossier assembled from Supabase rows with provenance tags kept; DOM-sourced
  fields stay labeled DOM-sourced.

### 4. `monitor-account` (use case: operator's own feed + inbox, read-only triage)

- `feed.get`: bounded by `--limit` and fixed pass count; unresolvable author reported, not
  attributed.
- `inbox.list` / `inbox.thread`: read-only; opening a thread may mark it read — say so on
  the receipt; **message text never leaves the archive** — not stdout, receipts, logs,
  commits, or the skill's own examples. Triage output references threads by id/participant,
  never by quoted content.
- Fixtures for these surfaces go to `.fixtures-private/`, never `fixtures/`.

### 5. `recover-session` (use case: something went wrong)

Playbook keyed by symptom, not by subsystem.

- Exit 2: find the challenge screenshot, checkpoint state, hand to operator; never solve.
- Exit 3 / 4: stop entirely; what "stop" means (no probes, no health-check spam).
- Exit 5: parse drift — capture is archived, fix parser offline against the archived raw,
  prove with fixtures, zero live requests.
- Exit 6: one retry, then treat as real.
- Exit 7: read the ledger window, compute when budget returns, schedule, don't touch caps
  in constants.ts.
- CDP won't connect: the 9223 discovery dance, Chrome not running, sandbox-blocked
  loopback.
- Worktree hazards: the runs-symlink incident — never `git add -A` in a worktree.

## Error handling (of the skills themselves)

Each use-case skill ends with a short "when to stop and ask the operator" list — the
boundary between what the skill authorizes and what needs a human. Anything smelling of L3,
any unmeasured click, any rule conflict: stop.

## Testing / acceptance

- Dry review: each skill read cold by a fresh session must yield correct first three
  actions for its use case without opening CLAUDE.md.
- Cross-check pass: every CLI invocation named in a skill exists in `src/capabilities/` and
  its flags match the capability README.
- No skill contradicts CLAUDE.md hard rules; foundation skill's rules digest is traceable
  line-for-line to CLAUDE.md.

## Out of scope

Outreach/closing skills (L3 not built) · MCP exposure of skills · auto-generated skills
from READMEs · skills for the dentist venture in the parent directory.
