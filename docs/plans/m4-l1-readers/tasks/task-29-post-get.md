# Task 29 — `post.get`

**Model:** Sonnet · **Depends on:** Task 26 (fixtures), Task 27 (post-row projection)
**Spec:** §9 (`post.get` — post detail, optional `--reactors`, `--commenters`)
**Decisions owned:** D250–D259

> **STILL BLOCKED 2026-08-09 — the permalink surface will not load.**
> Two attempts on `https://www.linkedin.com/feed/update/urn:li:activity:7491197577439141888/`
> (runs `01KZKM4HC3V94H761M65KPCFM7`, `01KZKMDFGDM48683YJ0P2S5NSM`) both died with the
> CDP socket dropping ~2.5s after the document arrived, and both left a worker tab
> orphaned. The document itself was seen (HTTP 200) but its body was never retrievable.
> The three person-activity tabs on the same account, minutes apart, were all fine — so
> this is specific to the permalink page, not to the session.
>
> The second attempt failed in 2.4s under the correct code (`CDP_SOCKET_ERROR`) rather
> than after 45s under `TAB_NAVIGATE_TIMEOUT`, because D302 landed in between. That is
> the diagnosis working, not the page working.
>
> **Before this task starts:** get one clean permalink capture. Worth trying first —
> a `/posts/<slug>-activity-<id>-<hash>` url instead of `/feed/update/` (the probe
> already watches both document spellings, D300), and a fresh Chrome with no other tabs
> open.
>
> *Source verdict from Task 26:* **unknown for the permalink itself.** What is known is
> that the person-activity feed carries post rows as labeled Voyager JSON with no DOM
> exception (Task 27) — but a reactor or commenter list has only ever been visible on a
> permalink, which is the surface that has not loaded.

## Objective

Read one post's full detail by its activity urn / permalink — text, author, posted_at,
reaction and comment counts — and, when asked, the reactor and commenter lists
(`--reactors`, `--commenters`), each of which is real people usable by `profile.get`.

## Constraints

- Parser pure and offline against Task 26's single-post fixture. The post's own row reuses
  the shared post-row projection; whether it writes to `person_posts` / `company_posts`
  depends on author type (person vs company) — resolve the author urn and route
  accordingly, refusing an unresolvable author.
- `--reactors` / `--commenters` return people the panel actually loaded — pagination is
  measured, metered, and `--limit`-bounded; **never forge a reactions-list request the UI
  did not issue.** These lists are returned as profile URLs/urns, not stored as a new
  association unless the operator later asks (note it, do not invent a table).
- Each reactor/commenter urn passes the session-identity check.

## Deliverables

`src/capabilities/post.get/` with README; parser + tests; author-type routing into the
existing post tables.

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: author-type routing (person vs
  company), unresolvable-author refusal, reactor/commenter session-urn exclusion.
- **Live gate, default flags:** exit 0 against a real post; the post row verified by query;
  `--reactors` on a post with reactions returns real resolvable profiles.
- **Discipline gate** — all four m1-m3 review shapes.
