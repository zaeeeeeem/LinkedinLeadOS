# CONTEXT — read this first, every M4 task

**`docs/plans/m1-m3/CONTEXT.md` applies in full.** Read it now — the reading order, the
freedom-and-limits rules, the hard rules, the four review shapes ("What review actually
catches"), and the environment gotchas all still bind every M4 task. This file only adds
what M1–M3 taught.

Then read, as m1-m3's CONTEXT orders: `CLAUDE.md`, the spec, `DECISIONS.md`, `STATE.md`,
your task file, and **the actual source of every module you consume** — for M4 that
almost always means `src/capabilities/profile.get/`, `profile.capture/`, `src/core/store/`
and `src/core/budget/`, which are the proven compositions you extend.

## The M4 rules — each one is a paid-for lesson

**1. No parse code before a fixture from a real load exists in the repo (D152).**

Your task file names the fixture(s) it builds from. If they are not on disk, your task is
blocked — say so and stop; do not "start with the obvious fields". M1–M3 planned a parser
twice against Voyager JSON that a live probe then proved absent (D116, D121). The probe
tasks exist so that no parser is ever again designed against an assumption. The reverse
also binds: a probe task's deliverable is the *measurement*, not code that consumes it.

**2. Every urn candidate is checked against the session's own identity set.**

`voyagerIdentityDashProfiles` returns the **operator**, not the subject (D126). The
operator's urns appear in A/B tracking, notifications and messaging bodies on every page
(D119). Reuse `sessionUrnsOf` / the D133 trust rule — never re-implement it — and refuse,
never guess, when the only identity you can resolve is the session's or none. A capture
with no resolvable identity stores nothing.

**3. Never assume the document scrolls — measure the scroller.**

LinkedIn's `body` computes `overflow-y: hidden`; the real scroller on the profile page is
`main#workspace` (D115). Each new surface gets its own measurement via the existing
`VIEWPORT_EXPRESSION` approach; a surface where the measured scroll extent never settles
warns, it does not silently under-capture.

**4. A field-map path is a test, not prose.**

Every path the FIELD-MAP claims resolves is pinned by an offline test that runs it back
through the fixture. A sample value in the map that matches the *shape* but not the
*meaning* (`location` capturing `105,570 followers`) is exactly what these tests exist to
catch — assert on meaning, not shape, wherever the fixture allows it.

**5. Live gates run on default flags.**

Task 19's first gate attempt failed because the default 3 scroll passes miss content the
supported `--scrolls=12` reaches. If your gate needs a non-default flag to pass, the
default is wrong — fix the default (with the pacing trade-off recorded as a decision),
do not bless the flag.

**6. Verification is independent of the receipt.**

A live gate is proven by querying Supabase directly, listing the archive files, reading
the ledger — never by trusting the receipt that the code under test printed. The Task 13
review found live TRUNCATE grants that a file-regex test swore were absent (D97): test
reality, not the artifact.

**7. DOM-source exceptions are per-surface operator decisions.**

`CLAUDE.md`'s network-tap rule has exactly one exception: the profile reader. If your
probe measures that a new surface's content also lives only in the rendered DOM (likely —
same SPA), that surface **stops and asks the operator** to extend the exception,
recorded in `DECISIONS.md` and amended into `CLAUDE.md`, before any DOM-reading
capability code is written. The exception is never silently inherited.

**8. Spend discipline for probes.**

Every probe task states its page-load budget in its task file and reuses one target per
surface family so the freshness cache and the `profile_open`-style dedupe amortize loads.
Probes go through the normal capability runner — lease, budget ledger, challenge gate —
never through ad-hoc scripts. If a probe needs another load beyond its stated budget,
that is a checkpoint to record, not a loop to run.

## Choosing probe targets

Live targets are the operator's call at run time, supervised, like every M1–M3 live
check. Prefer targets already in the store (e.g. the profile and its current company from
the M3 gate) so entity rows link up and loads stay deduped. Never use the operator's own
profile as a *subject* probe target — its captures are exactly the session-identity trap
(D119/D126) the parser must refuse.
