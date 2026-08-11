# LinkedinLeadsOS — Operating Manual

> Read at the start of every session, before anything else.
>
> **This project has no relationship to the parent `StartupStruggle/` directory or its
> dentist landing-page venture.** It only lives there so all projects sit in one place.
> Ignore `../CLAUDE.md` entirely. This file governs everything under `LinkedinLeadsOS/`.

## What this is

A TypeScript toolkit that lets a coding agent read LinkedIn end to end — profiles, companies,
posts, jobs, and Sales Navigator searches — with **no human in the loop**. It drives the
operator's own logged-in Chrome over CDP.

A library of pure capability functions plus a thin CLI. Not a server, not a queue, not an MCP
server. Those can be layered on later without touching the core.

## The hard constraint

There is exactly **one** LinkedIn account and it cannot be burned.

Every design decision that looks paranoid exists because of this. When a trade-off is between
speed and account safety, safety wins — do not re-open that argument.

## Explanations and reviews

Write to transfer understanding, not to record conclusions.

- Lead with a 3-5 line summary that stands alone. Assume the rest is skipped.
- Label every finding: [BUG] / [DECISION NEEDED] / [FYI]. Order by that.
- Before naming any identifier (#foo, D31, a flag), say in plain words what it
  is and what it's for. Once per conversation is enough.
- State impact before mechanism. What breaks, then why.
- Prefer numbers to adjectives. "39px per call", not "a real improvement".
- Keep paragraphs to 3 sentences. Use headers and bullets.
- End with: "Needs your decision:" and a short list, or "Nothing blocking."
- Do not narrate what you verified unless it changed something.

## Scope

**In:** L0 session and infrastructure · L1 cheap reads · L2 metered searches.

**Out, and not up for debate this phase:** all L3 writes (connect, message, comment, react,
follow, post, endorse, profile view) · L4 intelligence (ICP scoring, signal detection,
drafting) · L5 orchestration (campaigns, sequences, schedulers) · MCP surface · notifications
· multi-account · hosted execution.

## Non-negotiable rules

- **Network tap is the source of truth — with exactly one exception, spelled out below.**
  Data fields come from captured response bodies, never from the rendered DOM. DOM reads are
  for navigation, pagination state, challenge detection, and render confirmation only.
  **The profile reader is the exception and it does read the DOM; do not act on this bullet
  without reading the three paragraphs that follow it.**

  A captured body counts whether it is a Voyager / `salesApi*` JSON response **or** the
  initial document response for the page itself, from which only *embedded structured
  data* may be read — the JSON LinkedIn server-renders into the document, addressed by
  a path into that parsed JSON. See D117.

  **The profile reader is the one exception, and it reads the DOM (D123 content, D130
  identity).** Both the subject's content — headline, location, positions — and the subject's
  **identity**, the urn that keying, freshness and dedupe run on, come from a **DOM snapshot**:
  `outerHTML` captured after layout settles, archived raw like any body, parsed offline. Never
  a live `innerHTML` read, never the RSC flight tree by position (D121).

  Within that snapshot the two are addressed differently, and the difference is the safety
  argument:

  - **Identity** comes from the SDUI card-ref namespace every profile card shares —
    `componentkey="com.linkedin.sdui.profile.card.ref<PROFILE_ID><CardName>"` — which yields
    `urn:li:fsd_profile:<PROFILE_ID>` (D127). It is resolved from agreement across the cards,
    so it either resolves or returns `null`; it never guesses. A capture with no resolvable
    identity stores nothing rather than storing content under an invented key.
  - **Content** is scoped to the subject's own cards by that same namespace, which is what
    keeps a "people also viewed" stranger out. Container position does **not** do this — the
    page's only `aside` sits inside `main#workspace`.

  Every row from the snapshot, identity and content alike, is tagged DOM-sourced so nothing
  downstream mistakes it for a labeled API field.

  Why an exception exists at all: no Voyager endpoint carries a *stranger's* profile on a cold
  load. `voyagerIdentityDashProfiles` looked like one and is not — it takes the operator's own
  urn as input and returns the operator (D126). This is measured across four live loads, not
  assumed.

  **There is a second exception: the job reader (D305).** `/jobs/view/<id>` is
  server-rendered SDUI and carries **no labeled job field anywhere** — the description
  crosses the network only as an RSC flight tree, and `listedAt`, `workplaceTypes`,
  `formattedLocation` and the company urn appear in no captured body at all (measured
  twice, D304). It takes the profile reader's shape exactly: an `outerHTML` snapshot,
  archived raw, parsed **offline**, every row tagged DOM-sourced, scope anchored on
  `data-testid` rather than container position or LinkedIn's per-build hashed classes,
  and identity resolved-or-refused against `urn:li:jobPosting:<id>` in the document.

  **There is a third exception: the post reader (D313).** `/posts/<slug>-activity-<id>-<hash>`
  carries **no labeled post field anywhere** — no `bpr-guid` data island, no
  `socialActivityCounts`, no `ugcPost` urn, and zero hits on all four social watches on a cold
  load (measured, D312). It takes the same shape as the two before it: an `outerHTML` snapshot,
  archived raw, parsed **offline**, every row tagged DOM-sourced, scope anchored on
  `data-testid`, and identity resolved-or-refused against `urn:li:activity:<id>`.

  The post exception **covers the post's own fields, its comments and its reactions** — and it
  is granted with a spending condition that is part of the rule, not an implementation detail:
  **comments and reactions are opt-in and bounded.** A default `post.get` reads the post only.
  Nothing may loop "load more" to exhaust a comment thread, and a partial read is always
  flagged as partial rather than reported as the whole. Reactions rank below comments and are
  never fetched unless asked for by name. See D313.

  **There is a fourth and a fifth: the feed reader (D325) and the inbox readers (D326).**
  Both read the operator's *own* data, both take the same shape as the three above — snapshot
  archived raw, parsed offline, rows tagged DOM-sourced, scope on stable attributes — and both
  were granted **before** their measurement rather than after it. So both carry a condition the
  first three did not need: **the probe still measures, and a labeled network body still wins.**
  A DOM read of a field that was available in a captured body is a defect on these surfaces, not
  a shortcut.

  Two further conditions are part of those grants rather than implementation detail. The feed
  has no single subject — every item's author is resolved independently, an unresolvable author
  is reported rather than attributed, and because a feed does not end it is bounded by `--limit`
  and a fixed pass count, never read to the bottom (D320's `untilBottom` is for pages that end).
  The inbox is **read-only** — nothing sends, reacts, archives or marks; opening a thread may
  mark it read and that is stated on the receipt rather than discovered — and **message text
  never leaves the archive**: not to stdout, not to a receipt, not to a log, not to a commit.
  Its fixtures go to `.fixtures-private/` (D327), never to `fixtures/`.

  **Those five exceptions are the profile, job, post, feed and inbox readers, and nothing
  else.** Every other capability, and every
  other kind of field, still takes data only from captured network bodies. DOM reads for
  navigation, pagination state, challenge detection and render confirmation are unchanged and
  always allowed everywhere.
- **Never forge a request LinkedIn's own UI did not already issue.** No direct Voyager calls
  with the session cookie, however tempting.
- **This toolkit performs exactly two clicks, both named below and neither generalizable.**
  Every click, whichever of the two, is **resolved or refused — never guessed**, is a trusted
  `HumanCursor` click and never `element.click()`, and is brought into view by wheel notches
  and never `scrollIntoView`.

  **One — a pagination control** (D400, operator grant 2026-08-11). Next, previous, or a
  numbered page button, inside a results pager, located by accessible name. The spend
  contract, the sub-caps and the inter-page dwell apply to a clicked page exactly as to a
  navigated one, and **which page arrived is read from the response body, never from the
  button.**

  **Two — the Sales Navigator Saved searches button** (D408, operator grant 2026-08-11): the
  unique enabled `button[data-x--link--saved-searches]` on `/sales/`, and nothing nested
  inside the panel it opens. It is granted because the control is a button with no href, so
  there is no url to navigate to, and because it opens the operator's *own* saved searches.

  Both were granted for the same reason, and that reason is now the standing test (D409,
  operator grant 2026-08-11). **A click that passes it is taken without asking first, and
  reported afterwards.** The test has four parts, all of which must hold:

  1. It creates **no edge**, sends nothing, and leaves **no trace on any third party's
     account** — nothing the other side could see, now or in an audit log.
  2. It acts on the **operator's own surface**: revealing, navigating or expanding what the
     operator can already see.
  3. It is **measured first** — the control exists in an archived snapshot, addressed by a
     stable attribute or accessible name, and is **resolved or refused, never guessed**.
  4. There is **no url that reaches the same place**. A navigable url always wins; a click is
     what you do when D357 has nothing to hand back.

  **What still stops and asks, every time, no exceptions:** any **L3 write** — connect,
  message, comment, react, follow, endorse, post, save-to-list, or anything that notifies a
  third party. Those are out of scope this phase (see Scope) and no click grant reaches them.
  A control whose effect you cannot predict is not "measured"; measure it or leave it.

  Every click taken under this authority is **named on the receipt and written into
  `DECISIONS.md` in the same session**, with what it was, why it passed all four parts, and
  what it loaded. The operator reviews after the fact, not before — which only works if the
  record is complete, so an unrecorded click is the violation, not the click.
- **Raw first.** Archive the untouched response body before parsing anything. Parsed rows are
  a projection, never the only copy.
- **Never `Runtime.enable` or `Page.enable`.** `consoleAPICalled` is the classic CDP detection
  leak. Enable `Network` only.
- **Parsers are pure and tested offline against fixtures.** A parser change must be provable
  with zero LinkedIn requests.
- **The budget ledger cannot be bypassed by a flag.**
- **Challenges are never solved automatically.** Screenshot, checkpoint, exit 2, stop.

## Conventions

- Receipt on stdout, bulk data in Supabase. Never print large results.
- Exit codes carry the failure class: `0` ok · `2` challenge · `3` rate-limited · `4` auth
  dead · `5` parse drift · `6` transient · `7` budget exhausted.
- One capability = one directory under `src/capabilities/`, holding `index.ts`, `parse.ts`,
  `parse.test.ts`, `README.md`.
- Dates are absolute (`2026-08-07`), never "today" or "last week".
- Chrome runs on the dedicated profile at `~/.linkedin-os/chrome-profile`, launched with
  `--remote-debugging-port=9223`. Never attach to a `chrome://inspect` opt-in session, and
  never touch port 9222 — that is the operator's personal Chrome.

## Recording system

Write it down the moment it happens. Do not trust memory across sessions.

| File | What goes here | When |
|---|---|---|
| `CLAUDE.md` | This file — what it is, phase, rules, index | When phase or a rule changes |
| `DECISIONS.md` | Why X over Y, dated, append-only | The moment a real decision is made |
| `STATE.md` | Built / in progress / next | **At every checkpoint**, not at session end |
| `BACKLOG.md` | Deferred work + the approach settled at capture time | When something is punted with a known plan |
| `docs/specs/` | Approved designs | Per design cycle |
| `src/capabilities/<name>/README.md` | One contract doc per capability | When a capability is added or changed |

`STATE.md` is updated at every checkpoint specifically so a session that dies mid-task still
leaves an accurate state file behind.

**`docs/capabilities/` is retired (2026-08-10, D339).** The contract doc for a capability is
the `README.md` in its own directory, which the Conventions section already requires and
which every capability has. The files still in `docs/capabilities/` are kept as history; do
not add to them and do not treat their absence for a capability as a gap.

## Reference, not a base

`/Users/talhat/Claude/Projects/OwnexLabsSales/dashboard/worker` is an earlier, partly working
scraper. It is a **parts donor, not a foundation** — read it, rewrite typed, never import it.

Worth taking: `engine/cdp.mjs` (human cursor paths, wheel notches, passive response capture,
focus emulation), `engine/page-scripts.mjs` (DOM navigation helpers), and the pagination and
resume logic in `engine/run-scrape.mjs`.

## Environment gotcha

Discover the CDP endpoint with `GET http://127.0.0.1:9223/json/version` and use its
`webSocketDebuggerUrl`. Do **not** hardcode the bare `/devtools/browser` path — Chrome 150
accepts it, Chrome 151 rejects it, and the automation profile runs 151. Do not rely on the
`DevToolsActivePort` file either; it is not reliably written.

(For context: the HTTP endpoints 404 on the operator's personal Chrome because it enabled
debugging via `chrome://inspect`. They work normally on the launch-flag profile.)

Claude Code's Bash sandbox blocks loopback TCP — probing CDP from Bash needs the sandbox
disabled for that call.

## Index

- Approved design → `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`
- What's built → `STATE.md`
- Why we did something → `DECISIONS.md`
- Deferred with a known approach → `BACKLOG.md`
- Capability contracts → `docs/capabilities/`
