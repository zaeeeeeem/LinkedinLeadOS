# Task 31 — `job.get`

**Model:** Sonnet · **Depends on:** Task 30 (fixture), Task 25 (`jobs` write path)
**Spec:** §7 jobs, §9 · **Decisions owned:** D270–D279

> **UNBLOCKED 2026-08-09 — the operator approved the DOM-source exception (D305).**
>
> *Source verdict from Task 30 (D303, D304), measured twice:* **the job surface has no
> labeled-field source.**
>
> - Run `01KZKMJS9FD0H18VAZMFFVPEYB` (cold, API net): 25 bodies, `misses: 0`, **no job
>   endpoint at all** — the net's blind spot, not an absence (D303).
> - Run `01KZKNJ16QD3WSFJ3XMHTG4V1W` (widest net, `isLinkedInDataUrl`): 21 bodies,
>   **none under `/voyager/`**. `/jobs/view/<id>` is server-rendered SDUI and talks to
>   `/flagship-web/rsc-action/actions/component` instead.
> - The description **is** on the network, in a 6,654-byte component response — but as
>   an **RSC flight tree**, addressed only by position. No `"description"` key, no
>   `"title"`, no job urn in that body.
> - Across all 21 bodies: no `listedAt`, no `originalListedAt`, no `workplaceTypes`, no
>   `workRemoteAllowed`, no `formattedLocation`, no `companyDetails`, no
>   `urn:li:fsd_company:`. The only structured job reference is `urn:li:jobPosting:<id>`
>   in the document, inside *report* actions — identity, not content.
>
> **So this reader reads the DOM, under D305, in exactly the profile reader's shape:**
>
> - Source is the **`outerHTML` snapshot** the probe already archives, parsed
>   **offline**. Never a live `innerHTML` read, never the flight tree by position —
>   D121 stands.
> - Every row is **tagged DOM-sourced**.
> - Anchor on **`data-testid`**, never container position or class names: LinkedIn's
>   classes are hashed per build (`_5e09f4d5`) and change without notice. The
>   description sits under `data-testid="expandable-text-box"`, inside an `h2` labelled
>   "About the job".
> - Identity **resolved or refused**: the id comes from the normalized url and is
>   cross-checked against `urn:li:jobPosting:<id>` in the document. Disagreement stores
>   nothing rather than inventing a key.
>
> **One thing to fix first.** The promoter routes relevance and probes by family
> (`familyOf`) but **not the DOM map**, so `job.get`'s field map was generated with the
> *profile* card-ref rule and says "no subject scope, do not write a parser". That is a
> false alarm about the wrong rule. Route the DOM map by family, re-promote from
> `01KZKNJ16QD3WSFJ3XMHTG4V1W`, then work against the regenerated map.

## Objective

Full job posting detail into `jobs`, extending the row Task 25 may have created from the
company jobs list — filling the description and any detail-only fields.

## Constraints

- Parser pure and offline against Task 30's fixture; the description field is the point —
  store what the detail source carries, refuse to fabricate from the list card.
- Upsert on the canonical job id; a `job.get` after a `company.jobs` list enriches the
  same row (merges description in) rather than creating a duplicate — prove the merge.
- Company urn normalized and resolved-or-refused; ordering discipline as always.

## Deliverables

`src/capabilities/job.get/` with README; parser + tests; the `jobs` enrichment write path.

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: description presence, the
  list→detail merge on one id (no duplicate row), company-urn refusal on a session/trap urn.
- **Live gate, default flags:** exit 0 against a real posting; the enriched row verified
  by independent Supabase query showing the description populated.
- **Discipline gate** — all four m1-m3 review shapes.
