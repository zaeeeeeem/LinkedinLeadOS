# Task 38 approach — researched before implementation

The closest current paths are Task 14's store client and the M4 list readers. They parse
only archived bodies, project bounded typed rows, keep database-owned timestamps out of
write payloads, exercise the real `supabase-js` request builder against loopback PostgREST,
and turn driver failures into data-free `CapabilityError`s. The existing `searches` and
`search_results` tables already cover the §7 columns, but the original migration deliberately
allowed duplicate page positions because no resume contract existed yet.

The reference worker solved Sales Navigator collection by reading rendered cards, deduping
on public or Sales Nav URLs, and upserting lead/entity rows. Its proven value is the URL shape
and the lesson that a page must be banked before enrichment. Its measured defects are decisive
here: DOM fields are no longer the source (D351), entity upserts would falsely freshen partial
records (M5 rule 5), and one cross-vertical identity rule fails because leads key on
`objectUrn` while accounts key on `entityUrn` (D406).

A better fit now is two pure, endpoint-specific parsers and an insert-only provenance writer.
The parser cost is a little duplicated vertical-specific code, but it makes the opposite key
rules and endpoint drift detectable. The writer pre-reads positions already stored for a
page, inserts only missing positions, and relies on a new unique index for race/failure
protection: the same entity in two searches remains two observations, while a proved resume
cannot double-insert the same `(search_id, page, position)`.

Chosen approach: reuse the current bounded body-parser and real-client store-test shapes, not
the reference worker's DOM/entity model. This establishes network-source fidelity, immutable
search provenance, and a reloaded-page failure mode that becomes a visible database conflict
instead of silent duplication.
