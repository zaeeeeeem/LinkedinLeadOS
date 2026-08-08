# `post.get`

Reads one LinkedIn post from an archived DOM snapshot. **Comments and reactions are opt-in
and bounded** — a default run reads the post and nothing else.

```sh
npm run cap -- post.get --url=https://www.linkedin.com/posts/<slug>-activity-<id>-<hash>
npm run cap -- post.get --url=<permalink> --comments                      # 10 comments
npm run cap -- post.get --url=<permalink> --comments --comments-limit=25
npm run cap -- post.get --url=<permalink> --reactions --reactions-limit=5
```

Both `/posts/<slug>-activity-<id>-<hash>` and `/feed/update/urn:li:activity:<id>/` are
accepted. A person or company url is refused before anything is opened or spent.

## Source: the third DOM exception

This capability reads the **rendered DOM**, which the network-tap rule otherwise forbids. It
is the third and last granted exception, after the profile reader (D123/D130) and the job
reader (D305). See **D313** for the grant and **D312** for the measurement behind it.

The measurement, on run `01KZKXSGNE4XRQMJRK241YQS6Q`: the permalink carries **no labeled JSON
for the post**. Zero `bpr-guid` data islands, zero `socialActivityCounts`, no `ugcPost` urn,
and zero hits on all four social watches on a cold load. There is nothing else to read.

The shape is inherited, not re-derived: an `outerHTML` snapshot, archived raw, parsed
**offline**, every row tagged `source: "dom-snapshot"`, scope anchored on `data-testid` rather
than container position or LinkedIn's per-build hashed classes.

## Identity, resolved or refused

The post's urn comes from `data-testid="ReactionFacepileCollection-urn:li:activity:<id>"` and
must equal the urn the caller asked for. A snapshot of a different post is refused with
`POST_GET_IDENTITY_UNRESOLVED` (exit 5) rather than reconciled — a redirect that lands
elsewhere has to fail loudly.

The **author** is resolved by elimination, and the elimination is the interesting part. The
post page renders the operator's own profile in its left rail, so the naive "first profile
link" is the operator — the D119 trap in its DOM spelling. Candidates are therefore every
profile link that is *not* inside a comment row and *not* inside the reaction facepile, minus
the session's own public identifiers (from the `/voyager/api/me` body the page fetched
itself). Exactly one must remain. Zero or more than one yields `PARSE_AUTHOR_UNRESOLVED` /
`PARSE_AUTHOR_AMBIGUOUS` and a null author — never a guess.

Both exclusions are by identity, never by position: comment rows are found by their
`urn:li:comment:(…)` id, and the facepile by its testid.

`posted_at` is derived from the activity snowflake, exactly as Task 27 does. Every time
rendered on this page is relative (`"3d"`); none of it is read.

## Comments and reactions: opt-in, bounded, and honest about it

D313 granted this exception with a spending condition attached, and the condition is part of
the rule:

- A default run reads **the post only**. No comments, no reactions.
- `--comments` reads what the cold load rendered, up to `--comments-limit` (default 10).
- `--reactions` reads the rendered facepile, up to `--reactions-limit` (default 10).
  Reactions rank below comments and are never read unless named.
- **Nothing loops "load more."** One bounded pass over what is present. Reading further is a
  new, explicitly-requested run.
- **A partial read is always flagged.** When the page states a higher total than the number of
  rows read, the receipt carries `COMMENTS_PARTIAL` / `REACTIONS_PARTIAL` naming both numbers,
  and `data.read.comments_complete` / `reactions_complete` say so as booleans.

On the reference fixture: 73 comments on the page, 14 rendered. `--comments --comments-limit=5`
returns 5 rows and warns `COMMENTS_PARTIAL(68)`. A limit of 500 returns 14 — never more than
the page rendered, and never a request to extend it.

## Storage

**Archive-only for now.** The post row is deliberately not written, and the reason is a
measurement rather than a preference: the snapshot carries no author urn anywhere. Twelve
`urn:li:member:<id>` values appear in follow-state components, none anchored to the author, and
there is no urn within 3,000 characters of the author's own link.

`person_posts.person_urn` and `company_posts.company_urn` are both `not null`, so writing a row
would mean inventing an author key — which the rules forbid, and which the task file already
anticipated with "refusing an unresolvable author". The receipt therefore reports the post and
leaves the raw snapshot on disk for reparse.

The route that would work is a vanity lookup (`findPersonByVanity`) against a `persons` row
this toolkit has already stored, refusing when absent. It is **not implemented** — it is a
storage decision with an ambiguity case (`vanityMatches > 1`) that deserves its own decision
entry rather than being slipped in here.

## Cost

One page load, and **zero profile opens** — a permalink is a post, not a person (D222). The
sub-cap in `src/core/budget/constants.ts` asserts both zeroes, so a profile open or search page
recorded under this name becomes exit 7 rather than a quiet habit.

## Out of scope

`--reactors` / `--commenters` as full people-lists. Those panels are not fetched on a cold
load; reaching them means opening a panel, which is interaction, and the standing rule is that
we never forge a request the UI did not issue. D312 recommends they become their own measured
task, and D313 keeps them outside this exception.
