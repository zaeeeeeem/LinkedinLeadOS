# `log.why`

Every event for one item in one run, in the order they were written. This is what an
operator reads when something has already gone wrong with a specific item, instead of
grepping the whole `events.ndjson`.

```
cap log.why --run=01JQ7X... --item=1000.5
```

`--item` matches the event log's `item_ref` field verbatim — whatever string the capability
tagged its per-item events with. Today that is the CDP request id `network-tap` stamps on
`capture.hit`/`capture.miss`; a future per-lead capability (`salesnav.leads.list`) would tag
its own events with a business ref like a lead id instead. `log.why` does not interpret the
string, only matches it exactly.

## What it returns

`data` on the ok receipt:

| field | meaning |
|---|---|
| `run_id` / `item_ref` | echoed back |
| `events[]` | every matching event, oldest first, each the full `LoggedEvent` shape (`ts`, `seq`, `level`, `event`, `phase?`, `duration_ms?`, `detail?`) |
| `truncated` | `true` if more than 500 events matched — the oldest were dropped, keeping the tail closest to whatever just happened |

An item ref that matches nothing returns `events: []`, not an error — that is a legitimate
answer (the item was never touched, or the ref was mistyped) and is different from the run
itself not existing.

## Flags

- `--run=<id>` — required. An unknown run id is `RUN_NOT_FOUND`, exit 1.
- `--item=<ref>` — required.

Every universal flag of §4.4 also applies, though none change behavior here.

## Cost

Zero. `risk: local`.

## Failure modes

| code | exit | what to do |
|---|---|---|
| `RUN_NOT_FOUND` | 1 | the run id does not exist under `runs/` — check for a typo |

## Storage

None. Reads `runs/<run>/events.ndjson` directly via the same corrupt-line-tolerant
`readEvents` the run archive itself uses (Task 6) — a truncated trailing line from a killed
process is skipped, and every complete event before it is still returned.
