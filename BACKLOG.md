# BACKLOG

Deferred work we know is coming. Not scheduled, not in the current phase. One entry per
item: what, why, and the approach settled when it was captured — so no future session
re-derives it.

## B1 — Multi-profile support: drive an existing Chrome profile (e.g. a borrowed Sales Navigator seat)

Captured 2026-08-08. Out of scope until L0–L2 are proven (CLAUDE.md scope), but the
seam must stay clean.

**The case.** Some accounts cannot be re-logged-in on our automation profile — e.g. a
Sales Navigator seat that belongs to another person's LinkedIn account. We must drive
the session that already exists in *their* Chrome profile, cookies and all.

**The approach (decided at capture time).** Never attach to their running daily Chrome
via `chrome://inspect` — that is the path D9 forbids: consent dialog on every browser
restart, HTTP discovery endpoints 404, human back in the loop. Instead, launch **their
existing profile directory** with the same flag set D9/D14 verified dialog-free:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9224 \
  --user-data-dir="<path to their Chrome profile>" \
  --no-first-run --no-default-browser-check
```

The profile directory carries the logged-in session, so no relogin, no consent dialog,
and `GET /json/version` discovery works normally (the flag path keeps the HTTP
endpoints enabled). Their daily Chrome must be fully quit first — Chrome refuses a
second instance on the same user-data-dir. Each additional profile gets its own port
(9224, 9225, …); **9222 stays forbidden forever** (D13), 9223 stays ours.

**What changes in code when this is picked up** (all confined to L0):

1. `chrome-launcher`: accept a profile config `{ port, profileDir, label }` instead of
   the hardcoded 9223/`~/.linkedin-os/chrome-profile` constants (which become the
   default profile). The 9222 guard stays unconditional.
2. Budget ledger: one ledger file **per profile** (e.g. `runs/budget-<label>.ndjson`)
   — limits protect each account separately; sharing one ledger would let one account's
   spend mask another's.
3. Session/tab layer: unchanged. Still create our own background worker tab inside
   their profile (D10) — never adopt a tab the human also uses; two drivers on one tab
   is what the tab lease exists to prevent.
4. CLI: a `--profile=<label>` universal flag mapping to a small profiles config file.

**Not decided yet** (decide when picked up): where the profiles config lives, whether
per-profile pacing limits differ, and how challenge screenshots identify which profile
they came from.

## B2 — `evaluate` classifies every page-side exception as transient

Captured 2026-08-08, from the Task 4 review. `WorkerTab.evaluate` maps anything with
`exceptionDetails` to `TAB_EVAL_FAILED` / `RETRY_BACKOFF` / retryable. That is right for
the case it was written for — an execution context torn down mid-navigation — and wrong
for a malformed expression in our own code, which will retry forever against a typo.

Harmless today because every expression evaluated is a literal in this repo, so a bad one
fails in development, not in a run. It stops being harmless the moment an expression is
built from a capability's arguments or from a selector that LinkedIn can change.

**The approach settled here:** split on `exceptionDetails.exception.className` rather than
on message text — `ReferenceError` / `SyntaxError` / `TypeError` on our own expression is
a fatal `TAB_EVAL_INVALID` (`HALT_AND_NOTIFY`, exit 1), while a context-destroyed error
stays transient. Message-text matching is explicitly rejected: it is Chrome-version
wording, and D15 already refused that kind of guessing one layer down.

## B3 — narrow the budget ledger's compaction retention back to 24h once Task 14 mirrors it

Captured 2026-08-08, from Task 11 review (D72). `spend()` compacts `runs/budget.ndjson`
to `COMPACTION_RETENTION_MS` (`src/core/budget/constants.ts`) on every write. That
constant is 7 days, not the 24h any limit actually enforces, because Task 13's
`budget_ledger` Supabase table has no writer yet (that's Task 14) — until it does, the
ledger file is the only copy of spend history that exists, so compaction is deliberately
conservative.

**The approach settled here:** once `budget_ledger` has a real writer and it is confirmed
to actually receive spend rows, narrow `COMPACTION_RETENTION_MS` to `DAY_MS`. No other
change needed — the constant is already the single place retention is decided.

**Update 2026-08-08 (Task 14):** Task 14 shipped the store client and the *person* write
path only; its task file scopes it to person data, so `budget_ledger` still has no writer
and the ledger file is still the only copy of spend history. This stays open, and the
trigger is now "whichever task first mirrors spend into Supabase", not Task 14.

## B4 — two concurrent `upsertPerson` calls for the same person delete each other's experience rows

Captured 2026-08-08, from Task 14 review. `upsertPerson`'s stale-row delete is
`delete … where person_urn = X and id not in (<ids this call just wrote>)`. Two overlapping
upserts of the same person each know only their own ids, so each one's delete removes the
rows the other just wrote. Both then return `removed` counts that look ordinary.

Not reachable today: one account, one tab lease (D10), runs are sequential, and nothing
calls the store concurrently. It becomes reachable the moment anything parallelises writes
for a single person — a batch capability, or two capabilities running against one profile.

**The approach settled here:** scope the delete by the write itself rather than by the id
list — stamp each upserted experience row with the writing run's id (or reuse `last_seen`,
which is already the caller's stamp) and delete `person_urn = X and last_seen < stamp`. A
concurrent writer with a later stamp then wins cleanly instead of the two deleting each
other, and the query stops carrying an id list that grows with the person's job history.

## B5 — `ensureChrome` reuses a Chrome that has no browser context left

Captured 2026-08-09, Task 16 (D122). A running automation Chrome whose windows have all
been closed answers `GET /json/version` normally and returns an empty `GET /json/list`. On
that process every browser-level command fails — preflight dies at `Storage.getCookies`
with `CDP_PROTOCOL_ERROR` / exit 6 and the message "Browser context management is not
supported". `isChromeUp` is true throughout, so `ensureChrome` reuses it and never
relaunches.

The receipt actively misleads: exit 6 is `RETRY_BACKOFF`, and no retry can ever change this
— the condition holds until someone restarts Chrome by hand. It cost one confused cycle to
diagnose during the D116 probe.

**The approach settled here:** on the *reuse* path only, require `GET /json/list` to return
at least one target before accepting the endpoint as healthy; treat an empty list as "not
up" and fall through to the existing launch path, which already handles a profile held by
another process. Discovery on the launch path is unchanged, and nothing about the attach
surface moves. The alternative — opening a tab to test, then closing it — costs a real CDP
round trip on every invocation to check a condition that is rare, and `/json/list` is a
plain HTTP GET that already exists in the discovery module.

Not fixed in Task 16's commit because `ensureChrome` is Task 2's module and preflight is
Task 12's; this is a behaviour change to the launcher's reuse decision and belongs with
whoever next touches it, with a test that fakes an empty `/json/list`.
