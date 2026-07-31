# Task 16 — Profile parser, written against the captured fixture

**Model:** Opus · **Depends on:** Task 15 (its fixture and field map), Task 14 (row types) · **Spec:** §6, D1/D2/D5

## Objective

A pure parser turning a captured profile response body into typed person + experience
rows, developed entirely against the real fixture — zero LinkedIn requests, zero ban
risk. This is the pattern every future parser follows.

## Why it matters

The fixture's shape was unknown when the plan was written; the field map from Task 15
is the specification, and judgment about LinkedIn's response structure (URN formats,
nested GraphQL envelopes, absent-vs-null fields) is the actual work.

## Constraints

- The parser is a pure function of the body: no I/O, no network, no globals (D1's
  "network tap is source of truth" ends here — this consumes what the tap archived).
- Tolerant of drift by design: a missing field yields a typed warning naming the field
  (feeding `log:drift`, D5) and degrades that field, never throws. An unrecognizable
  body returns an empty result with a warning — the caller decides severity.
- Resolution of fields should try known path variants rather than one hardcoded path,
  so an A/B-shifted response degrades gracefully instead of failing wholesale.
- Two test layers: **contract tests** that always run (behavior on unrecognizable
  input, warning semantics, path-resolution helper) and **fixture tests** that run the
  parser over every file in `fixtures/profile.get/` asserting real fields come out —
  skipping with a clear message when fixtures are absent, so a fresh clone stays green
  (§6).
- Parsed output maps onto Task 14's row types — read them from code first.

## Deliverables

The parser, its path-resolution helper, a shared fixture loader for tests, and both
test layers, living in the capability's directory per the repo convention.

## Acceptance criteria

Contract tests green everywhere; fixture tests green on this machine (fixtures exist
from Task 15) and extract at minimum URN, name, headline, location, and a non-empty,
correctly-ordered experience list from the real capture; typecheck clean.

**Discipline gate** — `CONTEXT.md`, "What review actually catches". Every claimed property
pinned by a test. Sharpest here: prove what happens when a field the parser expects is
absent or moved. Parse drift has its own exit code (`5`) because silently returning a
half-empty row is the failure that reaches a customer — a missing field must be
distinguishable from a field that is genuinely empty.
