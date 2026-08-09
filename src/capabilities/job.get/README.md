# `job.get`

Reads one LinkedIn job detail page and enriches the canonical `jobs.id` row.

This is the second and final DOM-source exception (D305). The live half is delegated to
`job.capture`, which archives a settled `outerHTML` snapshot raw. `job.get` reads that archived
file back and parses it offline; it never reads live `innerHTML` and never addresses the RSC
flight tree by position.

Identity is resolved or refused. The numeric ID normalized from the requested URL must be
named by a `urn:li:*jobPosting:<id>` in the document; unrelated recommendation-rail job urns
do not invalidate that agreement. Content is anchored on
`data-testid="expandable-text-box"` beneath the `About the job` heading. Hashed classes and
container position are not selectors. Every parsed row is tagged `source: "dom-snapshot"`.

Storage uses `jobs.id` as the conflict target and sends only fields this snapshot observed.
That omission rule is what lets a detail read merge `description` into the row previously
written by `company.jobs` without erasing its title, location or posting date. Both `undefined`
and explicit `null` are omitted from this monotonic enrichment write.

```sh
npm run cap -- job.get --url=https://www.linkedin.com/jobs/view/<id>/
```

The live gate is operator-supervised. Task 31 stops before running this command.
