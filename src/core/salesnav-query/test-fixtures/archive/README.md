# Promoted Sales Navigator query evidence

This directory mirrors the original `run/raw` layout so the production vocabulary harvester and
query tests run on a fresh clone without the gitignored operator archive. `manifest.json` pins
both the original source hashes and every committed fixture hash.

The promoter preserves public filter ids/text and request grammar. It replaces operator-owned
saved-search ids and labels, seat data, operator-authored keywords, operator-scoped filter
ids/text, and per-execution session values with explicit `SCRUBBED_*` tokens. The manifest names
every changed path but contains no original private value (D426).

Recreate the fixtures, without network access, on the archive-owning machine:

```sh
npm run fixtures:promote:salesnav-query
```

The command reads only the named files already present under the shared run root. Tests verify
all committed fixture hashes before parsing them.
