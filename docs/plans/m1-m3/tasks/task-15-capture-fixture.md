# Task 15 — Capture a real profile fixture

**Model:** Opus · **Depends on:** Tasks 8–12 · **Spec:** §6, §9 (profile.get), §11 M3

## Objective

The first real LinkedIn contact: a capture capability that opens one profile in the
worker tab, archives every profile-related response the page fetches, and a promotion
script that turns a run's captures into `fixtures/` plus a **field map** — the document
Task 16's parser will be written against.

## Why it matters

This spends real page loads on the one account — there are no free retries. Everything
must work the first time or fail safely: challenge check before and after, budget
checked and recorded, and whatever happens, the raw archive keeps what was seen.

## Constraints

- All safety rails active: preflight, budget spend recorded (page load + distinct
  profile), challenge detection after navigation and before declaring success, human
  pacing (Task 8) for any scrolling needed to trigger lazy-loaded fetches, dwell time
  randomized. This is a real profile view — make it look like one.
- Input URL handling must be pure and tested offline: canonicalize profile URLs, strip
  tracking parameters, accept bare vanity slugs and Sales Navigator lead URLs, reject
  non-profile and non-LinkedIn URLs loudly.
- Which Voyager/GraphQL endpoints the profile page fetches is **discovered from the
  capture, not assumed from memory** — start from plausible patterns, then correct them
  against what the tap actually saw. Expect current LinkedIn to lean on GraphQL
  endpoints; the capture's summary must make it obvious whether the watched patterns
  matched reality (counts of hits per pattern, and of profile-ish responses that
  matched nothing).
- Fixture promotion copies archived bodies into `fixtures/profile.get/` (gitignored),
  deduplicated by shape hash, and writes a human-readable field map beside them: where
  in the JSON the person's URN, name, headline, location, and experience entries live.
  The field map is Task 16's specification — invest in it.
- The capability follows the full contract: receipt, events, artifacts, correct exit
  codes. On challenge: screenshot, checkpoint, exit 2, stop (D6).

## Deliverables

The capture capability (registered in the CLI, with README), the promotion script, and
offline tests for URL normalization. The capture itself is verified live.

## Acceptance criteria

- Offline tests pass; typecheck clean.
- **Live, once, operator-supervised:** one run against a real profile produces an ok
  receipt, archived raw bodies, a budget entry, and no challenge; promotion then yields
  at least one fixture in `fixtures/profile.get/` with a field map that names real
  paths into the captured JSON. If a pattern mismatch or challenge occurs, stop and
  report rather than retrying.
