---
name: research-lead
description: Use when building a dossier on a specific person or company — enriching a harvested lead, qualifying a prospect, preparing personalization material, or answering "who is this person / what does this company do / what are they posting and hiring for".
---

# Research One Lead

**Read the `linkedin-session` skill first** — preflight, budgets, exit codes.

What goes in a dossier is your call — the question you're answering decides which readers
to run. The toolkit's part: every field you get is provenance-tagged (labeled network body
or, on the named exception surfaces, a DOM snapshot marked `dom-snapshot`), so downstream
judgment knows what it's standing on. Nothing here invents facts.

## Reader menu and costs

| capability | cost (loads / searches / profile opens) | gives you |
|---|---|---|
| `profile.get --url=<vanity>` | 1 / 0 / 1 — **0 on cache hit** | person: headline, location, experience → `persons`, `person_experience` |
| `profile.posts --url=<vanity>` | 1 / 0 / 1 | their posts → `person_posts` (`--limit` default 20, `--since=<ISO>`) |
| `profile.activity --url=<vanity>` | 2 / 0 / 1 | comments + reactions they made (receipt + archive only, no table) |
| `company.get --url=<slug>` | 1 / 0 / 0 — 0 on cache hit | company: size, HQ, website, about → `companies` |
| `company.people --url=<slug>` | 1 / 0 / 0 | who works there → `company_people` (`--title=`, `--name=` filters) |
| `company.jobs --url=<slug>` | 1 / 0 / 0 | open postings → `jobs` |
| `company.posts --url=<slug>` | 1 / 0 / 0 | company's posts → `company_posts` (`--since=`) |
| `job.get --url=<job-id>` | 1 / 0 / 0 | full description, enriches the `jobs` row |
| `post.get --url=<permalink>` | 1 / 0 / **0** | one post; comments/reactions **opt-in** |

`profile_open` dedupes per day: profile.get then profile.posts on the same person is one
distinct profile, not two.

## Spend-shaping habits (not a fixed sequence)

- **Cache first.** `profile.get` / `company.get` return from Supabase free inside
  `--max-age` (default 7d). `--max-age=0` forces a refetch — spend that only when
  freshness is the point.
- **Question first.** "Is this company hiring for X" needs `company.jobs` + maybe one
  `job.get`, not the whole family. Running all readers on every lead is the expensive
  habit the sub-caps exist to stop.
- **Fan out from stored rows.** `company.people --title=founder` gives person urns; pick
  who deserves a `profile.get`. Search results from `build-lead-list` give urns the same
  way.
- **Posts for personalization.** `profile.posts --since=` answers "what are they talking
  about lately" in one load. `post.get --comments --comments-limit=10` reads one thread's
  reception — comments are bounded to what the cold page rendered, a partial read says so
  on the receipt (`COMMENTS_PARTIAL`), and nothing loops "load more". Reactions only when
  named: `--reactions`.
- **post.get stores the author's post only if the author was already fetched** with
  `profile.get` (vanity → stored person). `POST_AUTHOR_NOT_STORED` is ordinary, not an
  error — fetch the profile first if you need the post keyed to a person.

## Assembling the dossier

Pull from Supabase, keep provenance:

```sql
select * from persons where vanity = '<vanity>' order by last_seen desc limit 1;
select * from person_experience e join persons p on p.urn = e.person_urn
  where p.vanity = '<vanity>' order by e.is_current desc;
select urn, text, posted_at, reactions, comments from person_posts
  where person_urn = '<urn>' order by posted_at desc;
select id, title, location, posted_at from jobs
  where company_urn = '<company-urn>' order by posted_at desc;
```

DOM-sourced rows are tagged `source: "dom-snapshot"` — keep that tag if the dossier feeds
anything downstream. What the toolkit never gives you: private data, invented fields, or a
claim beyond what a captured response said (e.g. `company_people` means "LinkedIn listed
them under this company", not verified employment).

## Stop and ask the operator

- Any urge to view a profile *as an interaction* (follow, connect, message) — reading is
  in scope, everything a third party could notice is not.
- A field you need that no reader carries — that's a new-capability decision, not a DOM
  scrape you improvise.
- Exit 2/3/4 — per `linkedin-session`.
