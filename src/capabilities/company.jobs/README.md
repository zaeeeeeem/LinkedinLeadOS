# `company.jobs`

Lists open postings explicitly scoped to the subject company from labeled JobPosting values
inside the captured jobs-tab document's Big Pipe JSON. It never reads the DOM snapshot.

## Flags and cost

- `--url=<company-url-or-slug>` is required.
- `--limit=<1..100>` defaults to 100 and stops accepted-posting parse work at the bound.
- `--no-store` still performs the metered capture and offline parse, but skips Supabase writes.

The measured surface is one ordinary company jobs-tab reader load, not a search action: ledger
cost is 1 page load, 0 search pages, and 0 profile opens. One measured scroll pass reaches the
end; no second page or pagination request was observed, so none is invented. The daily
`company.jobs` sub-cap is 150/0/0.

## Sources and failure modes

Company identity is resolved-or-refused using the `company.get` network-body precedent. A row
must be a labeled `LISTED` JobPosting value whose `companyDetails.jobCompany.*company` resolves
to that subject. Navigation stubs and non-subject jobs are excluded. The canonical `jobs.id`
is decimal digits stripped from an exact LinkedIn job urn; no identifier is put in a URL or
other differently typed column.

This list surface supplies title, resolved location, `listedAt`, and full labeled description.
It does not supply `workplace_type`, so that field stays absent for Task 31 `job.get` to enrich;
Task 31 may also refresh or enrich any other detail field on the same numeric-id row. Exit 5
covers unresolved/session identity, scope drift, missing labeled fields, and parser bounds.
Challenge, rate-limit, auth, transient, and budget failures retain exits 2, 3, 4, 6, and 7.
A job batch write is atomic; drift persistence can fail afterward and reports the stored count.

## Operator verification

```sql
select id, company_urn, title, location, posted_at, workplace_type,
       length(description) as description_chars, first_seen, last_seen
from jobs
where company_urn = 'urn:li:fsd_company:<id>'
order by posted_at desc;

select count(*) as rows, count(distinct id) as distinct_ids,
       count(*) filter (where workplace_type is null) as awaiting_job_get
from jobs
where company_urn = 'urn:li:fsd_company:<id>';
```
