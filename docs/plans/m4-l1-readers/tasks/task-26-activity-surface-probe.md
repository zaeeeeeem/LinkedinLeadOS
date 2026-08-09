# Task 26 — Person-activity + post surface probe and fixtures (live)

**Model:** Opus · **Depends on:** Task 20 · **Spec:** §7 person_posts, §9 (`profile.posts`,
`profile.activity`, `post.get`) · **Decisions owned:** D220–D229
**Probe budget: max 5 page loads** (recent-activity/posts, recent-activity/reactions or
comments, one single-post permalink page, spares).

## Objective

Measure where the fields for `profile.posts`, `profile.activity` and `post.get` live, on
`/in/<vanity>/recent-activity/…` and a single-post permalink page. Deliver subject-scoped
fixtures and a tested FIELD-MAP for Tasks 27–29.

## Constraints

- Runs through the capability runner; reuse the `profile.capture` snapshot/scroller
  machinery; measure this surface's real scroller (the activity feed is its own scroll
  container — do not assume). Archive every body plus DOM snapshots after layout settles.
- **Sweep, per §7 `person_posts` field and per post-detail field:** which source carries
  post urn, author urn, text, posted_at (absolute vs relative — see below), reaction and
  comment counts, and for `post.get` the reactor/commenter lists. Post/activity feeds are
  where reposts and others' content interleave with the subject's own — the
  subject-vs-stranger boundary here is the whole game. Establish how author identity is
  resolved on a post card and check every candidate against `sessionUrnsOf`.
- **posted_at reality check:** the DOM shows relative time ("3d"); establish whether any
  source carries an absolute timestamp. If none does, that is a `[DECISION NEEDED]` on how
  `person_posts.posted_at` / `company_posts.posted_at` is populated — do not let each
  consuming task silently invent a conversion.
- **`profile.activity` distinction:** activity = reactions and comments the person *made*
  on others' content, which is a different capture than their own posts. Measure whether
  these are separable in the source and under which URL/tab.
- DOM-only fields → `[DECISION NEEDED]` for the operator to extend the CLAUDE.md exception
  to this surface (CONTEXT rule 7); Tasks 27–29 blocked on it.
- Fixtures subject-scoped, private endpoints/operator identity excluded or trap-marked.

## Deliverables

Archived probe runs; fixtures; `FIELD-MAP.md` with tested paths; source verdicts + the
posted_at decision written into Tasks 27–29; spend used vs budgeted on STATE.md.

## Acceptance criteria

- Offline suite green; typecheck clean; every FIELD-MAP path resolves against its fixture
  with meaning-checked assertions; the subject/stranger boundary proven with at least one
  interleaved-repost trap that must not resolve as the subject's post.
- Live: probe exit 0, no challenge, within budget, lease released, raw-first archived.
- **Discipline gate** — all four m1-m3 review shapes.

---

## Progress (2026-08-09)

**Part 1 — the instrument — is built, tested and committed.** `activity.capture`, the
url/pattern modules, the three measurement instruments (`timeshape`, `ACTIVITY_PROBES`,
`activitymap`), the scroller descriptor, surface-selected promotion, D220–D229, 910/910
offline. See `STATE.md`.

**Part 2 — the measurement — has not happened.** It needs operator-supervised live runs
(up to 4 of the 5 budgeted page loads), and everything this task actually *delivers* comes
out of them: fixtures, `FIELD-MAP.md`, the pinning tests, the author-identity verdict, the
interleaved-repost trap, the `posted_at` decision, and the source verdicts written into
Tasks 27–29. The exact commands and what to read on each receipt are at the end of
`STATE.md`. Tasks 27–29 carry the blocked note (D229).
