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
