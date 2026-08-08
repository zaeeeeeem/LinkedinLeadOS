# Task 31 — `job.get`

**Model:** Sonnet · **Depends on:** Task 30 (fixture), Task 25 (`jobs` write path)
**Spec:** §7 jobs, §9 · **Decisions owned:** D270–D279

> **STILL BLOCKED 2026-08-09 — on one operator decision, and nothing else.**
> The probe has run twice and the measurement is complete; see D303 and D304.
>
> *Source verdict from Task 30:* **the job surface has no labeled-field source.**
>
> - Run `01KZKMJS9FD0H18VAZMFFVPEYB` (cold, API net): 25 bodies, `misses: 0`, **no job
>   endpoint at all**. That was the net's blind spot, not an absence — see D303.
> - Run `01KZKNJ16QD3WSFJ3XMHTG4V1W` (widest net, `isLinkedInDataUrl`): 21 bodies,
>   **none under `/voyager/`**. `/jobs/view/<id>` is server-rendered SDUI and talks to
>   `/flagship-web/rsc-action/actions/component` instead.
> - The description **is** on the network, in full, in a 6,654-byte component response —
>   but as an **RSC flight tree**, addressed only by position in a render tree. No
>   `"description"` key, no `"title"`, no job urn in that body.
> - Across all 21 bodies the §7 fields are absent everywhere: no `listedAt`, no
>   `workplaceTypes`, no `workRemoteAllowed`, no `formattedLocation`, no
>   `companyDetails`, no `urn:li:fsd_company:`. The only structured job reference is
>   `urn:li:jobPosting:<id>` in the document, inside *report* actions — identity, not
>   content.
>
> **[DECISION NEEDED — operator]** Two ways to read a posting, and this task may not
> pick one on its own:
>
> 1. **Extend the CLAUDE.md DOM-source exception to the job surface**, as D123/D130 did
>    for the profile reader: parse the archived DOM snapshot offline, tag every row
>    DOM-sourced, anchor on `data-testid` (the description sits under
>    `data-testid="expandable-text-box"`). *Recommended* — the precedent exists, the
>    snapshot is already archived raw, and those anchors are stabler than flight-row
>    indices.
> 2. **Read the RSC flight tree by position** — forbidden by D121, and the DOM's
>    fragility with worse ergonomics.
>
> **Before this task starts, two things must land regardless of which option wins:**
>
> - The promoter routes relevance and probes by family (`familyOf`) but **not the DOM
>   map**, so `job.get`'s field map was generated with the *profile* card-ref rule and
>   says "no subject scope, do not write a parser". That is a false alarm about the
>   wrong rule. Route the DOM map by family too, then re-promote.
> - The job document is HTML, so the promoter skips it as `not_json`. If option 1 wins,
>   the snapshot is the fixture and this is fine; if the verdict is ever revisited, the
>   document has to be promotable.

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
