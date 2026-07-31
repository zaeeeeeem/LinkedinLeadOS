# Task 14 — Store client with upsert and freshness

**Model:** Sonnet · **Depends on:** Tasks 1, 13 · **Spec:** §7 (freshness), D3/D4

## Objective

The typed write path to Supabase for person data, plus the freshness logic that lets
capabilities answer from the store instead of spending a page load — the single largest
saving available (§7).

## Constraints

- Reads for the agent stay raw SQL (D4) — this module is the toolkit's own write path
  and lookup helpers, not a query wrapper layer.
- Freshness: a duration parser for the `--max-age` flag grammar (`7d`, `12h`, `30m`,
  bare milliseconds, `0`) and a staleness check where a missing timestamp is always
  stale and max-age 0 always re-fetches. Nonsense durations are loud usage errors,
  never silent defaults.
- Person upsert is keyed on URN, bumps last-seen, and replaces experience rows in the
  same operation. Missing configuration is detectable, so capabilities can run
  store-less (the skip-store flag) without crashing.
- Pure logic (duration, freshness) is unit-tested offline. Database paths are
  integration tests that **skip with a clear message when local Supabase is not
  running** — the suite stays green on a laptop with Docker off.

## Deliverables

Store client accessor + configuration probe, duration/freshness functions, person
upsert and lookups (by URN, by vanity), row types matching the Task 13 schema. Offline
tests pin the duration grammar and freshness edges; integration tests prove upsert,
last-seen bump, experience replacement, and both lookups against local Supabase.

## Acceptance criteria

Offline suite green with Docker off (integration skipped, visibly); full suite green
with Supabase up; typecheck clean.

**Discipline gate** — `CONTEXT.md`, "What review actually catches". Partial-failure state
walked, failures classified against the layer below, every claimed property pinned by a
test. Sharpest here: a write that half-lands. Say what is in the store when a multi-row
insert fails partway, and make a retry that re-sends rows already written provably safe.
