# Task 7 — Raw archive and shape hashing

**Model:** Sonnet · **Depends on:** Task 1 (optionally logs via Task 6) · **Spec:** §2 D2, §5–6

## Objective

The raw-first storage primitive: persist every captured response body untouched (and
compressed) before anything parses it, and fingerprint each body's **structure** so
fixture promotion and drift detection can group responses by shape.

## Constraints

- The body hits disk before any parse attempt (D2). The archive returns where it wrote
  and the body's shape fingerprint.
- The shape hash covers key paths and value **types**, never values:
  - two responses with the same structure but different data collide deliberately;
  - key order does not matter;
  - adding/removing a key, or a value changing type, changes the hash;
  - arrays collapse to the shape of their elements (a 1-item and 100-item list of the
    same element shape hash identically);
  - null is its own type.
- Archived files are listable with their metadata so later steps (fixture promotion,
  receipts) can enumerate what a run captured.

## Deliverables

The archive and the shape-hash function, plus offline tests pinning every hash property
above and proving bodies are written compressed and read back byte-identical.

## Acceptance criteria

All tests pass offline in temp directories; typecheck clean.
