# Sales Navigator filter catalog map

Source: run `01KZQNM34D61NTBDQNDVSZ45AV`, archive
`0014-3ff85d03efb79a26`, `salesApiSearchFilterLayout?q=viewModes`. The promoted body is
`test-fixtures/filter-layout.json.gz`; its uncompressed 81,800 bytes have SHA-256
`50e5d2a45dd23b20dc10368ef198431329ba0bf0cdc403b507b8adf14e52cfba`.

Scrub audit: no LinkedIn urn, email, seat, saved-search id, profile id or member-identity marker
was present, so nothing was scrubbed. This is a JSON body, so BACKLOG's non-JSON/DOM fixture
dedupe defect cannot apply. Tests parse this fixture directly and pin 35 LEAD rows, 17 ACCOUNT
rows, 46 distinct body type names and 44 request-emittable type names across both verticals
(D423).

`typeahead`, `raw`, `exclude`, and `dynamic` below are the body's booleans. Aggregate parents
are presentation-only; the child request types are the emittable rows. `URL evidence` names a
captured request that exercises the type, or `—` when no archived request does.

| Vertical | Type | Shape | Presentation | typeahead | raw | exclude | dynamic | Parent | URL evidence |
|---|---|---|---|---:|---:|---:|---:|---|---|
| LEAD | CURRENT_COMPANY | values | MULTI_ENTITY_WITH_MULTI_SELECT | true | true | true | true | — | — |
| LEAD | COMPANY_HEADCOUNT | values | MULTI_SELECT | false | false | false | false | — | saved body `01KZQCS…/0037` |
| LEAD | PAST_COMPANY | values | MULTI_ENTITY_WITH_MULTI_SELECT | true | true | true | true | — | — |
| LEAD | COMPANY_TYPE | values | MULTI_SELECT | false | false | false | false | — | — |
| LEAD | COMPANY_HEADQUARTERS | values | MULTI_SELECT | true | false | true | true | — | — |
| LEAD | FUNCTION | values | MULTI_SELECT | true | false | true | true | — | — |
| LEAD | CURRENT_TITLE | values | MULTI_SELECT | true | true | true | true | — | — |
| LEAD | SENIORITY_LEVEL | values | MULTI_SELECT | false | false | true | false | — | — |
| LEAD | PAST_TITLE | values | MULTI_SELECT | true | true | true | true | — | — |
| LEAD | YEARS_AT_CURRENT_COMPANY | values | MULTI_SELECT | false | false | false | false | — | — |
| LEAD | YEARS_IN_CURRENT_POSITION | values | MULTI_SELECT | false | false | false | false | — | — |
| LEAD | GEOGRAPHY | aggregate | AGGREGATE | false | false | false | false | — | — |
| LEAD | REGION | values | MULTI_SELECT | true | false | true | true | GEOGRAPHY | saved body `01KZQCS…/0037` |
| LEAD | POSTAL_CODE | values | MULTI_SELECT | true | true | false | true | GEOGRAPHY | — |
| LEAD | INDUSTRY | values | MULTI_SELECT | true | false | true | true | — | saved body `01KZQCS…/0037` |
| LEAD | FIRST_NAME | text | TEXT | false | false | false | false | — | — |
| LEAD | LAST_NAME | text | TEXT | false | false | false | false | — | — |
| LEAD | PROFILE_LANGUAGE | values | MULTI_SELECT | false | false | false | false | — | — |
| LEAD | YEARS_OF_EXPERIENCE | values | MULTI_SELECT | false | false | false | false | — | — |
| LEAD | GROUP | values | MULTI_SELECT | true | false | false | true | — | — |
| LEAD | SCHOOL | values | MULTI_SELECT | true | false | true | true | — | — |
| LEAD | FOLLOWS_YOUR_COMPANY | toggle | TOGGLE | false | false | false | false | — | — |
| LEAD | VIEWED_YOUR_PROFILE | toggle | TOGGLE | false | false | false | false | — | — |
| LEAD | RELATIONSHIP | values | MULTI_SELECT | false | false | false | false | — | — |
| LEAD | CONNECTION_OF | values | SINGLE_SELECT | true | false | false | true | — | — |
| LEAD | PAST_COLLEAGUE | toggle | TOGGLE | false | false | false | false | — | — |
| LEAD | WITH_SHARED_EXPERIENCES | toggle | TOGGLE | false | false | false | false | — | — |
| LEAD | RECENTLY_CHANGED_JOBS | toggle | TOGGLE | false | false | false | false | — | — |
| LEAD | POSTED_ON_LINKEDIN | toggle | TOGGLE | false | false | false | false | — | — |
| LEAD | PERSONA | values | SINGLE_SELECT | false | false | false | false | — | `01KZQFC…/0016`, `01KZP69…/0018` |
| LEAD | ACCOUNT_LIST | values | MULTI_SELECT | true | false | true | true | — | — |
| LEAD | LEAD_LIST | values | MULTI_SELECT | true | false | true | true | — | — |
| LEAD | LEADS_IN_CRM | values | MULTI_SELECT | false | false | true | false | — | — |
| LEAD | LEAD_INTERACTIONS | values | MULTI_SELECT | false | false | true | false | — | — |
| LEAD | SAVED_LEADS_AND_ACCOUNTS | values | MULTI_SELECT | false | false | true | false | — | — |
| ACCOUNT | ANNUAL_REVENUE | range | RANGE_DROPDOWN | false | false | false | false | — | — |
| ACCOUNT | COMPANY_HEADCOUNT | values | MULTI_SELECT | false | false | false | false | — | `01KZQ5T…/0016` |
| ACCOUNT | COMPANY_HEADCOUNT_GROWTH | range | RANGE_TEXT | false | false | false | false | — | — |
| ACCOUNT | HEADQUARTERS_LOCATION | aggregate | AGGREGATE | false | false | false | false | — | — |
| ACCOUNT | REGION | values | MULTI_SELECT | true | false | true | true | HEADQUARTERS_LOCATION | `01KZQ5T…/0016` |
| ACCOUNT | POSTAL_CODE | values | MULTI_SELECT | true | true | false | true | HEADQUARTERS_LOCATION | — |
| ACCOUNT | INDUSTRY | values | MULTI_SELECT | true | false | true | true | — | `01KZQ5T…/0016` |
| ACCOUNT | NUM_OF_FOLLOWERS | values | MULTI_SELECT | false | false | false | false | — | — |
| ACCOUNT | DEPARTMENT_HEADCOUNT | range | RANGE_TEXT | false | false | false | false | — | — |
| ACCOUNT | DEPARTMENT_HEADCOUNT_GROWTH | range | RANGE_TEXT | false | false | false | false | — | `01KZQ5T…/0016` |
| ACCOUNT | FORTUNE | values | MULTI_SELECT | false | false | false | false | — | — |
| ACCOUNT | JOB_OPPORTUNITIES | values | MULTI_SELECT | false | false | false | false | — | `01KZQ5T…/0016` |
| ACCOUNT | ACCOUNT_ACTIVITIES | values | MULTI_SELECT | false | false | false | false | — | — |
| ACCOUNT | RELATIONSHIP | values | MULTI_SELECT | false | false | false | false | — | — |
| ACCOUNT | ACCOUNTS_IN_CRM | values | MULTI_SELECT | false | false | true | false | — | — |
| ACCOUNT | SAVED_ACCOUNTS | values | MULTI_SELECT | false | false | false | false | — | — |
| ACCOUNT | ACCOUNT_LIST | values | MULTI_SELECT | true | false | true | true | — | — |

