# `profile.get`

Reads one LinkedIn profile end to end: freshness lookup, the existing human-paced cold-load
capture, offline parsing of the archived DOM snapshot, person/experience storage, and a bounded
receipt.

```sh
npm run cap -- profile.get --url=https://www.linkedin.com/in/some-person/
npm run cap -- profile.get --url=some-person --max-age=0
npm run cap -- profile.get --url=some-person --no-store
```

## Source and safety

Identity and content have one source: the archived `document.documentElement.outerHTML` snapshot
(`source: "dom-snapshot"`). The subject urn comes from agreement among the SDUI profile-card refs;
name, headline, location, and experience come from the subject cards in that namespace. A snapshot
whose identity cannot be resolved, resolves to the logged-in account, or cannot be parsed produces
exit 5 and stores nothing under a guessed key.

The capability calls `profile.capture`'s existing run path; it does not implement another navigator,
network tap, scroll routine, challenge gate, or budget spend. Raw network bodies and the snapshot are
archived before parsing. The receipt reports the source and snapshot filename, never the subject urn
or parsed bulk profile fields.

## Arguments and universal flags

| flag | meaning |
|---|---|
| `--url=` | required profile URL, vanity slug, `/in/<vanity>`, or Sales Navigator lead URL |
| `--max-age=` | freshness window; default `7d`; `0` always fetches; accepts whole `ms`, `s`, `m`, `h`, or `d` values |
| `--scrolls=` | capture scroll passes, 0–12; omitted uses the capture's human-randomized default |
| `--capture-timeout-ms=` | wait for the first captured LinkedIn API response |
| `--layout-timeout-ms=` | wait for the profile scroller to settle before reading |

Universal flags apply. `--no-store` still captures, archives, parses, and logs drift, but performs no
Supabase write. `--dry-run` opens no browser. `--budget` can only lower the invocation's page-load
allowance.

## Cost and freshness

A cache miss costs one page load and one distinct-profile open. Both are recorded by
`profile.capture` before navigation. A fresh, unambiguous stored person returns with
`from_cache: true` and zero page loads; a reused vanity is not trusted as identity and falls through
to a live fetch. The receipt's `cost` is measured from the budget ledger, not copied from the
estimate.

`profile.get` spends under **its own** name even though it delegates to `profile.capture`
— the `RunBudget` passed down is bound to this capability — so it carries its own daily
sub-cap (D153/D160): 200 page loads, 90 distinct profiles, 0 search pages, in addition to
the shared §8 global limits. Either cap refusing is exit 7; the receipt's `evidence` names
which one (`"scope":"global"` vs `"scope":"capability"`).

## Receipt and storage

On a live success, `counts.requested` is 1, `counts.captured` is the number of network bodies archived,
`counts.usable` is 1 parsed person, and `counts.skipped` is the capture-miss count. `stored.rows` is the
person plus experience rows written by the person write path. `data.storage` breaks that total into
person, experience, removed-experience, and parse-drift rows.

Parser warnings remain warnings on an otherwise usable profile. Each is also a `parse.miss` event for
`cap log.drift` and, when storage is enabled, a row in `parse_drift`. If storage fails after some person
or experience rows land, the failure receipt's `partial.stored` is the exact number that landed.

Example queries (replace the vanity with the same operator-supplied slug):

```sql
select * from persons
where vanity = 'some-person'
order by last_seen desc
limit 2;

select e.*
from person_experience e
join persons p on p.urn = e.person_urn
where p.vanity = 'some-person'
order by e.is_current desc, e.started_on desc nulls last;

select field, sum(n) as misses
from parse_drift
where capability = 'profile.get'
group by field
order by misses desc;
```

## Failures

| code | exit | meaning |
|---|---:|---|
| `PROFILE_URL_INVALID`, `INVALID_DURATION`, `STORE_NOT_CONFIGURED` | 1 | fix the argument or configure Supabase/use `--no-store` |
| `CHALLENGE_*` | 2 | screenshot and checkpoint are preserved; stop for the operator |
| `RATE_LIMITED` | 3 | back off per the receipt |
| `SESSION_NOT_LOGGED_IN`, `SESSION_DEAD` | 4 | log in manually on the automation profile |
| `PROFILE_SNAPSHOT_UNAVAILABLE`, `PROFILE_IDENTITY_UNRESOLVED`, `PROFILE_IDENTITY_IS_SESSION`, `PROFILE_SESSION_IDENTITY_UNAVAILABLE`, `PROFILE_CAPTURE_CONTRACT_DRIFT` | 5 | inspect the evidence snapshot/raw path and update the offline parser or identity rule |
| `CAPTURE_TIMEOUT`, `PROFILE_NO_CAPTURE`, `STORE_UNAVAILABLE` | 6 | transient; retry according to the receipt |
| `BUDGET_EXCEEDED`, `BUDGET_INVOCATION_CAP` | 7 | wait for the safety window or raise only the invocation cap |

All lower-layer `CapabilityError`s pass through unchanged. Challenge handling, raw-first drainage,
and browser teardown remain owned by the existing capture path and runner.
