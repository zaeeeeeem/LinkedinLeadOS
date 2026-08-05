# `profile.capture`

Opens one LinkedIn profile in the worker tab and archives every profile-related response
the page fetches. It parses nothing, stores nothing, and decides nothing — its product is
the raw archive plus a report of **which endpoints the page actually hit**.

This is the discovery step behind `profile.get` (Task 17). It exists because the endpoint
list cannot be assumed from memory: LinkedIn serves profiles from GraphQL operations whose
ids change, so the patterns this build watches for are a guess, and the receipt is where
that guess is checked against reality.

```
cap profile.capture --url=https://www.linkedin.com/in/some-person/
cap profile.capture --url=some-person --scrolls=5
cap profile.capture --url=https://www.linkedin.com/in/some-person/ --dry-run
```

## Cost

**One page load and one profile open, against the one account.** `risk: read-cheap`.
There are no free retries — a failed run has still spent the view. Both limits are checked
before either is recorded, and both are recorded *before* the navigation, so a crash
mid-load leaves the ledger over-counting rather than under-counting.

`profile_open` is deduped by `ref` (§8), so re-capturing the same profile within the daily
window costs no second profile open. `--dry-run` opens no browser and spends nothing.

## Arguments

| flag | meaning |
|---|---|
| `--url=` | **required.** A profile url, a bare vanity slug (`some-person`), `/in/some-person`, or a Sales Navigator lead url. Query parameters and sub-paths (`/details/…`, `/recent-activity/…`) are stripped — see `url.ts` |
| `--scrolls=` | scroll passes down the page (0–12). Omitted: a randomized 3–6. `0` captures above the fold only, which is usually not enough — LinkedIn lazy-loads experience, education and skills on intersection |
| `--capture-timeout-ms=` | how long to wait for the page's first LinkedIn api response (default 25000). Raise it on a slow connection; waiting costs nothing but time |
| `--layout-timeout-ms=` | how long to wait for the page to lay out before scrolling it (default 15000). `WorkerTab.navigate` resolves on `readyState === "complete"`, which on LinkedIn fires while the SPA is still an empty shell — see D114 |

Every universal flag of §4.4 applies. `--no-store` changes nothing here — this capability
writes no Supabase rows.

## What it returns

`data` on the ok receipt:

| field | meaning |
|---|---|
| `target` | the canonical url, the `kind`, the `ref` the budget deduped on, the vanity |
| `foreground` | whether the tab reported itself visible, and how it got there |
| `reading` | scroll passes, wheel notches, pixels, paused ms, the measured viewport, and `layout` — whether the page ever laid out, how long that took, how many polls |
| `capture.patterns` | **the point of this capability.** One row per watched pattern: `hits`, `profile_ish`, `misses`, and its `tier` |
| `capture.unmatched_profile_ish` | profile-carrying responses that **no specific pattern matched**. `0` means the watched patterns describe reality; anything else is the finding |
| `capture.endpoints` | one row per response worth looking at (profile-carrying, or unpredicted): endpoint **path** (never the query string), GraphQL `query_id`, status, bytes, shape hash, archived filename |
| `capture.endpoints_omitted` | how many rows were left off stdout — the full set is in `raw/` |
| `tap` | the tap's own counters, for diagnosing a run that captured less than expected |

`counts.captured` is every archived response; `counts.usable` is the subset carrying person
data; `counts.skipped` is misses — watched responses seen but not delivered.

### The two pattern tiers

`specific` patterns are this build's prediction of which endpoints a profile page fetches.
`broad` patterns (`gql-any`, `linkedin-api`) are the net that makes the prediction
checkable: a profile payload arriving on an endpoint nobody predicted is still archived,
still counted, and raises `PATTERN_MISMATCH`. A specific pattern sitting at zero hits next
to a non-zero `unmatched_profile_ish` means the patterns need updating in `patterns.ts` —
which is a finding to report, not something to absorb quietly.

## Warnings

| code | what it means |
|---|---|
| `PATTERN_MISMATCH` | profile payloads arrived on endpoints no specific pattern matched. Read `capture.endpoints` for the `query_id`s and update `patterns.ts` |
| `NO_PROFILE_PAYLOAD` | responses were archived but none carried person data. An ok receipt here does **not** mean the profile was captured |
| `CAPTURE_MISSES` | watched responses were seen but their bodies were lost (evicted buffer, aborted request). See the `capture.miss` events |
| `RESPONSE_STATUS_UNRECOGNIZED` | a subresource answered 403 or redirected somewhere unknown, on a page the DOM gate certified clean. Reported rather than halted — see D111 |
| `TAB_NOT_FOREGROUND` | the tab still reports itself hidden, so LinkedIn's lazy sections may never have fetched |
| `PAGE_NOT_LAID_OUT` | the document never grew past the viewport inside the layout window, so nothing scrolled and the lazily-loaded sections never fetched. Treat the capture as incomplete — this is the failure the first live run hit (D114) |

## Failure modes

| code | exit | what to do |
|---|---|---|
| `PROFILE_URL_INVALID` | 1 | the url is not a profile url. The message names the accepted forms. Nothing was spent |
| `BUDGET_EXCEEDED`, `BUDGET_INVOCATION_CAP` | 7 | a §8 limit or your own `--budget`. Nothing was navigated |
| `CHALLENGE_CAPTCHA`, `CHALLENGE_CHECKPOINT`, `CHALLENGE_RESTRICTED`, `CHALLENGE_UNRECOGNIZED` | 2 | **stop.** A human clears it by hand on the automation Chrome. Never retried automatically (D6). The screenshot is in `runs/<id>/shots/` and the checkpoint in `runs/<id>/checkpoint.json` |
| `SESSION_DEAD` | 4 | log in again on the automation profile |
| `RATE_LIMITED` | 3 | LinkedIn answered 429. Back off |
| `CAPTURE_TIMEOUT` | 6 | the page loaded but issued no api response inside the window. Retry, or raise `--capture-timeout-ms` |
| `PROFILE_NO_CAPTURE` | 6 | the page loaded and nothing at all was archived |
| `TAB_LEASE_HELD` | 6 | another run holds the tab; wait, or `--force-release` if it is wedged |

On every one of these — including the halting ones — the tap is drained before the error
leaves, so whatever was already on the wire is on disk. A spent page load always leaves an
archive.

## Storage

**None in Supabase.** The record of a run is:

- `runs/<run_id>/raw/` — every captured body, gzipped, with a `.meta.json` sidecar
- `runs/<run_id>/events.ndjson` — `nav.*`, `render.wait`, `capture.hit`, `capture.miss`,
  `budget.spend`, `challenge.detected`
- `runs/<run_id>/summary.json` — the receipt
- `runs/budget.ndjson` — the page load and the profile open

## Promoting the capture into fixtures

```
npm run fixtures:promote -- --run=<run_id>
npm run fixtures:promote -- --latest --all      # every JSON body, not just profiles
```

This copies bodies into `fixtures/profile.get/`, deduplicated by shape hash, and writes
`FIELD-MAP.md` beside them — a document naming the real JSON paths of the person's URN,
name, headline, location and experience entries in each fixture. That document is what
Task 16's parser is written against.

Both `fixtures/` and `runs/` are gitignored in full: captured bodies hold real prospect
data and the operator's own identifiers (§6).
