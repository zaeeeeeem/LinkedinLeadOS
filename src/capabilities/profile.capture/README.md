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
| `snapshot` | the rendered-DOM snapshot (D123/D124): its archived filename and byte count, whether the subject's container `rendered`, the container's measurements, and `failure` when it did not land |
| `identity` | the D126 check: how many `voyagerIdentityDashProfiles` bodies arrived, whether one carried a subject urn, **where** (a path, never the urn — that is captured data), and whether the urn is the operator's own |
| `tap` | the tap's own counters, for diagnosing a run that captured less than expected |

`counts.captured` is every archived **response**; the DOM snapshot is not one of them and is
never counted there (D124). `counts.usable` is the subset carrying person data;
`counts.skipped` is misses — watched responses seen but not delivered.

### The DOM snapshot

After layout settles and the human-paced scroll, one `Runtime.evaluate` returns
`document.documentElement.outerHTML` and it is archived like any body (D2), under
`dom-snapshot:<url>` with `status: 0` and `pattern: "dom-snapshot"`. This is the profile's
**content** source (D123): no Voyager endpoint carries it on a cold load (D121). Promote it
with `npm run fixtures:promote` and it becomes the fixture Task 17's parser is written
against, with a DOM field map naming real CSS paths — see D127 for how the subject is told
apart from the "people also viewed" suggestions, and D128 for what the `basis` column means.

### Identity

`voyagerIdentityDashProfiles` **does not return the subject's urn** — it returns the
operator's own. The request settles it: `variables=(memberIdentity:<the operator's own urn>)`
is the *input*, so the call is the session identifying itself and cannot return a stranger.
D121 recorded otherwise only because nothing compared its answer to `/voyager/api/me`. See
D126.

The check still runs on every capture, and its answer is reported at
`data.identity.voyager` — a **field, not a warning**. It answers about the session on every
page, so a warning here would fire on every run forever and would sit next to the identity
warnings that do mean something. `is_session: true` there is the expected reading. It is kept
at all because a change in that answer would be worth knowing about.

**The subject's identity comes from the DOM snapshot (D130):** the SDUI card-ref namespace
every profile card agrees on, yielding `urn:li:fsd_profile:<PROFILE_ID>` (D127).
`resolveSubjectScope` in `src/core/fixtures/dommap.ts` derives it and returns `null` rather
than guessing, and `data.identity` carries the outcome — `resolved`, the urn *family* only,
how many cards agreed, and any card names this build has not seen. The id itself is never on
the receipt: it is the prospect's identity, and receipts go to stdout (§4.1, D3).

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
| `DOM_SNAPSHOT_FAILED` | the page would not answer the snapshot read, so this run produced no content fixture (D123). The tapped bodies are still archived |
| `DOM_SNAPSHOT_NOT_ARCHIVED` | the snapshot was read but could not be written to the raw archive, so nothing may parse it (D2) |
| `SUBJECT_CONTAINER_NOT_RENDERED` | the snapshot is archived but the subject's main container had no content in it. **Do not write a parser against that fixture** |
| `SUBJECT_CONTAINER_NOT_SCOPED` | the container holds sidebar elements, so scoping to it does not by itself exclude suggestions. Expected on the current layout — the card-ref namespace is what separates them (D127) |
| `SUBJECT_IDENTITY_UNRESOLVED` | the snapshot archived but no profile id resolved from the card-ref namespace. **This capture cannot be keyed** — nothing may be stored from it under a guessed urn (D130) |
| `SUBJECT_IDENTITY_IS_SESSION` | the identity resolved from the snapshot is the operator's own. Must never fire; if it does, stop and read the snapshot by hand (D119) |
| `SUBJECT_CARD_NAMES_UNRECOGNISED` | card names this build has not seen. A couple means LinkedIn shipped a new card; many means the id boundary moved and the urn is wrong (D130) |
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
