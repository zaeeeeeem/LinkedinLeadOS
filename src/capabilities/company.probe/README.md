# `company.probe`

Loads a company's page family and archives everything it can, so the four
company readers (Tasks 22–25) are written against measurement instead of
memory. It parses nothing, stores nothing, and resolves no identity.

This exists because every expensive M1–M3 failure had one shape: a parser
designed against an assumed LinkedIn data shape, falsified later by the real
page (D116, D121, D115, D118). D152 makes the probe its own task with its own
deliverable so that never happens again.

## What it does

Per sub-page — `main`, `about`, `posts`, `people`, `jobs` — one **cold load**:

1. budget checked, then spent, then navigate;
2. challenge gate;
3. wait for the page's own first LinkedIn API response (a timeout here is a
   *finding*, not a failure);
4. human-paced scroll and dwell, reusing `profile.capture`'s pacing constants
   unchanged;
5. DOM snapshot, archived raw like any body (D124);
6. one structural measurement — scroller, tab links, embedded JSON, SDUI
   `componentkey` namespaces — none of which is captured LinkedIn data;
7. challenge gate again.

Everything on the wire is archived before the capability returns, on the
throwing paths too (`tap.drain()` in a `finally` covering the whole loop, D2).

## Flags

| flag | default | what |
|---|---|---|
| `--url` | required | company url, `/company/<slug>` path, or bare slug |
| `--subpages` | all five | comma-separated; load order is fixed, not the order given |
| `--scrolls` | `profile.capture`'s randomized 3–6 | scroll passes per sub-page |
| `--captureTimeoutMs` | 15000 | how long to wait for a sub-page's first API response |
| `--layoutTimeoutMs` | 15000 | how long to wait for a sub-page to lay out |

## Cost

One `page_load` per sub-page — five by default, and **no `profile_open`**: a
company page is not a profile view and the ledger must not record one.

Its daily sub-cap is `{ pageLoadsPerDay: 12, searchPagesPerDay: 0,
distinctProfilesPerDay: 0 }` (D153, D162). Twelve is two full probe runs; the
two zeroes are assertions that this capability never searches and never opens a
profile, enforced at exit 7 rather than by habit.

The task's stated ceiling of six loads per invocation is also enforced in code
(`PROBE_MAX_PAGE_LOADS`) and is not raisable by a flag.

## Failure modes

| code | exit | means |
|---|---|---|
| `COMPANY_URL_INVALID` | 1 | the target could not be canonicalized; nothing was opened or spent |
| `ARGS_INVALID` | 1 | `--subpages` named something that is not one of the five; caught at argument parsing, before a tab or the lease is taken |
| `COMPANY_SUBPAGE_UNKNOWN` | 1 | the same, thrown by `parseSubPages` for a caller that invokes `run` directly rather than through the CLI |
| `PROBE_BUDGET_EXCEEDED` | 7 | more loads asked for than a probe may make |
| `BUDGET_*` | 7 | the invocation cap or the ledger refused |
| `CHALLENGE_*` | 2 | a challenge on any sub-page halts the whole probe; never pushed past |
| `PROBE_NO_CAPTURE` | 6 | pages loaded and nothing was archived |

Warnings — all of them findings rather than errors: `SUBPAGE_NO_API_RESPONSE`, `SUBPAGE_NOT_LAID_OUT`, `SUBPAGE_REDIRECTED`,
`DOM_SNAPSHOT_MISSING`, `SUBJECT_CONTAINER_NOT_RENDERED`, `SURFACE_UNMEASURED`,
`NO_COMPANY_PAYLOAD`, `PATTERN_MISMATCH`, `CAPTURE_MISSES`,
`RESPONSE_STATUS_UNRECOGNIZED`, `TAB_NOT_FOREGROUND`.

On a first probe of an unmeasured surface, `PATTERN_MISMATCH` is the *expected*
reading: the specific patterns are this build's guess and the broad net is what
makes the guess checkable (D110).

There is **no warning for a sub-page that did not finish**, and that is not an
omission. A sub-page can only fail by throwing out of the loop, and the runner
builds an error receipt from the error and the cost alone — a capability's
warnings are not on it. The durable record of a halt is an `error` event naming
the sub-page, the stage it stopped at, which sub-pages completed and which were
never attempted; read it with `log:why`. The loads actually spent are on the
error receipt's `cost`.

## What it never puts on stdout

Counts, tag names, element ids, dotted `componentkey` namespaces and the
operator's own target url. Never a company name, never a urn, never a
`componentkey` value — those are in the archive, where the offline sweep reads
them (§4.1, D3).

## After a run

```
npm run fixtures:promote -- --run=<runId> --capability=company.get --subject=<vanity>
npm run sweep -- --run=<runId> --want-file=fixtures/company.get/wanted.json \
  --out=docs/capabilities/company-surface-field-map.md
```

`sweep` answers *which source carries each field* by looking for values the
operator read off the rendered page — so no parser is designed against a guessed
key name. A field it reports as `dom-snapshot` only is a `[DECISION NEEDED]`:
`CLAUDE.md`'s network-tap exception covers the profile reader and nothing else.
