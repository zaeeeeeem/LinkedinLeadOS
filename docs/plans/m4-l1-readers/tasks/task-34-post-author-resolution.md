# Task 34 — `post.get` author resolution and the post write path

**Model:** Sonnet · **Depends on:** Task 29 (`post.get`, delivered archive-only)
**Spec:** §7 (`person_posts`, `company_posts`) · §9 (`post.get`)
**Decisions owned:** D319–D328 — Task 34's nominal range (D300–D309) is spent, so it takes
the next free block under D18's rule. Check `DECISIONS.md` before assuming they are free.

> **Why this task exists.** Task 29 ships `post.get` reading the post correctly and storing
> **nothing**. That is not an oversight, it is D314: the post permalink's DOM carries **no
> author urn anywhere**. Measured on run `01KZKXSGNE4XRQMJRK241YQS6Q` — twelve
> `urn:li:member:<id>` values, all inside follow-state components, none anchored to the
> author, and no urn within 3,000 characters of the author's own profile link.
>
> `person_posts.person_urn` and `company_posts.company_urn` are both `not null`. Writing a row
> today would mean inventing an author key, which the identity rules forbid outright. So the
> post is read, reported, and archived — and never saved.
>
> This task closes that, by resolving the author through the **one identifier the page does
> carry**: the vanity slug.

## Objective

Turn `post.get`'s author vanity into a real author urn, and write the post row into
`person_posts` or `company_posts` accordingly — or refuse, loudly and cheaply, when the author
cannot be resolved.

## The approach, already settled

`post.get` resolves an author **vanity** (`tankots`) by eliminating comment rows, the reaction
facepile, and the operator's own public identifiers. That part is done and live-proven; do not
rebuild it.

The missing step is vanity → urn, and the lookup already exists:
`findPersonByVanity(vanity)` in `src/core/store/persons.ts`. It returns the most recently seen
match **and a `vanityMatches` count**, which exists precisely because a vanity can match more
than one stored person.

## Constraints

- **Never invent an author key.** No row is written unless the urn came from a stored
  `persons` row whose `vanity` equals the parsed vanity exactly.
- **Ambiguity is a refusal, not a coin flip.** `vanityMatches > 1` must not silently take the
  most recent row. Decide the behaviour, write it down, and make it visible on the receipt —
  the recommendation is refuse-and-warn, because attributing a post to the wrong person is the
  expensive direction of this error.
- **A miss is normal, not a failure.** A post by someone never fetched with `profile.get` has
  no `persons` row. That is the common case, and it must exit 0 with the post on the receipt
  and a warning naming the vanity — never a non-zero exit, and never a write.
- **Company-authored posts route to `company_posts`.** A post permalink may be authored by a
  company page, whose link is `/company/<slug>/` rather than `/in/<vanity>/`. Task 29's parser
  currently resolves person links only. Measure whether a company-authored permalink even
  carries the same anchors before designing this half — the existing fixture is
  person-authored, so **this needs its own capture** and may end in a `[DECISION NEEDED]`.
- **The lookup is a store read, not a page load.** It must cost zero page loads and zero
  profile opens. Do not "resolve" a missing author by opening their profile — that would turn
  one cheap read into two metered ones, silently.
- **`--no-store` must still work**, and the archive-only path must remain intact for the miss
  and ambiguity cases.

## Deliverables

- Author resolution in `src/capabilities/post.get/` — vanity → urn via `findPersonByVanity`,
  with the refusal cases above.
- The write path into `person_posts`, reusing Task 27's shared post projection in
  `src/core/store/posts.ts`. Do not write a second projection.
- Receipt fields that state what happened: resolved / not-found / ambiguous, and the table
  written, if any.
- README updated — the "Storage" section currently documents the archive-only behaviour and
  names this task as the route; it must stop being a promise and start being a description.
- A `[DECISION NEEDED]` for the company-authored case if the measurement says it differs.

## Acceptance criteria

- Offline suite green; typecheck clean.
- **Mutation-verified:** an ambiguous vanity (`vanityMatches > 1`) does not write; a missing
  `persons` row does not write and does not fail the run; a resolved author writes exactly one
  row keyed on the post urn.
- **Live gate, default flags:** exit 0 against a real post whose author *is* already in
  `persons` — the row verified by query — and exit 0 against one who is *not*, with no row
  written and the warning present. `tankots` is already stored from Task 27's live gate
  (`urn:li:fsd_profile:ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA`), so the positive case needs no
  new profile fetch.
- **Discipline gate** — all four m1-m3 review shapes.

## Do not

- Do not add a `vanity` column to `person_posts`, or any column, without an approved migration.
- Do not relax the `not null` on either author column.
- Do not extend the DOM exception. D313 covers the post, its comments and its reactions; this
  task adds no new DOM reading at all — it is a store lookup over a field Task 29 already
  parses.
