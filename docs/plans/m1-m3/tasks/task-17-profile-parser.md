# Task 17 — Profile parser: identity and content, both from the DOM snapshot

**Model:** Opus · **Depends on:** Task 16 (DOM snapshot fixture + field map), Task 14 (row types) · **Spec:** §6, the 2026-08-09 addendum · **Decisions:** D130 (identity), D123 (content), D126/D127/D128, D1/D2/D5 · **Reserved decision range:** D131–D139 (D130 was taken by the operator decision this task implements)

> **Re-cut 2026-08-09 after Task 16's live run.** The previous version of this file said
> identity comes from the Voyager `voyagerIdentityDashProfiles` body. That is false and was
> proven so: the endpoint takes the *operator's own* urn as its input and returns the operator,
> on every page (D126). Zero of 27 archived bodies in the live run carried the subject's urn.
> The operator's decision (D130) is that identity comes from the DOM snapshot too. Nothing
> below asks you to read a Voyager body for the subject.

## Objective

Turn Task 16's archived DOM snapshot into typed person + experience rows: the subject's **urn**
from the SDUI card-ref namespace, and **content** — name, headline, location, positions — from
the subject's own cards within that same namespace. Every row is tagged DOM-sourced.

## Why it matters

This is the first data the project reads off the DOM, and the first parser whose output is a
database **key** rather than a field. A wrong key writes a row under the wrong person and
nothing ever notices, which is why D130's argument is about failure direction rather than drift
rate — and why the properties below are acceptance criteria and not preferences.

## What Task 16 already established (read `fixtures/profile.get/FIELD-MAP.md` first)

Do not rediscover any of this by hand; the field map has the concrete paths, and
`src/core/fixtures/dommap.ts` already implements the scope resolution.

- Class names are content-hashed (`_3bbeb416`) and churn every deploy. **Nothing may read one.**
- Every profile card carries
  `componentkey="com.linkedin.sdui.profile.card.ref<PROFILE_ID><CardName>"`. The live page had
  23 distinct card names under one id: `Topcard`, `About`, `ExperienceTopLevelSection`,
  `EducationTopLevelSection`, `Skills`, `Projects`, `RecommendationsTopLevel`, and more.
- The subject's id is the namespace those cards agree on. `resolveSubjectScope` derives it and
  returns `null` rather than guessing — three distinct ways it could have returned a confident
  wrong id were found and closed in Task 16, each regression-tested.
- **`SuggestedForYou` holds other people** and is namespaced by the subject's own id, so
  scoping by id alone does not exclude it. The card *name* is what does.
- Addressing splits by field, and `FIELD-MAP.md` labels every hit with which it is (D128):
  card-level lookups (`experience`, `education`, `skills`, `about`) are one `componentkey`
  selector each and survive a restyle; inside the Topcard, headline and the company·school line
  are positional and location is found by the shape of its own text.

## Constraints

- **Pure functions of the archived snapshot.** No I/O, no network, no globals, no live DOM read.
  Parse the archived html offline with `cheerio` (D125), never `innerHTML` against a live page.
- **Identity is resolved, never guessed (D130).** The urn comes from the card-ref namespace. If
  it does not resolve, the parser returns no identity and the caller stores nothing — it must
  never fall back to the vanity slug, to a member urn, or to "the first profile urn in the
  document". The vanity and the top card's member urn are parsed and carried as
  **corroboration** alongside, not as a key and not as a fallback chain.
- **Never the operator's own identity.** Whatever is resolved is checked against the session's
  urns from `/voyager/api/me` and reported if it matches (D119, and D126 is the third time this
  trap has been hit). Reuse `checkIdentity` rather than re-deriving it.
- **Scope by card name, not by container position.** Content is read only from the subject's own
  cards, with `SuggestedForYou` excluded. `main#workspace` contains the sidebar `aside`, so
  scoping to it proves nothing. A parser that reads the document and takes the first headline it
  finds is the exact D121 failure and must not pass review.
- **Drift is loud (D5, exit 5).** A field the subject's cards should carry and do not yields a
  typed warning naming the field and degrades that field — never throws, never a silent
  half-empty row, and a missing field stays distinguishable from a genuinely empty one. Given
  D128, weight this by basis: a positional field going missing is expected drift, a
  `componentkey` card going missing is a bigger signal.
- **Fields resolve by trying known variants** rather than one hardcoded path, so a layout change
  degrades field by field instead of wiping the record.
- Output maps onto Task 14's row types — read them from code first, and note `upsertPerson`'s
  ordering contract (D101/D105) rather than assuming it.
- Two test layers: **contract tests** always run (identity resolution and its refusal cases,
  card scoping, warning semantics, variant helpers, unrecognizable input); **fixture tests** run
  over `fixtures/profile.get/` and skip visibly when absent (§6).

## Deliverables

The parser entry point (identity + content assembled into the row types), the identity
resolver's parser-side wrapper, the DOM content parser with its scoping and field helpers, a
shared fixture loader, and both test layers, in the capability directory per repo convention.

## Acceptance criteria

- Contract tests green everywhere; typecheck clean.
- Fixture tests green on this machine against Task 16's snapshot, extracting: the subject urn
  `urn:li:fsd_profile:ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA`, the name, the headline, the
  location `San Francisco, California, United States`, and a non-empty, correctly ordered
  experience list — the live card holds 6 positions with titles, companies, date ranges and
  descriptions.
- **Scoping proven, not assumed:** the parser fed the `SuggestedForYou` card in isolation
  extracts **nothing** as the subject, and the subject's own extraction contains none of the 16
  member urns that card's suggestions carry.
- **Refusal proven:** a snapshot whose cards do not agree on one id yields no identity and no
  stored row, rather than a best guess. A snapshot resolving to the operator's own urn is
  reported, not accepted.
- **Discipline gate** — `CONTEXT.md`, "What review actually catches". Every claimed property
  pinned by a test, and every guard verified to fail when removed. Sharpest here: prove a
  moved or absent content field surfaces as drift with exit-5 semantics rather than a silent
  empty row, and prove the identity path has no fallback — deleting the card refs must produce
  nothing, never a vanity-keyed row.