ANNUAL_REVENUE's accepted values and currency sub-filters, POSTAL_CODE's radius sub-filters,
and both department range sub-filter sets are retained in the fixture and parsed into catalog
rows. Tests pin representative ids and counts; they are not copied into this map as a second
source of truth.

Range validation also consumes `rangeConfig.inputType` and `rangeConfig.minValue` directly from
the fixture. Numeric JSON input is canonicalized once by `FilterSpec`; non-canonical strings and
values outside those measured constraints refuse before URL construction (D428).

## The vocabulary endpoint — measured 2026-08-11, run `01KZR9KTGPVR1BB03WPQS6YVMB`

The catalog above says which filters exist and what shape each one is. It does **not** carry a
single option value: `COMPANY_HEADCOUNT`'s entry is config and a `facetTypeaheadType`, nothing
more. The values come from one endpoint, and this operator-driven session is where it was first
captured.

    GET /sales-api/salesApiFacetTypeahead?q=query&start=0&count=<n>&type=<TYPE>[&query=<prefix>]

`type` is the catalog's `facetTypeaheadType`, not its filter type — `SENIORITY_LEVEL` fetches
`SENIORITY_V2`, and `YEARS_AT_CURRENT_COMPANY`, `YEARS_IN_CURRENT_POSITION` and
`YEARS_OF_EXPERIENCE` all fetch the one shared `TENURE` list. The response is
`{ elements: [...], paging: { count, start, links } }`.

Two request patterns, and the catalog's `typeaheadSupported` boolean predicts which one fires:

