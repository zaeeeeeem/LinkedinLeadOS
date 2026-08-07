# `company.people`

Lists profile URLs from the company people tab's captured `voyagerSearchDashClusters` body and batch-upserts association pairs into `company_people`. It reads no DOM content and never forges a Voyager request.

## Flags and cost

`--url=<company>` is required. `--limit=1..100` defaults to 100; `--title=` and `--name=` are case-insensitive filters over captured result fields. The limit stops accepted-result work rather than slicing output afterward. `--no-store` still captures and parses.

One invocation costs 1 page load, 0 search pages and 0 profile opens. The explicit daily sub-cap is 150/0/0. The generic search schema is delivered by the company page load; this capability initiates no separately metered search action.

## Failure modes

Challenge, rate limit, auth, transient and budget failures use exits 2, 3, 4, 6 and 7. Unresolved/company-session identity, an unresolvable result reference, or exceeded parser bounds produce typed exit-5 drift warnings; unresolved subject identity refuses all writes. Input is bounded to 256 bodies, 200,000 JSON nodes per body and 20,000 characters per projected field.

The association means only that LinkedIn listed the person in a response explicitly filtered to the subject as current company. It does not invent a title or claim employment beyond that captured boundary. Session urns and unscoped suggestions never become rows. Batch input is pair-deduplicated and omits `discovered_at`, so the database preserves the original discovery timestamp on rediscovery.

## Verification SQL

```sql
select cp.company_urn, cp.person_urn, cp.discovered_at, p.vanity
from company_people cp
left join persons p on p.urn = cp.person_urn
join companies c on c.urn = cp.company_urn
where c.vanity = '<operator-supplied-vanity>'
order by cp.discovered_at desc;
```
