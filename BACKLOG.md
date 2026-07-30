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
