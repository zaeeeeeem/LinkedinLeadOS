# `job.capture`

Opens **one** LinkedIn job posting, archives every response body it fetches plus a
rendered-DOM snapshot, and measures where `job.get`'s fields live. It is Task 30's
instrument: the live probe that must run before any job parser is written (D152).

```
cap job.capture --url=https://www.linkedin.com/jobs/view/4012345678/
cap job.capture --url=4012345678          # a bare posting id
```

## What it does not do

**It parses no job field and stores nothing.** A probe's deliverable is the measurement;
a parser written in the same commit as its own evidence is what D152 exists to prevent.
There is therefore no `parse.ts` here, which is a deliberate departure from the
one-directory shape in `CLAUDE.md`'s conventions — the parser lives in `job.get`
(Task 31), written offline against the fixture this run promotes.

## The canonical job id (D260)

The bare numeric posting id. Every input form reduces to it — `/jobs/view/<id>`, the
slugged share url, a listing url carrying `currentJobId`, a bare id,
`urn:li:fsd_jobPosting:<id>` — and it is what §7's `jobs.id`, the `ref` on events, and
the promoter's subject all key on. `company.jobs` (Task 25) must use the same form.

Two inputs are refused rather than guessed: a listing url naming no posting, and a
`/jobs/view/` segment carrying no digits. Both would spend a page load on a posting the
operator did not name.

## What it measures

| measurement | why it exists |
|---|---|
| endpoints, per watched pattern, `job_ish` and `unpredicted` | the pattern-vs-reality answer: a specific pattern with zero hits beside a non-zero `unmatched_job_ish` is the finding |
| the real scroller (`data.reading.viewport`) | never assumed to be the profile page's `main#workspace` — measured here (D115) |
| description truncation (`data.description.verdict`) | whether the full description is already in the DOM behind a CSS clamp, or behind a fetch. Decides whether Task 31 can have `jobs.description` passively. Measured **without clicking anything** — see `probe.ts` |
| identity (`data.identity`) | did the page serve the posting we asked for; can the hiring company's urn be resolved by agreement; which person urns are the operator's own (`sessionUrnsOf`, D119/D126) |

Counts and urn *families* only. The urns themselves, the page text and the query strings
are captured data and never reach stdout (§4.1, D3).

## Budget (D262)

One `page_load`, and never a `profile_open` — a posting is not a profile view, and §8's
spend kinds are a closed set. The daily blast-radius guard is the capability's own
sub-cap, which it takes from `DEFAULT_CAPABILITY_SUB_CAPS` (D162).

## After a run

```
npm run fixtures:promote -- --run=<runId> --capability=job.get
```

Promotion routes on the capability's family (`core/fixtures/families.ts`): the subject is
this posting's urn *and* its bare id, relevance is `isJobIsh`, and the field map is built
with `JOB_FIELD_PROBES` — one probe per §7 `jobs` column, each reporting its misses so a
column LinkedIn does not name shows up as "not found" instead of as an assumed path.

## Warnings, and what each one means you should go do

| code | meaning |
|---|---|
| `JOB_SUBJECT_NOT_SERVED` | no body and no snapshot names the requested posting — nothing from this run may be promoted as that job |
| `SESSION_IDENTITY_UNKNOWN` | no `/voyager/api/me` body, so the "is this the operator" checks could not run and their answers prove nothing |
| `COMPANY_URN_UNRESOLVED` | 0 or 2+ company urns among the subject's bodies; Task 31 must address the employer by a field-map path, never by a sweep |
| `DESCRIPTION_SOURCE_UNKNOWN` / `DESCRIPTION_NOT_MEASURED` | the truncation verdict is not "no fetch" — it is "we could not tell" |
| `JOB_CONTAINER_NOT_RENDERED` | the snapshot is archived but too empty to build a field map from |
| `NO_JOB_PAYLOAD`, `PATTERN_MISMATCH`, `CAPTURE_MISSES` | as in `profile.capture` |
