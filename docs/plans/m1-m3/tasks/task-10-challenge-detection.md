# Task 10 — Challenge and auth detection

**Model:** Opus · **Depends on:** Tasks 1, 4 (consumes Task 9's captures at call sites) · **Spec:** §8 (challenge detection)

## Objective

The safety gate that recognizes when LinkedIn has challenged the session — captcha,
checkpoint interstitial, bounce-to-login, rate limiting — and turns that into the
correct halt.

## Why it matters

A false negative here keeps the toolkit driving a flagged session, which is how the one
account gets burned. When uncertain whether something is a challenge, classify it as one
— a false positive costs a manual restart; a false negative can cost the account.

## Constraints

- Classification logic is **pure** (URL-based and status-based) and exhaustively
  unit-testable offline. Only a thin wrapper reads the live tab — and DOM reading for
  challenge detection is one of D1's four explicitly permitted DOM uses.
- Distinguish at least: captcha, checkpoint/verification interstitial, login bounce
  (session dead), and rate limiting — because they map to different exit codes (2, 2,
  4, 3) and different actions (halt vs reauth vs backoff).
- HTTP 429 means rate-limited; 401/403 on LinkedIn endpoints means the session is dead.
- Ordinary LinkedIn URLs (profiles, search, feed) must classify as clean — the gate
  runs before every parse and after every navigation, so false positives are constant
  friction.
- A detected challenge produces the Task 1 error type as non-retryable
  halt-and-notify (or reauth for login), and the caller's contract is: screenshot,
  checkpoint, exit, stop. Never solved, never retried automatically (D6).

## Deliverables

Pure URL/response classifiers, a live-tab detector built on them, and a helper that
turns a detection into the correctly-classed error carrying its evidence path. Offline
tests pin every classification above, both challenge and clean cases.

## Acceptance criteria

All tests pass offline; typecheck clean. The classifier's URL patterns are grounded in
LinkedIn's real challenge/login paths (verify against the reference worker's experience
and current knowledge, and note any pattern you are unsure of as a comment — Task 15's
live run is the first real-world check).

**Discipline gate** — `CONTEXT.md`, "What review actually catches". Partial-failure state
walked, failures classified against the layer below, every claimed property pinned by a
test. Sharpest here: a false negative costs the account, so the test that matters is the
one proving an *unrecognized* challenge page does not read as a normal page. Say what
happens on a challenge shape this classifier has never seen — silence is the wrong answer,
and "tests pass" cannot see it.
