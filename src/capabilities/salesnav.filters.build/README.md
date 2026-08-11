# `salesnav.filters.build`

Pure offline Sales Navigator URL construction. Pass one typed JSON object as
`--spec='<json>'`; the object contains `vertical` (`LEAD` or `ACCOUNT`) and tagged
`filters`. Value filters use `{kind:"values",type,values:[{id,text,selectionType}]}`;
range filters use `{kind:"range",type,min?,max?,selectedSubFilter?}`.
Value filters may also carry `selectedSubFilter` for measured shapes such as LEAD/POSTAL_CODE.

The capability costs 0 page loads, 0 search pages and 0 profile opens, declares
`needsBrowser:false`, and never contacts LinkedIn. It validates filter types and flags against
the promoted `salesApiSearchFilterLayout` fixture, and every emitted value id/text pair against
the public vocabulary registry plus the gitignored private overlay. Its receipt contains the
built URL, filter count, consumed vocabulary row ids and provenance ids—not result rows.

It refuses unknown types, unsupported exclusions, malformed ranges, ids or display text absent
from vocabulary, and any vocabulary row without archive provenance. Range atoms are canonical
decimal strings after schema parsing and are checked against the catalog's input type, minimum,
accepted values and sub-filter ids. Raw text and keywords stay
typed but currently refuse: the catalog or saved-search body proves those features exist, while
no captured `q=searchQuery` URL yet proves their request grammar (D421/D422). Grammar drift and
registry corruption use exit 5; invalid specs and missing vocabulary use exit 1.

This capability stores no Supabase rows. Inspect a consumed vocabulary row with
`salesnav.filters.vocab --operation=audit --row-id=<id>`.

The inverse decoder is intentionally strict: unknown or duplicate fields at any nesting level,
ambiguous value/range branches and schema-invalid output all refuse instead of being projected
away (D427).
