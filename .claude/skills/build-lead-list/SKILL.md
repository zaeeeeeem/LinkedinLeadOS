---
name: build-lead-list
description: Use when turning an audience idea (an ICP, a target market, "US software CEOs at small companies") into a stored list of LinkedIn leads or accounts — composing Sales Navigator filters, converging on an audience size, and harvesting the results. Also when asked to re-run or extend an existing saved search.
---

# Build a Lead List from an ICP

**Read the `linkedin-session` skill first** — preflight, budgets, exit codes.

You own the targeting strategy: which filters describe the ICP, what audience size is
useful, when a list is good enough. The toolkit gives you measured primitives and a
verification loop so LinkedIn can't silently search a different audience than the one you
described. No operator-supplied URL is needed anywhere.

## The primitives

| step | capability | cost | what it gives you |
|---|---|---|---|
| find filter values | `salesnav.filters.vocab` | 0 (offline) | measured (type, id, text) tuples with provenance |
| compose the URL | `salesnav.filters.build` | 0 (offline) | validated Sales Nav search URL from a typed spec |
| verify the audience | `salesnav.filters.apply` | 1 page load + 1 search page | which filters LinkedIn **actually** honored, and `paging.total` |
| harvest | `salesnav.leads.list` / `salesnav.accounts.list` | 1 load + 1 search page **per page** | provenance-tagged rows in `search_results` |
| reuse operator's searches | `salesnav.savedsearch.list` | 1 page load | the operator's own saved Lead/Account searches |

## The loop (spec → build → apply → read verdict → adjust → converge)

**1. Vocabulary.** Every filter value id must come from the harvested registry:

```sh
npm run cap -- salesnav.filters.vocab --operation=list --vertical=LEAD --facet=REGION --limit=50
npm run cap -- salesnav.filters.vocab --operation=lookup --vertical=LEAD --facet=INDUSTRY --text="Software Development"
```

Facet type names come from the measured catalog — 44 request-emittable types across both
verticals (LEAD examples: `TITLE`, `FUNCTION`, `SENIORITY_V2`, `INDUSTRY`, `REGION`,
`COMPANY_HEADCOUNT`, `COMPANY_TYPE`, `ANNUAL_REVENUE`, `JOB_OPPORTUNITIES`,
`DEPARTMENT_HEADCOUNT_GROWTH`). The full enumeration and which support ranges/typeahead is
in `docs/plans/m6-salesnav-autonomy/README.md`; an unknown facet in `list` just returns
nothing, and the builder refuses unknown types.

A value can be spelled one way in the typeahead and another in the request (REGION
`102095887` is "California, United States" vs "California") — rows carry both, either
resolves. If the vocabulary lacks a value you need, that's a real gap: it can only be
filled by a measured harvest session (`salesnav.filters.harvest`, operator-driven), not by
guessing an id.

Public vocabulary text ("United States", "Software Development") is fine through
`npm run cap`. The tsx-direct rule below is for **operator-private** values — persona
names, list/CRM rows, named target accounts — anything from the private overlay.

**2. Build (free — iterate here as much as you like).**

```sh
SPEC='{"vertical":"LEAD","filters":[
  {"kind":"values","type":"REGION","values":[{"id":"103644278","text":"United States","selectionType":"INCLUDED"}]},
  {"kind":"values","type":"COMPANY_HEADCOUNT","values":[{"id":"C","text":"11-50","selectionType":"INCLUDED"}]},
  {"kind":"range","type":"DEPARTMENT_HEADCOUNT_GROWTH","min":10}
]}'
./node_modules/.bin/tsx src/cli/index.ts salesnav.filters.build --spec="$SPEC"
```

Use the direct tsx form for specs — npm echoes the command line and would print filter
values (D432). The builder refuses unknown types and unregistered ids; a refusal is exit 1
(fix the spec), except catalog/registry drift which is exit 5. Raw-text and keyword
filters currently refuse by design — their request grammar is unmeasured.

**3. Apply — the metered check.** Each live apply needs fresh operator approval
immediately before execution; no approval carries over.

```sh
./node_modules/.bin/tsx src/cli/index.ts salesnav.filters.apply --spec="$SPEC"
```

Read from the receipt:
- **`audience_clean`** — every built filter honored, none injected. This is the flag that
  means "LinkedIn searched the audience I described". (`clean` is stricter and is false on
  healthy loads — LinkedIn injects a logging param; ignore that unless auditing.)
- Per-filter verdicts: honored / rewritten / dropped / injected. A drop or rewrite is
  never silent — you decide whether it matters for the ICP.
- **`paging.total`** — LinkedIn's own audience estimate, possibly rounded. Target a
  *band* (e.g. 500–5,000), never an exact number. Zero results is exit 0 and a finding:
  the ICP as spelled matches nobody — loosen a filter.

**4. Converge — the loop is you.** Too broad → add/tighten filters; too narrow → remove
or widen; rewritten/dropped → respell from vocabulary or drop that constraint knowingly.
Sub-cap is **10 applies/day** — budget roughly: converging usually takes 2–4 iterations,
so plan filters offline in `build` before spending applies. If you can't converge in ~5,
step back and rethink the ICP spelling instead of burning the rest.

**5. Harvest with the built URL** (never a session id — a prior apply's session is not a
reusable target):

```sh
npm run cap -- salesnav.leads.list --url="<built-url>" --pages=2 --limit=50
```

`--pages` (default 2, max 20) and `--limit` (default 50, max 500) bound the read; each
results page costs 1 page load + 1 search page against the **50 search pages/day** global.
A big list is harvested across days, not in one sitting — partial is normal, resume with
`--run-id=<id>`. `ACCOUNT` specs go to `salesnav.accounts.list` (operator-supplied or
built `/sales/search/company` URL) the same way.

**6. Verify in Supabase, not from the receipt:**

```sql
select search_id, page, position, person_urn, run_ref
from search_results where search_id = '<run id>' order by page, position;
```

Rows carry urns only — enrich the people that matter with `research-lead` afterwards.

## Judgment calls that are yours

- What audience band is worth harvesting, and how many pages the ICP deserves.
- Whether a rewritten filter still describes your ICP or poisons it.
- Ordering: broad-then-narrow vs narrow-then-widen. Both work; applies are the scarce
  resource, builds are free.
- Splitting one big ICP into several smaller specs (by region, by headcount band) to keep
  each `paging.total` in a harvestable band.

## Stop and ask the operator

- Any urge to click "Save search", open a lead, or anything on the search chrome — the
  only granted clicks are the pager and the Saved-searches button.
- Vocabulary gap needing a live harvest session.
- Any cap raise, or an apply beyond the daily 10.
- Exit 2/3/4 — per `linkedin-session`.
