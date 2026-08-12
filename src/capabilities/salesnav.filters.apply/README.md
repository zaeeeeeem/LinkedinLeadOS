# `salesnav.filters.apply`

The metered half of the M6 filter self-test loop. It takes a typed `FilterSpec`, runs Task
41's provenance-backed builder before any spend, navigates once to the URL that builder
returns, and reports — from captured bodies only — **which filters LinkedIn actually searched
on** and **how large the audience is**.

It never accepts a URL argument (D450). A caller cannot hand it a query assembled elsewhere,
so vocabulary validation cannot be bypassed. The loop composes specs, not strings.

## Cost and bounds

**1 page load + 1 search page + 0 profile opens** per invocation. Daily sub-cap **10 / 10 / 0**
(D455). Page 1 only — no pager control of any kind lives here; pagination belongs to
`salesnav.leads.list` / `salesnav.accounts.list`. Zero clicks, keystrokes and wheel events.

**No capability loops applies internally.** The iterate-until-converged behavior is the agent
driving this CLI, so a runaway loop is structurally impossible rather than merely capped.

## Verticals

| Spec `vertical` | Route | Named response | `searches.kind` |
|---|---|---|---|
| `LEAD` | `/sales/search/people` | `salesApiLeadSearch` | `sn_leads` |
| `ACCOUNT` | `/sales/search/company` | `salesApiAccountSearch` | `sn_accounts` |

## The verdict

Per built filter, one of **honored / rewritten / dropped**, computed by comparing the
builder's query with the raw `query` parameter of the **named captured request** — never the
address bar, which is known to lie on this surface (D413), and never the rendered page. The
comparison is exact and field-for-field, including value order; a reordered subtree is a
rewrite, not an inferred equivalence (D433). Captured types that were not built are reported
as **injected**, and `recentSearchParam` is reported separately.

A rewritten, dropped or injected filter raises a non-zero warning
(`FILTER_REWRITTEN` / `FILTER_DROPPED` / `FILTER_INJECTED` / `RECENT_SEARCH_ECHO_CHANGED`) —
never a silently smaller audience.

Two flags, and the loop reads the first (D456):

- **`audience_clean`** — every built filter honored and no filter type injected. Nothing that
  changes *who* was searched. This is the shape that means "LinkedIn searched the audience I
  described".
- **`clean`** — `audience_clean` **and** the request envelope unchanged. Strictly stronger, and
  measured to be **false on an ordinary healthy load**: LinkedIn prepends
  `recentSearchParam:(doLogHistory:true)` to a query built without one (D457, run
  `01KZT4AJWX4G59KMHZM2R2JGP4`). That is a logging flag, not an audience change.

`paging.total` is LinkedIn's own estimate and may be rounded; the loop targets bands, never
exact numbers. **Zero results is a finding, not a failure**: exit 0, count 0.

The executed `session_id` comes from `$.metadata.tracking.sessionId` of the named response —
the only place it is measured on a cold page-1 load, because the page-1 request carries no
`trackingParam` (D451). Absent yields `null` plus a `SESSION_ID_ABSENT` warning rather than an
invented id. Per D391 a prior execution's session is **not** a reusable target: hand
`leads.list` the built URL, not the session.

## Storage

One `searches` row with **zero `search_results`** (D454): `search_id` is the run id, `kind` is
the vertical's kind, `filter_url` is the built URL, and `filter_json` carries the verdict,
paging, session id and the named archive id. It is written **after** the verdict is proved,
using insert-only `insertSearch` — apply is single-shot and has no resume path to adopt a
prior row. `--no-store` skips the write and says so on the receipt.

This widens `searches` from "a search whose rows were read" to "a search that was executed".
Note the deliberate asymmetry: `filter_url` carries real filter values into the operator's own
Supabase, exactly as `salesnav.leads.list` already stores an operator-supplied URL, while
**stdout keeps the stricter rule** — the receipt carries type names, verdicts, counts and
hashes, never a filter value.

## Exit codes

`0` ran and verified — **including count 0, and including verdicts with drops**; the loop
decides what a drop means, apply reports it. `2` challenge · `3` rate-limited · `4` auth dead ·
`5` parse drift · `6` transient · `7` budget exhausted. A build refusal is `1`, except
catalog/registry/provenance codes which are drift.

Exit 5 is reserved for evidence failures, each naming its archive: no named search response
captured, a captured request with no `query`, missing or non-integer paging, a response that
does not identify page 1, more than one distinct search query on one navigation, or a query
either side cannot be parsed. Catalog hash drift is a warning
(`FILTER_CATALOG_DRIFT` / `FILTER_CATALOG_NOT_CAPTURED`) unless it breaks the run's own claim.

## Invocation

```bash
./node_modules/.bin/tsx src/cli/index.ts salesnav.filters.apply --spec="$SPEC_JSON"
```

For an operator-scoped spec, keep the JSON in a shell variable and invoke the local CLI
directly. **Do not use the npm script wrapper**: npm echoes the expanded command line before
the receipt and would print private filter values (D432).

Every invocation is live and requires fresh operator approval immediately before execution.
An earlier approval never carries over, and a failed attempt is not retried under the old one.