- **`typeaheadSupported: false`** — one `count=100` request with no `query`, on dropdown open.
  The reply is the complete closed enum. These are the fully harvestable facets.
- **`typeaheadSupported: true`** — a `count=100` seed request on open, then one `count=10`
  request per keystroke, debounced. The seed is a suggestion set, not the enum.

Element shape varies by type and the extra keys matter for classification:

| Keys present | Types observed | Meaning |
|---|---|---|
| `id`, `displayValue` | closed enums | pure taxonomy row |
| + `headline`, `headlineV2` | BING_GEO, INDUSTRY, TITLE | taxonomy row with a disambiguating label |
| + `children` | COMPANY_WITH_LIST | entity plus nested list membership |
| + `icon`, `listEntitiesCount` | ACCOUNT_LIST, LEAD_LIST | operator's own saved lists |
| + `address`, `employeeCountRange`, `industry`, `displayImage` | SCHOOL | full entity record |

### What this run captured, by type

Counts are `elements.length` in the named archive body under `runs/01KZR9KTGPVR1BB03WPQS6YVMB/raw/`.

| Type | Prefix | Rows | Archive | Scope |
|---|---|---:|---|---|
| INDUSTRY | — | 494 | `0093-c1abdc5c9460ff1e` | public |
| FUNCTION | — | 26 | `0047-f836d3b836631df0` | public |
| PROFILE_LANGUAGE | — | 22 | `0111-f836d3b836631df0` | public |
| SENIORITY_V2 | — | 10 | `0056-f836d3b836631df0` | public |
| COMPANY_SIZE | — | 9 | `0038-f836d3b836631df0` | public |
| COMPANY_TYPE | — | 8 | `0043-f836d3b836631df0` | public |
| TENURE | — | 5 | `0086-f836d3b836631df0` | public |
| RELATIONSHIP | — | 4 | `0164-f836d3b836631df0` | public |
| BING_GEO | — | 13 | `0044-cdbc2772623c8c05` | public, seed only |
| BING_GEO | `uni`, `unite` | 10, 10 | `0046-…`, `0091-83c180faa418178a` | public, prefix only |
| TITLE | `founder`/`owner`/`ceo` | 3, 10, 10 | `0051-…`, `0052-…`, `0053-…` | public, prefix only |
| INDUSTRY | `soft`, `softwa` | 6, 6 | `0094-…`, `0096-…` | public, redundant with the full list |
| SCHOOL | `lahore` | 10 | `0126-dad5cc3598bbec5a` | entity records, not taxonomy |
| PERSONA / ACCOUNT_LIST / LEAD_LIST | — | 2, 3, 2 | `0230-…`, `0232-…`, `0235-…` | **operator-scoped (D442)** |
| LEAD_INTERACTIONS / SAVED_LEADS_AND_ACCOUNTS | — | 2, 2 | `0237-…`, `0247-…` | operator-scoped |
| COMPANY_WITH_LIST | —, `l`, `la` | 2, 2, 2 | `0036-…`, `0040-…`, `0042-…` | **operator-scoped (D442)** |
| TITLE, GROUP, SCHOOL, CONNECTION_OF | — | 0 | `0049-…`, `0114-…`, `0123-…`, `0168-…` | empty seed |

`CONNECTION_OF` returned zero elements, so no graph edge entered the archive despite the
control being opened.

### Not captured, and why

- **The six ACCOUNT-only enums** — `COMPANY_SIZE_ACCOUNT_SEARCH`, `FORTUNE`,
  `JOB_OPPORTUNITIES`, `ACCOUNT_ACTIVITIES`, `NUM_OF_FOLLOWERS`,
  `RELATIONSHIP_ACCOUNT_SEARCH`. They are named in the catalog but their typeahead endpoint
  never fired: this was a LEAD session and those controls do not exist on `/sales/search/people`.
  They need the Account session.
- **`BING_GEO_POSTAL_CODE`** — never opened.
- **Geography and title in full.** Both are prefix-gated and unbounded; a complete enumeration
  does not exist behind any single request, and no number of prefixes makes it complete. This
  is structural, not a session shortfall.

### Cost, measured

15 `salesApiLeadSearch` requests across ~7 minutes of filter work, against 25 pre-charged units
(D440) — 10 over-counted. The 32 `salesApiFacetTypeahead` requests were **not** metered as
search pages by the observer and are not search results; whether LinkedIn meters them
server-side is unknown and unmeasurable from here. The layout body arrived with shape hash
`3ff85d03efb79a26`, identical to run `01KZQNM34D61NTBDQNDVSZ45AV`'s, so the catalog is stable
across runs and builds.
