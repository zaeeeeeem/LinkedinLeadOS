# `log.errors`

Every `warn`/`error`-level event in one run, in the order they were written — the `info`/
`debug` events that make up the successful majority of a long run filtered out.

```
cap log.errors --run=01JQ7X...
```

## What it returns

`data` on the ok receipt:

| field | meaning |
|---|---|
| `run_id` | echoed back |
| `events[]` | every `warn`/`error`-level event, oldest first |
| `truncated` | `true` if more than 500 matched — the oldest were dropped |

`next` on the receipt suggests `log.why --run=<id> --item=<ref>` using this run's id, since
an error event usually carries the `item_ref` to follow up with.

An empty `events[]` on a run that exists and finished `ok` is the expected, boring answer —
nothing went wrong. It is different from `RUN_NOT_FOUND`, which means the run id itself does
not exist.

## Flags

- `--run=<id>` — required. An unknown run id is `RUN_NOT_FOUND`, exit 1.

Every universal flag of §4.4 also applies, though none change behavior here.

## Cost

Zero. `risk: local`.

## Failure modes

| code | exit | what to do |
|---|---|---|
| `RUN_NOT_FOUND` | 1 | the run id does not exist under `runs/` — check for a typo |

## Storage

None. Reads `runs/<run>/events.ndjson` directly. A truncated trailing line from a killed
process is skipped, not fatal — the real errors before it are still returned, which is the
whole reason this capability exists: it is read exactly when a run died badly.
