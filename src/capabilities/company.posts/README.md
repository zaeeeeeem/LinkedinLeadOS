# `company.posts`

Reads posts authored by the subject company from the captured
`voyagerFeedDashOrganizationalPageUpdates` response and batch-upserts `company_posts`.
Person-authored recommendations shown on the company tab are excluded.

## Flags and cost

- `--url=<company-url-or-slug>` is required.
- `--limit=<1..100>` defaults to 100 and stops accepted-update parsing work at the bound.
- `--since=<ISO date-or-timestamp>` keeps posts whose activity-derived timestamp is at or after the boundary.
- `--no-store` still performs the metered capture and offline parse, but skips Supabase writes.

One invocation delegates one posts-tab load with the six scroll passes measured by Task 21.
Ledger cost is 1 page load, 0 search pages, and 0 profile opens. The daily `company.posts`
sub-cap is 150/0/0; the load is charged to this capability even though `company.probe`
provides the navigation composition.

## Sources and failure modes

All fields come from captured Voyager JSON; there is no DOM exception. Identity must resolve
from a target-matching embedded company record corroborated by Voyager. Activity identity is
`metadata.backendUrn`; author type comes from the `*companyName` key; counts follow both
references; `posted_at` is decoded from the activity snowflake.

Exit 5 covers unresolved/session identity, missing fields, broken references, and exceeded
parser bounds. Challenge, rate-limit, auth, transient, and budget failures retain exits 2, 3,
4, 6, and 7 from the delegated capture. A batch write is atomic; drift persistence can fail
after the post rows land and reports that partial stored count.

## Operator verification

```sql
select urn, company_urn, posted_at, reactions, comments
from company_posts
where company_urn = 'urn:li:fsd_company:<id>'
order by posted_at desc;

select count(*) as rows, min(posted_at), max(posted_at)
from company_posts
where company_urn = 'urn:li:fsd_company:<id>';
```
