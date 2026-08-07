# `company.get`

Reads one LinkedIn company end to end: freshness lookup, one human-paced cold load of the
company main page, pure offline parsing of archived network bodies, and an upsert into
`companies`.

```sh
npm run cap -- company.get --url=https://www.linkedin.com/company/example/
npm run cap -- company.get --url=example --max-age=0
npm run cap -- company.get --url=example --no-store
```

## Source and identity

All stored fields are network-body sourced. Name prefers the corroborating Voyager company
record and falls back to the same subject's labeled Big Pipe record when Voyager supplies
only an identity stub; vanity prefers Voyager's company URL. Website, size, headquarters,
about and the current industry taxonomy come from labeled JSON in the initial document's
entity-escaped `<code id="bpr-guid-N">` Big Pipe islands, read by the shared `embeddedJsonOf`
helper. No rendered DOM string is parsed.

Identity resolves only when a document record addressed by the requested vanity and a
Voyager record agree on the same company id. A numeric target matches that exact company id
instead of expecting the numeric string to equal its vanity slug. The id is normalized to
`urn:li:fsd_company:<id>` before any store field is built. Missing agreement, a non-company
urn, or a candidate in the session/trap identity set is exit 5 and stores nothing.

## Flags, freshness, and cost

`--url` is required. `--max-age` defaults to `7d`; `0` forces a load. `--scrolls`,
`--capture-timeout-ms`, and `--layout-timeout-ms` pass through to the proven company probe
capture path. Universal `--dry-run`, `--no-store`, `--budget`, and `--run-id` flags apply.
`--no-store` still loads, archives, parses, and emits drift events.

A cache miss costs one page load, zero search pages, and zero profile opens. A fresh,
unambiguous vanity match returns from Supabase with zero page loads. Task 20's daily
capability sub-cap is 150 page loads, 0 search pages, and 0 distinct profiles, in addition
to the shared global limits; `--budget` can only lower the invocation allowance.

## Receipt and storage

The bounded receipt reports capture counts, source classes, storage counts, warnings, and a
query hint. It never reports the company urn or any database-written string. The company
write omits `first_seen` and appends `last_seen` last; a failed atomic upsert reports
`partial.stored: 0`. If parse-drift persistence fails after the company lands, the failure
reports `partial.stored: 1`.

```sql
select * from companies
where vanity = 'example'
order by last_seen desc
limit 2;

select field, sum(n) as misses
from parse_drift
where capability = 'company.get'
group by field
order by misses desc;
```

## Failures

Argument, duration, and store-configuration errors exit 1. Challenges exit 2, rate limits
exit 3, and dead authentication exits 4. `COMPANY_IDENTITY_UNRESOLVED` and
`COMPANY_IDENTITY_IS_SESSION` exit 5; parser field warnings are typed exit-5 drift
observations on an otherwise usable company. Capture/store transport failures exit 6.
Global, capability-sub-cap, or invocation-budget refusal exits 7. Lower-layer classified
errors pass through unchanged.
