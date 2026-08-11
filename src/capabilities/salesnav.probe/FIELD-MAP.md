# FIELD-MAP — Sales Navigator search surfaces

**Measured 2026-08-10**, run `01KZP693DEWVP0S90K7C7XQ997` (leads page 1) and
`01KZP61QK0N7CMNJ38PFTB8PSC` (`/sales/` app root). Chrome 151, live, operator-supervised.
Every path below is pinned by `tests/salesnav-fieldmap.test.ts` against the promoted
fixture; nothing here is inferred from an older build or from the reference worker.

Values are never quoted in this file — only paths, types and counts (M5 CONTEXT rule 6).

## Verdict 1 — the rows are in a labeled body. **M5 needs no DOM exception.**

`GET /sales-api/salesApiLeadSearch?q=searchQuery&query=…` returns the result rows as
JSON. 154 KB, 24 elements, 59 `fs_salesProfile` urns on the measured page.

This **overturns the working prior.** The reference worker read Sales Nav rows out of the
DOM (`ol.artdeco-list`, `data-anonymize`) and only ever captured `salesApiProfiles` after
clicking a lead panel open. On this build the search page fetches its own rows over the
network on a cold load, so Task 38 parses bodies and CLAUDE.md's five-item DOM exception
list **does not grow**. That is the outcome the first rule wants.

The DOM snapshot is still archived per surface, as corroboration and as the parse-drift
tripwire — not as a source.

### `salesApiLeadSearch` body

| path | type | presence | meaning |
|---|---|---|---|
| `paging.total` | int | 1/1 | total matching leads across the whole search |
| `paging.count` | int | 1/1 | page size requested (25 on the measured page) |
| `paging.start` | int | 1/1 | **the offset this page began at** — the pagination key |
| `paging.links` | array | 1/1 | empty on the measured page; not a usable next-link |
| `metadata.totalDisplayCount` | string | 1/1 | the count as the UI renders it, already abbreviated |
| `metadata.recentSearchId` | string | 1/1 | LinkedIn's handle for this search execution |
| `metadata.searchTitle` | string | 1/1 | the search's own title |
| `metadata.filters` | array | 1/1 | the filters this execution ran under |
| `elements` | array | 1/1 | the result rows; 24 elements on a `count: 25` page |

### `salesApiLeadSearch` result row — `elements[i]`

Presence is out of the 24 rows on the measured page.

| path | type | presence | meaning |
|---|---|---|---|
| `entityUrn` | string | 24/24 | **row identity.** `urn:li:fs_salesProfile:(<profileId>,<searchContext>,<token>)` — compound, see below |
| `objectUrn` | string | 24/24 | `urn:li:member:<numericId>` — the stable member identity |
| `fullName` / `firstName` / `lastName` | string | 24/24 | the lead's name |
| `geoRegion` | string | 24/24 | location as the row renders it |
| `degree` | int | 24/24 | connection degree |
| `summary` | string | **23/24** | the headline. **Not always present — the one optional field measured** |
| `currentPositions` | array | 24/24 | current roles; see below |
| `spotlightBadges` | array | 24/24 | `{id, displayValue, associatedEntityUrnsUnions, popup}` |
| `trackingId` | string | 24/24 | LinkedIn's own per-row tracking handle |
| `listCount` | int | 24/24 | how many of the operator's lists hold this lead |
| `saved` / `viewed` / `premium` / `openLink` / `memorialized` / `pendingInvitation` / `blockThirdPartyDataSharing` | bool | 24/24 | row state flags |
| `profilePictureDisplayImage` | object | 24/24 | `{rootUrl, artifacts[4]}` |

### `elements[i].currentPositions[j]`

29 positions across the 24 rows; every row has at least one. Presence is out of 29.

| path | type | presence | meaning |
|---|---|---|---|
| `companyName` | string | 29/29 | company name as the row carries it |
| `title` | string | 29/29 | job title |
| `posId` | int | 29/29 | LinkedIn's position id |
| `current` | bool | 29/29 | whether this position is current |
| `tenureAtCompany` / `tenureAtPosition` | object | 29/29 | computed tenure |
| `companyUrn` | string | **27/29** | the company's urn — the account link Task 38 needs |
| `companyUrnResolutionResult` | object | **27/29** | the resolved company, when the response inlines one |
| `startedOn` | object | **27/29** | start date |
| `description` | string | **21/29** | free-text role description |

**`companyUrn` is not universal, and this was caught by the pinning test rather than by
reading the body — the first draft of this file asserted 29/29 and was wrong.** Two
positions carry a `companyName` with no urn, which is what a company with no LinkedIn page
looks like. Every one of the 24 rows still has at least one position that *does* carry a
urn, so a row is always joinable to some account; an individual position is not.

