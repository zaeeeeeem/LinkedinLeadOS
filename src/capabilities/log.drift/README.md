# `log.drift`

`parse.miss` events across every run, grouped by capability and field, within a time window,
counted and sorted highest first. This is what tells an agent which parser to go fix — not
just that something once failed to parse, but which field, on which capability, how often.

```
cap log.drift                   # since=7d, the default
cap log.drift --since=30d
```

## What it returns

`data` on the ok receipt:

| field | meaning |
|---|---|
| `since` | the window that was applied, echoed back |
| `groups[]` | `{ capability, field, count }`, sorted by count descending |
| `truncated` | `true` if more than 200 groups matched — the smallest counts were dropped |

A `parse.miss` event's `detail.field` is the contract Task 16/17 record parser misses
against — the missing/unresolvable field's name. An event without a readable `detail.field`
groups under field `"(unknown)"` rather than being dropped; a run whose `run.json` cannot be
attributed (missing or corrupt) groups under capability `"(unknown)"` for the same reason —
undercounting drift silently would defeat the point of the query.

## Flags

- `--since=<duration>` — the Task 14 grammar. Default `7d`, matching spec §5's example. An
  unparseable value is `INVALID_DURATION`, exit 1.

Every universal flag of §4.4 also applies, though none change behavior here.

## Cost

Zero. `risk: local`.

## Failure modes

None specific to this capability. No runs, or no `parse.miss` events in the window, returns
`groups: []`, not an error.

## Storage

None. Scans every run directory's `run.json` and `events.ndjson` directly off disk.
