# Task 40 — `salesnav.accounts.list` end to end (live)

**Model:** Opus · **Depends on:** Tasks 35, 36, 38, 39 · **Spec:** §7, §9 L2, §11 M5 ·
**Decisions owned:** D390–D399
**Budget: max 4 search pages** for the live gate. Accounts reuses the proven leads
composition; this gate proves the accounts *parse and provenance*, not the paged
machinery again.

## Objective

Wire the accounts parser (Task 38) into `salesnav.accounts.list` on the same paged-run
contract Task 39 proved, and pass a default-flags live gate. Depends on Task 39 because
that task proves the resume machinery once; accounts inherits it and does not re-prove it.

## Constraints

- **Reuse Task 39's composition wholesale** — the paged loop, resume, pacing, challenge
  handling are identical; only the parser (accounts rows: company urn, company URL, and
  provenance fields Task 36 measured) and the `kind` (`sn_accounts`) differ. If accounts
  needs anything structurally new beyond the parser, that is a surprise worth a decision,
  not a quiet fork.
- **Runs through the runner** with lease, ledger/sub-caps (accounts' own daily cap from
  Task 35), challenge gate, raw-first archive, human-input pacing.
- **Storage per Task 38:** append-only `search_results` with `person_urn` null and
  `company_urn` set, page/position provenance; a `searches` row with `kind: sn_accounts`;
  **no entity table touched**.
- **Default flags pass** (M4 CONTEXT rule 5); re-run spends again by design.
- Verification independent of the receipt.

## Deliverables

`src/capabilities/salesnav.accounts.list/{index.ts,README.md}` (parser from Task 38);
the live gate run with independent evidence; decisions D390–D399; `STATE.md` checkpoint
with three-numbers-equal spend evidence.

## Acceptance criteria

- Offline suite green; typecheck clean.
- **Live gate, default flags:** exit 0, no unhandled challenge, within budget, lease
  released. `search_results` rows verified by direct Supabase query, each with correct
  search_id/page/position and `company_urn` set / `person_urn` null; a `searches` row with
  `kind: sn_accounts`; raw bodies on disk for every charged page; `search_page` ledger
  lines = distinct pages loaded once.
- Entity tables provably untouched.
- Resume is inherited, not re-proven — but a smoke test asserts the accounts capability
  uses the same Task 35 module (import/compile-time assertion, the Task 12 pattern), so a
  future refactor can't quietly give accounts its own loop.
- **Discipline gate** — all four review shapes walked.

---

## After Task 40 — the M5 gate

When 37, 39 and 40 have each passed live and operator-supervised (README "Milestone
gate"), M5 is complete. Record it in `STATE.md`, note that M6 (filter builder + self-test
loop) is next, and leave the classic-search-family scope decision (README) resolved rather
than open.
