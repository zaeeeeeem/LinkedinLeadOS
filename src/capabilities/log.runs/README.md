# `log.runs`

One line per run, most-recently-active first, within a time window. This is what an agent
calls instead of listing `runs/` and reading every `summary.json` by hand — the whole point
of D5's bounded query capabilities.

```
cap log.runs                    # since=24h, the default
cap log.runs --since=7d
```

## What it returns

`data` on the ok receipt:

| field | meaning |
|---|---|
| `since` | the window that was applied, echoed back |
| `runs[]` | one entry per run active in the window, most recent first |
| `truncated` | `true` if the result was cut — by count (200 runs) or by size (32KB), whichever bit first; the oldest were dropped, never the newest |
| `dropped` | how many runs were cut. The `LOG_RESULT_TRUNCATED` warning's `n` is this number, not the number returned |

Each `runs[]` entry:

| field | meaning |
|---|---|
| `run_id` | |
| `capability` | which capability the run was for; `null` only if `run.json` is corrupt |
| `created_at` / `last_activity` | `last_activity` is `max(created_at, every resumed_at)` — what the window filters on |
| `status` | `ok` \| `error` \| `incomplete` \| `corrupt` |
| `exit` / `error_code` | present on `error` |
| `counts` / `cost` | copied from `summary.json` when the run finished |

`status: "incomplete"` means the run has no `summary.json` yet — still running, or it crashed
mid-invocation; `log:errors --run=<id>` is the next call to tell those apart. `status:
"corrupt"` means `run.json` itself could not be parsed — surfaced with no timestamp rather
than silently dropped, because a damaged run record is exactly the kind of thing an operator
needs to see, not lose to a time filter it has no readable timestamp to be judged against.

## Flags

- `--since=<duration>` — the Task 14 grammar (`30s`, `10m`, `2h`, `7d`; no unit means
  milliseconds). Default `24h`. An unparseable value is `INVALID_DURATION`, exit 1 — never
  silently the default and never silently zero.

- `--include-queries` — include runs of the `log.*` capabilities themselves. Off by default.
  Every debugging session writes more of them and they sort newest-first, so left in they
  push the runs being debugged past the cap until `log.runs` mostly reports `log.runs`
  (D142). Turn it on to audit the query capabilities themselves.

Every universal flag of §4.4 also applies, though none change behavior here.

## Cost

Zero. `risk: local` — this reads local files only, no LinkedIn request, no budget entry.

## Failure modes

None specific to this capability. A missing `runs/` directory (nothing has ever run) returns
an empty list, not an error.

## Storage

None. Reads `runs/<id>/run.json` and `runs/<id>/summary.json` directly off disk — never
`RunContext.open({ runId })`, which would mutate the very run being inspected (append
`resumed_at`, log `checkpoint.resume`).