Task 38 must therefore treat `companyUrn` as optional per position and must not key a
`search_results` row on it. `companyName` without a urn is a real, storable state, not a
parse failure.

### Identity — how a row's subject urn resolves, and how it refuses

`entityUrn` is **compound**: `urn:li:fs_salesProfile:(<profileId>,<searchContext>,<token>)`.
Only the first member is the person. The second is the search context (`NAME_SEARCH` on the
measured page) and the third is a per-execution token — **neither is stable across searches,
so the raw `entityUrn` must never be used as a dedupe key.**

`objectUrn` (`urn:li:member:<id>`) is the stable identity and is present on every row.

The D126 refusal still applies: a row whose identity resolves to the session urn, or to
nothing, stores nothing. `sessionUrnsOf` reported **0** session urns across the probe run,
so no row on the measured page was the operator.

## Verdict 2 — pagination is **click-only**. Granted 2026-08-11 (D400), proved live (D404).

Measured on leads page 1: the pager renders, and it is entirely buttons.

| measurement | value |
|---|---|
| pager present | yes |
| controls | **12 × `button`, 0 × `a`** |
| anchors carrying an href | **0** |
| hrefs carrying `page=N` | **0** |
| `page` / `totalPages` from the pager's own a11y text | 1 / 100 |
| `page` parameter on the landed url | **absent** |

**The reference worker's `?page=N` url form is not offered by this build.** That worker
refused to use it on live-risk grounds while confirming the url carried it; today the
question is moot in the other direction — the url does not carry it and the address bar
never produces it. Reaching page 2 requires **clicking a pager button**, a class of action
this toolkit has never taken.

Per M5 CONTEXT rule 4 that was an operator decision (the D323 precedent). **It landed on
2026-08-11 as D400** — next/previous only, inside the pager, by accessible name,
resolved-or-refused, trusted `HumanCursor` click. Tasks 39 and 40 are unblocked.

**Proved live** (run `01KZQ4S9FYEB5NCBPQC8FZSGK5`): `<button aria-label="Next">`, one match,
clicked after one wheel pass; `salesApiLeadSearch` then reported `paging.start 25` against
page 1's `0`, and the `sessionId` held across the click.

`paging.start` / `paging.count` are the **arrival check** (D400 clause 6) — a pager label can
advance on a re-render that changed no rows. Read them off the body that matched a named
search pattern, never off the largest body: on the accounts surface
`salesApiSearchFilterLayout` (81 KB) outweighs `salesApiAccountSearch` (53 KB) and carries a
`paging` block of its own, which read `count 10` for a page of 25 (D407).

None of this is permission to forge a request — CLAUDE.md's "never forge a request LinkedIn's
own UI did not already issue" is unchanged. **After** the click the landed url does carry
`page=2`, while the pager still renders 0 anchors: the url exists only once the UI has been
driven there, so it is not cold-navigable and synthesizing it remains the "teleporting" form
the reference worker refused.

## Surface structure

| measurement | leads search page 1 | `/sales/` app root |
|---|---|---|
| landed url | `/sales/search/people?query=…&sessionId=…` | `/sales/home` |
| scroller | **`div#search-results-container`**, 4673 / 627 px | the document itself |
| rows: `/sales/lead/` links | 22 | 0 |
| rows: `/sales/company/` links | 10 | 10 |
| largest list container | `ol`, 24 items, 11 carrying row links | — |
| `data-testid` on rows | **none** | none |
| `data-anonymize` on rows | none inside row scope | 1 (`headshot-photo`) |
| `componentkey` | 0 | 0 |
| `bpr-guid` data islands | 0 | 0 |
| embedded `ld+json` / `application/json` | 0 / 0 | 0 / 0 |

Two consequences:

- **The scroller is `div#search-results-container`, not the document and not
  `main#workspace`.** D115 again: measure it, never assume it. The document scrolls barely
  at all on this surface.
- **This surface offers no `data-testid` and no `componentkey`.** The D305/D313 discipline
  of anchoring DOM scope on `data-testid` has nothing to anchor on here. It does not matter
  for parsing, because verdict 1 says the rows come from a body — but it is why any future
  DOM work on this surface would need its own anchor decision first.

## `sessionId` — the result set is pinned per execution

The requested url carried no `sessionId`; the landed url did
(`…&sessionId=<opaque>&…`). LinkedIn mints one per search execution and pins the result set
and the moment its filters were evaluated to it.

