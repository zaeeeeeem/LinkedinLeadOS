# `health.check`

Exercises the whole L0 stack end to end and touches no LinkedIn page.

This is the M1 gate. If it returns `ok`, then Chrome launches or is reused, CDP answers,
the profile's session cookie is readable, the tab lease works, a background worker tab
opens and navigates, events reach disk, a receipt is persisted, and everything tears down
with no leftover tab. It is also the command to run first when any other capability starts
failing for reasons its own receipt cannot explain.

```
cap health.check
cap health.check --dry-run
cap health.check --force-release     # after a crashed run wedged the tab lease
```

## What it returns

`data` on the ok receipt:

| field | meaning |
|---|---|
| `chrome.port` / `chrome.launched` | 9223, and whether this invocation cold-started Chrome (`true`) or reused a running one (`false`) |
| `chrome.product` / `chrome.protocol` | from `Browser.getVersion` |
| `tab.target_id` / `tab.session_id` / `tab.url` | the worker tab this run created, and where it ended up (`about:blank`) |
| `foreground.ok` / `.via` / `.hidden` | whether the tab reports itself visible, and which escalation step got it there. `via: "already"` means the operator's window was never touched |
| `tap.running` / `tap.watching` | the network tap is attached; it watches nothing, because nothing is fetched |
| `login` | `logged_in`, `cookie` (`present` / `missing` / `expired`), `expires_at`. Never the cookie's value |
| `lease` | the lease record this run held: run id, pid, host, capability, acquired_at |
| `budget` | ledger path and the current §8 window counts |
| `artifacts` | this run's `events.ndjson` and `raw/` |

`counts.usable` is 1 when the tab reached foreground, 0 otherwise (with a
`TAB_NOT_FOREGROUND` warning — a hidden tab renders nothing and is a tell, so it is
reported rather than passed over).

## Flags

Every universal flag of §4.4 applies. The ones that mean something here:

- `--dry-run` — plan and lease state only. Opens no browser at all.
- `--force-release` — drops a wedged tab lease before acquiring, and puts the evicted
  holder (run id, pid, capability, host) on the receipt as a `TAB_LEASE_FORCE_RELEASED`
  warning. This is the operator's escape hatch from D16: the lease never expires on age,
  so a crashed run whose pid gets recycled wedges the tab until someone says this.
- `--run-id=<id>` — appends to an existing run archive instead of minting a new one.

## Cost

Zero. No page loads, no search pages, no profile opens, no budget entries — `risk: local`.
`about:blank` issues no request, so this can be run as often as needed without spending
anything against the account.

## Failure modes

| code | exit | what to do |
|---|---|---|
| `CHROME_BINARY_MISSING`, `CHROME_LAUNCH_FAILED` | 1 | fix the path or quit the Chrome already holding the profile directory |
| `CHROME_UNREACHABLE`, `CHROME_LAUNCH_TIMEOUT` | 6 | retry |
| `LOGIN_PROBE_FAILED` | 6 | the cookie read failed, which says nothing about the session — retry |
| `TAB_LEASE_HELD` | 6 | another run holds the tab; wait, or `--force-release` if it is wedged |
| `TAB_LEASE_UNWRITABLE` | 1 | `runs/` is not writable |
| `CDP_*` | 6 | transport trouble; retry |

`SESSION_NOT_LOGGED_IN` (exit 4) is deliberately **not** in that list: this capability sets
`needsAuth: false`, so a logged-out profile is reported in `data.login` rather than halting.
The one command that diagnoses a broken session must still run when the session is broken.

## Storage

None. This capability writes no Supabase rows, so `--no-store` changes nothing and there
are no example queries. Its record is the run archive: `runs/<run_id>/events.ndjson` and
`runs/<run_id>/summary.json`.
