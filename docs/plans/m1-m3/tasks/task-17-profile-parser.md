# Task 17 — Profile parser: DOM content + Voyager identity

**Model:** Opus · **Depends on:** Task 16 (DOM snapshot fixture + field map, identity body), Task 14 (row types) · **Spec:** §6, the 2026-08-09 addendum · **Decisions:** D121, D123, D1/D2/D5

## Objective

Turn a captured profile into typed person + experience rows: **identity from the Voyager
`voyagerIdentityDashProfiles` body**, **content from the rendered-DOM snapshot** scoped to the
subject's main container. Every content row is tagged DOM-sourced.

## Why it matters

This is the first data read off the DOM the project allows (D123), and the first parser to
combine a labeled body (identity) with a churn-prone one (content). Scoping to the subject's
container so a "people also viewed" stranger is never read as the subject is the whole
correctness question — the RSC tree could not do it (D121); the rendered DOM can.

## Constraints

- **Pure functions of captured bodies/snapshots.** No I/O, no network, no globals, no live DOM
  read. The identity parser consumes the archived Voyager body; the content parser consumes the
  archived DOM snapshot from Task 16, parsed with an offline HTML parser — never a live
  `innerHTML` call.
- **Identity is Voyager, content is DOM (D123).** The subject urn (§7) comes from
  `identityDashProfilesByMemberIdentity["*elements"][0]` (D121 path, with variant fallbacks).
  Content rows carry a `source` discriminant marking them DOM-sourced so downstream never
  treats a scraped headline as a labeled field. Keying never depends on the DOM.
- **Container scoping is mandatory.** Content is read only from within the subject's main
  profile container (per Task 16's field map); the sidebar `aside` / "people also viewed" is
  explicitly out of scope. A parser that reads the whole document and takes the first headline
  it finds is the exact D121 failure and must not pass review.
- **Drift is loud (D5, exit 5).** A field the container should carry but does not yields a
  typed warning naming the field and degrades that field — never throws, never a silent
  half-empty row. A missing field is distinguishable from a genuinely empty one. An
  unrecognizable snapshot yields an empty result with a warning; the caller decides severity.
  Because DOM selectors are LinkedIn's to change, treat every content miss as expected drift.
- **Selectors resolve by trying known variants** rather than one hardcoded path, so a class
  rename degrades field-by-field instead of wiping the record. Identity path resolution does
  the same over its known Voyager variants.
- Output maps onto Task 14's row types — read them from code first. Two test layers:
  **contract tests** always run (identity extraction, container scoping, warning semantics,
  selector/path helpers, unrecognizable input); **fixture tests** run over
  `fixtures/profile.get/` and skip visibly when absent (§6).

## Deliverables

The parser entry point (identity + content assembled into the row types), the Voyager identity
parser, the DOM content parser with its container-scoping and selector helpers, a shared
fixture loader, and both test layers, in the capability directory per repo convention.

## Acceptance criteria

- Contract tests green everywhere; fixture tests green on this machine and extract urn (Voyager,
  identity-tagged) plus name, headline, location and a non-empty, correctly-ordered experience
  list (DOM, content-tagged) from Task 16's fixture; typecheck clean.
- A parser fed the *sidebar* portion of the snapshot in isolation extracts **nothing** as the
  subject — container scoping proven, not assumed.
- **Discipline gate** — `CONTEXT.md`, "What review actually catches". Every claimed property
  pinned by a test. Sharpest here: prove container scoping rejects a sidebar suggestion, and
  prove a moved/absent content field surfaces as drift with exit-5 semantics rather than a
  silent empty row.