Page numbers therefore only mean the same thing **within one `sessionId`**. Task 39's
resume must treat a changed `sessionId` as a different search rather than a continuation —
`normalizeSalesNavUrl` already extracts it (`SalesNavTarget.sessionId`) for exactly this.

## Other endpoints the search page fetches

Archived and available; none of them is the row source.

| endpoint | bytes | what it carries |
|---|---|---|
| `salesApiProfiles?ids=List(...)` | 46 KB | a batch profile hydrate, 56 urns — fetched *alongside* the search, not by a click |
| `salesApiCompanies/<id>` | 10–12 KB | per-company hydrate for companies on the page |
| `salesApiMessagingPresenceStatuses` | < 1 KB | presence dots |
| `salesApiNavChrome` | 1–2 KB | the app chrome; carries the operator's own `fs_salesProfile` |
| `salesApiSearchFilterLayout` | — | the filter rail's layout (M6's surface, not M5's) |
| `salesApiLego` | < 1 KB | promo-slot widgets |

`salesApiNavChrome` is an **operator-identity-bearing** body and is excluded from fixtures
as a private endpoint (D118/D119) — the promoter skipped 8 such bodies on this run.


## The accounts search — `salesApiAccountSearch` (measured 2026-08-11, run `01KZQ5TXC23T3FFBJ72P8CE85J`)

Measured on an operator-supplied company search url (headcount + region + industry + hiring +
department growth). **1 page load / 1 search page, exit 0.**

### Body

| path | value |
|---|---|
| `paging.total` | 660 |
| `paging.count` | **25** — the same page size as leads, not the 10 a size-first read reported (D407) |
| `paging.start` | 0 |
| `elements` | 25 |
| pager's own a11y text | page 1 of 27 |

### `elements[i]` — 12 fields, **all 25/25 present**

| path | meaning | note |
|---|---|---|
| `entityUrn` | `urn:li:fs_salesCompany:<id>` | **simple, not compound** — unlike a lead row's |
| `companyName` | the account's name | |
| `industry` | e.g. "Software Development" | |
| `employeeCountRange` | e.g. "11-50 employees" | a display string, not a range object |
| `employeeDisplayCount` | e.g. 32 | the exact count beside the banded one |
| `description` | the company's own About text | long; not a search snippet |
| `companyPictureDisplayImage` | logo artifacts | |
| `spotlightBadges` | e.g. "Hiring on Linkedin", with popup copy | why the row matched a spotlight filter |
| `listCount`, `saved` | the operator's own list state | operator data, not the account's |
| `$recipeType`, `trackingId` | plumbing | `trackingId` is per-execution — never a key |

**`objectUrn` does not exist on an account row, and `entityUrn` is not compound.** That is
the opposite of the leads side, where D354 makes `objectUrn` the dedupe key precisely because
`entityUrn` carries a per-execution search context. Task 38 therefore keys **per vertical**:
`objectUrn` for leads, `entityUrn` for accounts (D406).

### What is *not* in the body

`location` is **not** an account-row field. The rendered card shows one
(`data-anonymize="location"` × 23) and the only "location" strings in the body are the
sidebar's aggregated filter facets, not per-row values. The same holds for anything else the
card displays but the row does not carry.

**This does not grow CLAUDE.md's DOM exception list.** Spec §7 requires `search_id`, `page`,
`position`, `person_urn`/`company_urn` and `run_ref` from a search row — every one of which
the body carries. A company's location is entity data, and entity data comes from an L1
reader later (M5 CONTEXT rule 5: a search row never mints or freshens an entity). The list
stays closed at five.

### Surface structure

| measurement | accounts search page 1 |
|---|---|
| scroller | **`div#search-results-container`**, 4079 / 602 px — same as leads |
| `/sales/company/` links | 46 (23 rows × 2) |
| largest list container | `ol`, 25 items, 23 carrying row links |
| `data-testid` on rows | **none** |
| `data-anonymize` on rows | `company-logo`, `company-name`, `industry`, `company-size`, `location`, `person-blurb` — 23 each |
| pager | 12 × `button`, 0 anchors — identical to leads |

## Not measured

- ~~The accounts search~~ — **measured 2026-08-11**, see the section above. It needed an
  operator-supplied company-search url: the bare `/sales/search/company` renders an empty
  search-entry state and a synthesized filter url is refused (D357).
- ~~Page 2~~ — **measured 2026-08-11** on the leads side, by click (D404). **Accounts page 2
  is still unmeasured**: the probe has no `accounts2` surface, and nothing suggests it
  differs, which is not the same as having looked.
- **A second leads target.** Everything on the leads side is one persona search. One target
  cannot surface parse drift; the operator's filtered CXO url is the obvious second.
- **Saved searches.** Task 37's surface.
