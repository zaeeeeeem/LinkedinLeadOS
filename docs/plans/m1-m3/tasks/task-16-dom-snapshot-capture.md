# Task 16 — DOM snapshot capture + profile fixture

**Model:** Opus · **Depends on:** Task 15 (capture, promoter, field map) · **Spec:** §6, §9, the 2026-08-09 addendum · **Decisions:** D116, D121, D123

> **2026-08-09 — resolved by D123.** No SPA navigation, no Voyager-content probe. The cold
> load Task 15 ships already captures the Voyager identity body and renders the full page;
> the one missing piece is a snapshot of the *rendered DOM*, which is where the subject's
> content actually is (D121). This task adds that snapshot and promotes it as the parser's
> fixture. Content comes from DOM, identity stays on Voyager (D123).

> **2026-08-09 — outcome. The identity criterion below rested on a false premise (D126).**
> The snapshot half succeeded as specified. The identity check ran, and its answer is that
> `voyagerIdentityDashProfiles` returns the **operator's own** urn, not the subject's — D121
> read that body without comparing it to `/voyager/api/me`, and it never carried the subject.
> The check is a first-class receipt outcome (`IDENTITY_URN_IS_SESSION`), which is what this
> file asked for in the "not a silent zero" case. The subject's identity turned out to be in
> the DOM, in the SDUI card-ref namespace (D127), and the field map names it. Replacing
> D123's identity source is an operator decision and is left open.
>
> **Since resolved by D130**, and the receipt caught up in D130's amendment: identity comes
> from the card-ref namespace, and `IDENTITY_URN_IS_SESSION` no longer exists — it would have
> fired on every capture forever, so the Voyager check is a receipt *field* now, not a
> warning. The identity warnings are `SUBJECT_IDENTITY_UNRESOLVED`,
> `SUBJECT_IDENTITY_IS_SESSION` and `SUBJECT_CARD_NAMES_UNRECOGNISED`.

## Objective

Extend the existing cold-load profile capture to take a **rendered-DOM snapshot** after
layout settles, archive it like any captured body, and promote it (with a field map) as the
fixture Task 17's parser is written against. Confirm, on the same run, that the subject's urn
is present in the captured `voyagerIdentityDashProfiles` body.

## Why it matters

D121 proved the content is in the rendered DOM, not on any Voyager endpoint, on a cold load.
The parser cannot be written against invented markup (D119/D12), so a real snapshot is the
prerequisite. This spends a real page load on the one account — it must work first time or
fail safely.

## Constraints

- **No navigation change.** Keep Task 15's cold load, its layout-settle wait (D115), pacing,
  budget, and challenge gate. This task adds a snapshot step; it does not touch how the tab
  reaches the profile.
- **The snapshot is a DOM read, permitted by D123 for content.** Capture
  `document.documentElement.outerHTML` (or the main scroller subtree) via a single
  `Runtime.evaluate` after layout settles, and archive it through the raw archive (D2) so the
  parser runs offline against it. It is not a network body — record it distinctly from tapped
  responses, but store it the same raw-first way.
- **Take the snapshot after the content is rendered.** D115: the real scroller is
  `main#workspace`, not the document; sections render lazily as it scrolls. Ensure the
  subject's main container has rendered (the human-paced scroll from Task 15 already drives
  this) before snapshotting, and record whether it had — a snapshot of a half-rendered page is
  a visible warning, not a silent short fixture.
- **Identity check, not a probe.** Assert the run captured `voyagerIdentityDashProfiles` and
  that it carries the subject's urn (D121 path), from the body, keyed to the run's own subject
  (D118/D119). If it did not, that is a first-class visible outcome on the receipt, not a
  silent zero.
- **Promotion** reuses Task 15's promoter and its subject / private-endpoint rules (D118) and
  identity-marking (D119), extended to promote the DOM snapshot as the content fixture. The
  field map written beside it (D119) is Task 17's specification: it must name the DOM location
  of headline, location, and the experience list **within the subject's main container**, and
  must not offer a sidebar-suggestion node or an operator-identity urn as the subject.
- **Safety unchanged:** preflight, budget spend recorded, challenge detection after
  navigation and before success, no forged requests (D1), Network-only attach (D8). On
  challenge: screenshot, checkpoint, exit 2, stop (D6).

## Deliverables

The snapshot step in the capture path, its archival, the promoter extension, and offline
tests for anything pure (snapshot archival wiring, subject-container identification helpers if
any are pure). The snapshot and identity check are proven live.

## Acceptance criteria

- Offline tests pass; typecheck clean.
- **Live, once, operator-supervised:** one supervised cold-load run captures the Voyager
  identity body (subject urn present) and a rendered-DOM snapshot in which the subject's main
  container is present and distinguishable from the sidebar; promotion yields a fixture in
  `fixtures/profile.get/` whose field map names real DOM paths to at least headline, location,
  and an experience list inside the subject container. If the page did not render the content,
  stop and report the honest outcome — do not retry blindly.
- **Discipline gate** — `CONTEXT.md`, "What review actually catches". Subject-hood is decided
  from the body / from container scope, never from a URL, and never resolves to the operator's
  own identity (D119). Every silent-loss path — snapshot of a half-rendered page, identity
  body absent — is a visible warning. Prove the not-rendered branch reports it, not just the
  happy path.
