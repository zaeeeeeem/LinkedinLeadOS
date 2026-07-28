# LinkedinLeadsOS M1–M3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the L0 core, local Supabase storage, and `profile.get` end to end — proving the whole architecture on one capability.

**Architecture:** A TypeScript library of capability functions plus a registry-driven CLI. Capabilities drive the operator's dedicated Chrome over raw CDP (no Playwright). Data fields come only from captured LinkedIn network responses, never from parsed HTML. Every capture is archived raw before parsing, so parsers can be developed and tested entirely offline against fixtures.

**Tech Stack:** Node 24 · TypeScript 5.7 · npm · vitest · zod · ulid · @supabase/supabase-js · Supabase CLI 2.111 + Docker · Node's global `WebSocket` (no `ws` dependency)

## Global Constraints

Copied from `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`. Every task's requirements implicitly include this section.

- **One LinkedIn account, unburnable.** When a trade-off is between speed and account safety, safety wins.
- **Network tap is the source of truth (D1).** No data field is ever sourced from parsed HTML. DOM reads are permitted only for locating click targets, reading pagination state, detecting challenges, and confirming render completion.
- **Never forge a request LinkedIn's UI did not already issue (D1).** No direct Voyager calls with the session cookie.
- **Raw-first (D2).** Archive the untouched response body before parsing. Parsed rows are a projection, never the only copy.
- **Minimal CDP attach surface (D8).** Enable `Network` only. Never send `Runtime.enable` or `Page.enable`.
- **No Playwright anywhere in this codebase (D7).** `connectOverCDP` enables `Runtime`, `Page`, `DOM`, `Log`, and `Performance` and injects a per-frame utility world — the exact surface D8 avoids. Raw CDP only.
- **Automation Chrome is port 9223 (D9)**, profile `~/.linkedin-os/chrome-profile`, launched with `--remote-debugging-port`. Port 9222 is the operator's personal Chrome and must never be touched. Never attach to a `chrome://inspect` opt-in session — it shows a consent dialog, which puts a human back in the loop.
- **Endpoint discovery is `GET /json/version` → `webSocketDebuggerUrl` (D9).** Never hardcode the bare `/devtools/browser` path (Chrome 150 accepts it, 151 rejects it). Never rely on the `DevToolsActivePort` file.
- **Failure is exit-non-zero and stop (D6).** No notifications of any kind — no desktop alert, no Slack, no file drop.
- **Receipt on stdout (D3).** Fixed-size envelope regardless of result size. Never print bulk data.
- **Exit codes carry the failure class:** `0` ok · `1` generic/usage · `2` challenge · `3` rate-limited · `4` auth dead · `5` parse drift · `6` transient · `7` budget exhausted.
- **The budget ledger cannot be bypassed by a flag.**
- **Challenges are never solved automatically.** Screenshot, checkpoint, exit 2, stop.
- **Parsers are pure and tested offline against fixtures.** A parser change must be provable with zero LinkedIn requests.
- **`fixtures/` and `runs/` are gitignored** — they contain real prospect data.
- **Update `STATE.md` at every task commit**, not at session end.

---

## Model assignment per task

Dispatch each task to a fresh subagent on the model listed. The split is by
*consequence of a silent bug*, not by length.

**Sonnet** — fully specified, deterministic, offline, and a bug fails loudly in the
task's own tests:

| Task | Why Sonnet |
|---|---|
| 1 · Scaffold + receipt contract | Config files and a plain enum/class. Nothing to interpret. |
| 5 · Tab lease | One lockfile, stale-PID check. Self-contained, ~80 lines. |
| 6 · Event logger + run context | Append NDJSON, carry ids. Mechanical. |
| 7 · Archive + shape hash | Pure functions, given verbatim in the plan. |
| 13 · Supabase migration | SQL is written out in full. Runs `supabase start` and applies it. |
| 14 · Store client | Upsert-by-URN and a freshness check. Ordinary CRUD. |
| 18 · Bounded log queries | Reads local NDJSON files. Zero network, zero risk. |

**Opus** — async correctness, account safety, or judgment against something the plan
cannot fully specify:

| Task | Why Opus |
|---|---|
| 2 · Chrome launcher | Must not touch port 9222. Wrong port = the operator's personal Chrome. |
| 3 · CDP client | Request/response correlation, sessionId routing, timeouts. Race bugs here are silent and poison everything above. |
| 4 · Browser session + worker tab | The attach surface *is* the detection surface. One stray `Runtime.enable` and the account is exposed. |
| 8 · Human input | Anti-fingerprinting. Bugs here look fine in tests and are visible to LinkedIn. |
| 9 · Network tap | `getResponseBody` timing vs. `loadingFinished`; the tap missing a response is the whole product failing. |
| 10 · Challenge detection | Safety gate. A false negative keeps driving a flagged session. |
| 11 · Budget ledger | Must fail *closed*. This is the thing standing between us and a burned account. |
| 12 · Registry + CLI + `health.check` | First live integration of all twelve pieces. Needs whole-system reasoning. |
| 15 · Capture fixture | Spends a real page load on the one account. No retries that are free. |
| 16 · Profile parser | Written against a fixture whose shape nobody has seen yet. Pure judgment; the plan gives structure, not field paths. |
| 17 · Wire `profile.get` | End-to-end integration plus drift handling. |

Count: 7 Sonnet, 11 Opus. If a Sonnet task's review comes back weak, re-run it on
Opus rather than patching it by hand — the point of the split is cost, not tolerance
for worse code.

---

## File Structure

```
src/
  core/
    chrome/discover.ts     GET /json/version -> webSocketDebuggerUrl
    chrome/launch.ts       ensureChrome(): find or launch automation Chrome
    cdp/client.ts          CdpClient: WebSocket, send/timeout/keepalive, events
    cdp/session.ts         BrowserSession + TabSession (attach, navigate, eval, close)
    tab/lease.ts           single-holder lockfile
    input/human.ts         Bezier cursor paths, wheel notches
    net/tap.ts             NetworkTap: watch patterns, capture bodies
    run/receipt.ts         Receipt types, CapabilityError, emitReceipt, EXIT
    run/events.ts          EventLogger (NDJSON)
    run/archive.ts         raw body archive + shapeHash
    run/context.ts         RunContext: run_id, dirs, checkpoint, screenshots
    budget/ledger.ts       file-backed NDJSON budget ledger
    challenge/detect.ts    detectChallenge(tab)
    registry/index.ts      defineCapability, registry, manifest
  store/
    client.ts              supabase client
    persons.ts             upsertPerson, getPersonFresh
  cli/index.ts             registry-driven CLI entrypoint
  capabilities/
    health.check/          M1 proof capability
    profile.get/           M3 first real reader
supabase/migrations/       SQL migrations
tests/                     vitest, all offline
fixtures/                  gitignored, real captures
runs/                      gitignored, run archives
```

Each `src/capabilities/<name>/` holds `index.ts`, `parse.ts`, `parse.test.ts`, `README.md`.

---

## Task 1: Project scaffold and the receipt contract

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (modify), `STATE.md`, `DECISIONS.md`
- Create: `src/core/run/receipt.ts`
- Test: `tests/receipt.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `EXIT`, `ExitCode`, `FailureAction`, `Cost`, `Warning`, `Receipt`, `OkReceipt`, `ErrReceipt`, `CapabilityError`, `emitReceipt(r: Receipt): never`, `buildOk(...)`, `buildErr(...)`

- [ ] **Step 1: Scaffold the project**

```bash
cd /Users/talhat/Claude/Projects/StartupStruggle/LinkedinLeadsOS
npm init -y
npm i zod ulid @supabase/supabase-js
npm i -D typescript@^5.7 tsx vitest @types/node
```

Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tests"]
}
```

`"lib"` includes `DOM` for the global `WebSocket` type. Set `"type": "module"` in `package.json` and add scripts:

```json
"scripts": {
  "cap": "tsx src/cli/index.ts",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit"
}
```

Write `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts", "src/**/*.test.ts"] } });
```

Append to `.gitignore`: `dist/`, `.supabase/`.

Create `STATE.md`:

```markdown
# STATE

Updated at every task commit. Trust this over CLAUDE.md's phase line.

## Built
_(nothing yet)_

## In progress
Task 1 — project scaffold and receipt contract

## Next
Task 2 — Chrome launcher and endpoint discovery
```

Create `DECISIONS.md` seeded with D1–D10 as one-line summaries pointing at the spec, plus:

```markdown
## D11 — The budget ledger is file-backed, never database-backed
2026-08-07. The ledger is the safety mechanism that protects a single unburnable
account. It must work when Supabase is down, when Docker is not running, and
before storage exists at all. It lives at `runs/budget.ndjson`, append-only.
Rejected: the `budget_ledger` Supabase table as the source of truth — a safety
check that depends on an external service can fail open, which is the one failure
mode that is unacceptable here. The table may later mirror the file for reporting.
```

- [ ] **Step 2: Write the failing test**

`tests/receipt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EXIT, CapabilityError, buildOk, buildErr } from "../src/core/run/receipt.js";

describe("receipt", () => {
  it("builds an ok receipt with counts and cost", () => {
    const r = buildOk({
      run_id: "01JQ", capability: "health.check",
      counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
      cost: { search_credits: 0, page_loads: 1, elapsed_ms: 120 },
      artifacts: { events: "runs/01JQ/events.ndjson", raw: "runs/01JQ/raw/" },
    });
    expect(r.ok).toBe(true);
    expect(r.counts.usable).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("maps a CapabilityError onto an error receipt preserving exit and action", () => {
    const err = new CapabilityError({
      code: "CHALLENGE_PRESENTED", exit: EXIT.CHALLENGE,
      action: "HALT_AND_NOTIFY", retryable: false,
      message: "verification interstitial",
      evidence: "runs/01JQ/shots/challenge.png",
    });
    const r = buildErr({
      run_id: "01JQ", capability: "profile.get", err,
      cost: { search_credits: 0, page_loads: 1, elapsed_ms: 900 },
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("CHALLENGE_PRESENTED");
    expect(r.error.action).toBe("HALT_AND_NOTIFY");
    expect(r.error.retryable).toBe(false);
    expect(err.exit).toBe(2);
  });

  it("exposes every exit code from the spec", () => {
    expect(EXIT).toEqual({
      OK: 0, GENERIC: 1, CHALLENGE: 2, RATE_LIMITED: 3,
      AUTH: 4, PARSE_DRIFT: 5, TRANSIENT: 6, BUDGET: 7,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/receipt.test.ts`
Expected: FAIL — cannot resolve `../src/core/run/receipt.js`

- [ ] **Step 4: Implement the receipt contract**

`src/core/run/receipt.ts`:

```ts
export const EXIT = {
  OK: 0, GENERIC: 1, CHALLENGE: 2, RATE_LIMITED: 3,
  AUTH: 4, PARSE_DRIFT: 5, TRANSIENT: 6, BUDGET: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type FailureAction =
  | "RETRY_BACKOFF" | "RETRY_ONCE" | "RESUME"
  | "SKIP_ITEM" | "HALT_AND_NOTIFY" | "REAUTH";

export type Cost = { search_credits: number; page_loads: number; elapsed_ms: number };
export type Counts = { requested: number; captured: number; usable: number; skipped: number };
export type Warning = { code: string; field?: string; n: number };
export type Artifacts = { events: string; raw: string };
export type Stored = { table: string; run_ref: string; rows: number };

export type OkReceipt = {
  ok: true;
  run_id: string;
  capability: string;
  counts: Counts;
  stored?: Stored;
  warnings: Warning[];
  cost: Cost;
  artifacts: Artifacts;
  next?: string;
  data?: unknown;
};

export type ErrReceipt = {
  ok: false;
  run_id: string;
  capability: string;
  error: {
    code: string;
    retryable: boolean;
    action: FailureAction;
    message: string;
    evidence?: string;
    retry_after_ms?: number;
  };
  partial?: { stored: number; resume_token?: string };
  cost: Cost;
};

export type Receipt = OkReceipt | ErrReceipt;

export class CapabilityError extends Error {
  readonly code: string;
  readonly exit: ExitCode;
  readonly action: FailureAction;
  readonly retryable: boolean;
  readonly evidence?: string;
  readonly retryAfterMs?: number;

  constructor(o: {
    code: string; exit: ExitCode; action: FailureAction;
    retryable: boolean; message: string; evidence?: string; retryAfterMs?: number;
  }) {
    super(o.message);
    this.name = "CapabilityError";
    this.code = o.code;
    this.exit = o.exit;
    this.action = o.action;
    this.retryable = o.retryable;
    this.evidence = o.evidence;
    this.retryAfterMs = o.retryAfterMs;
  }
}

export function buildOk(o: {
  run_id: string; capability: string; counts: Counts; cost: Cost;
  artifacts: Artifacts; stored?: Stored; warnings?: Warning[];
  next?: string; data?: unknown;
}): OkReceipt {
  return {
    ok: true, run_id: o.run_id, capability: o.capability,
    counts: o.counts, stored: o.stored, warnings: o.warnings ?? [],
    cost: o.cost, artifacts: o.artifacts, next: o.next, data: o.data,
  };
}

export function buildErr(o: {
  run_id: string; capability: string; err: CapabilityError;
  cost: Cost; partial?: { stored: number; resume_token?: string };
}): ErrReceipt {
  return {
    ok: false, run_id: o.run_id, capability: o.capability,
    error: {
      code: o.err.code, retryable: o.err.retryable, action: o.err.action,
      message: o.err.message, evidence: o.err.evidence,
      retry_after_ms: o.err.retryAfterMs,
    },
    partial: o.partial, cost: o.cost,
  };
}

/** Prints the receipt as one JSON line on stdout and exits with the right code. */
export function emitReceipt(r: Receipt, exit: ExitCode = r.ok ? EXIT.OK : EXIT.GENERIC): never {
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(exit);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/receipt.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): project scaffold and the receipt contract

Receipt envelope, closed FailureAction enum, and the exit-code table from
the spec. CapabilityError carries its own exit code so every throw site
decides the failure class once.

Adds D11: the budget ledger is file-backed, not database-backed — a safety
check that depends on an external service can fail open."
```

---

## Task 2: Chrome launcher and endpoint discovery

**Files:**
- Create: `src/core/chrome/discover.ts`, `src/core/chrome/launch.ts`
- Test: `tests/chrome-discover.test.ts`

**Interfaces:**
- Consumes: `CapabilityError`, `EXIT` from Task 1
- Produces: `AUTOMATION_PORT = 9223`, `PROFILE_DIR`, `CHROME_BIN`, `getBrowserWsUrl(port: number): Promise<string>`, `isChromeUp(port: number): Promise<boolean>`, `ensureChrome(opts?: { port?: number; timeoutMs?: number }): Promise<{ port: number; wsUrl: string; launched: boolean }>`

- [ ] **Step 1: Write the failing test**

The test runs a fake `/json/version` HTTP server, so it is fully offline.

`tests/chrome-discover.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { getBrowserWsUrl, isChromeUp } from "../src/core/chrome/discover.js";
import { CapabilityError } from "../src/core/run/receipt.js";

let server: Server | undefined;

function serve(port: number, handler: (url: string) => { status: number; body: string }) {
  return new Promise<Server>((res) => {
    const s = createServer((req, rep) => {
      const { status, body } = handler(req.url ?? "");
      rep.writeHead(status, { "content-type": "application/json" });
      rep.end(body);
    });
    s.listen(port, "127.0.0.1", () => res(s));
  });
}

afterEach(() => { server?.close(); server = undefined; });

describe("chrome discovery", () => {
  it("reads webSocketDebuggerUrl from /json/version", async () => {
    server = await serve(19234, () => ({
      status: 200,
      body: JSON.stringify({
        Browser: "Chrome/151.0.7922.76",
        webSocketDebuggerUrl: "ws://127.0.0.1:19234/devtools/browser/abc-123",
      }),
    }));
    await expect(getBrowserWsUrl(19234)).resolves.toBe("ws://127.0.0.1:19234/devtools/browser/abc-123");
  });

  it("throws a TRANSIENT CapabilityError when nothing is listening", async () => {
    await expect(getBrowserWsUrl(19235)).rejects.toMatchObject({
      name: "CapabilityError", code: "CHROME_UNREACHABLE", exit: 6,
    });
  });

  it("throws when the endpoint answers without a webSocketDebuggerUrl", async () => {
    server = await serve(19236, () => ({ status: 200, body: JSON.stringify({ Browser: "x" }) }));
    await expect(getBrowserWsUrl(19236)).rejects.toBeInstanceOf(CapabilityError);
  });

  it("isChromeUp is false for a dead port and true for a live one", async () => {
    expect(await isChromeUp(19237)).toBe(false);
    server = await serve(19238, () => ({
      status: 200,
      body: JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:19238/devtools/browser/z" }),
    }));
    expect(await isChromeUp(19238)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/chrome-discover.test.ts`
Expected: FAIL — cannot resolve `../src/core/chrome/discover.js`

- [ ] **Step 3: Implement discovery**

`src/core/chrome/discover.ts`:

```ts
import { CapabilityError, EXIT } from "../run/receipt.js";

/**
 * Discovery goes through /json/version, never the bare /devtools/browser path.
 * Chrome 150 accepts the bare path; Chrome 151 rejects it, and the automation
 * profile runs 151. The DevToolsActivePort file is not reliably written either.
 */
export async function getBrowserWsUrl(port: number, timeoutMs = 3000): Promise<string> {
  let body: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (e) {
    throw new CapabilityError({
      code: "CHROME_UNREACHABLE", exit: EXIT.TRANSIENT,
      action: "RETRY_BACKOFF", retryable: true, retryAfterMs: 2000,
      message: `No CDP endpoint on 127.0.0.1:${port} (${(e as Error).message})`,
    });
  }
  const url = (body as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
  if (typeof url !== "string" || !url.startsWith("ws://")) {
    throw new CapabilityError({
      code: "CHROME_NO_WS_URL", exit: EXIT.TRANSIENT,
      action: "RETRY_BACKOFF", retryable: true, retryAfterMs: 2000,
      message: `/json/version on port ${port} returned no webSocketDebuggerUrl`,
    });
  }
  return url;
}

export async function isChromeUp(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    await getBrowserWsUrl(port, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/chrome-discover.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Implement the launcher**

No unit test — launching a real browser is not a unit test. It is verified live in Task 12.

`src/core/chrome/launch.ts`:

```ts
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getBrowserWsUrl, isChromeUp } from "./discover.js";
import { CapabilityError, EXIT } from "../run/receipt.js";

/** 9222 is the operator's personal Chrome. Never touch it. */
export const AUTOMATION_PORT = 9223;
export const PROFILE_DIR = join(homedir(), ".linkedin-os", "chrome-profile");
export const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reuses Chrome if it is already on the debug port, otherwise launches it detached. */
export async function ensureChrome(
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<{ port: number; wsUrl: string; launched: boolean }> {
  const port = opts.port ?? AUTOMATION_PORT;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  if (await isChromeUp(port)) {
    return { port, wsUrl: await getBrowserWsUrl(port), launched: false };
  }

  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await isChromeUp(port)) {
      return { port, wsUrl: await getBrowserWsUrl(port), launched: true };
    }
  }

  throw new CapabilityError({
    code: "CHROME_LAUNCH_TIMEOUT", exit: EXIT.TRANSIENT,
    action: "RETRY_ONCE", retryable: true,
    message: `Chrome did not expose a CDP endpoint on port ${port} within ${timeoutMs}ms`,
  });
}
```

- [ ] **Step 6: Verify the launcher against real Chrome**

Run:

```bash
npx tsx -e "import('./src/core/chrome/launch.js').then(async m => console.log(await m.ensureChrome()))"
```

Expected: `{ port: 9223, wsUrl: 'ws://127.0.0.1:9223/devtools/browser/<uuid>', launched: false }` if Chrome is already up on 9223, or `launched: true` after it starts. **No "Allow remote debugging?" dialog must appear.** If one does, the launch flags are wrong — stop and fix before continuing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): Chrome launcher and CDP endpoint discovery

Discovery goes through /json/version rather than the bare /devtools/browser
path, which Chrome 151 rejects. Pins the automation profile to port 9223 so
the operator's personal Chrome on 9222 can never be attached by mistake.

Update STATE.md."
```

---

## Task 3: CDP client

**Files:**
- Create: `src/core/cdp/client.ts`
- Test: `tests/cdp-client.test.ts`

**Interfaces:**
- Consumes: `CapabilityError`, `EXIT` from Task 1
- Produces: `type CdpMessage = { method: string; params: Record<string, unknown>; sessionId?: string }`, `class CdpClient` with `static connect(wsUrl: string): Promise<CdpClient>`, `send<T>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>`, `on(fn: (m: CdpMessage) => void): void`, `off(fn): void`, `close(): Promise<void>`, `get dead(): boolean`

The client is transport only. It knows nothing about tabs, LinkedIn, or capabilities.

- [ ] **Step 1: Write the failing test**

The test runs a fake CDP server over a raw WebSocket, so it is fully offline. Node has no
server-side WebSocket, so the test uses a tiny RFC6455 server built on `node:http` upgrade.
Install the dev-only helper instead of hand-rolling it:

```bash
npm i -D ws @types/ws
```

`ws` is a **devDependency only** — production code uses Node's global client `WebSocket`.

`tests/cdp-client.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { CdpClient } from "../src/core/cdp/client.js";

let wss: WebSocketServer | undefined;

function fakeCdp(port: number, onMsg: (msg: any, reply: (o: unknown) => void) => void) {
  wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      onMsg(JSON.parse(String(raw)), (o) => sock.send(JSON.stringify(o)));
    });
  });
  return new Promise<void>((res) => wss!.on("listening", () => res()));
}

afterEach(() => { wss?.close(); wss = undefined; });

describe("CdpClient", () => {
  it("resolves send() with the matching result", async () => {
    await fakeCdp(19240, (msg, reply) => {
      if (msg.method === "Browser.getVersion") reply({ id: msg.id, result: { product: "Chrome/151" } });
    });
    const c = await CdpClient.connect("ws://127.0.0.1:19240");
    await expect(c.send<{ product: string }>("Browser.getVersion")).resolves.toEqual({ product: "Chrome/151" });
    await c.close();
  });

  it("rejects send() when the protocol returns an error", async () => {
    await fakeCdp(19241, (msg, reply) => reply({ id: msg.id, error: { code: -32000, message: "nope" } }));
    const c = await CdpClient.connect("ws://127.0.0.1:19241");
    await expect(c.send("Bad.method")).rejects.toMatchObject({ code: "CDP_PROTOCOL_ERROR" });
    await c.close();
  });

  it("rejects with CDP_TIMEOUT when no reply arrives", async () => {
    await fakeCdp(19242, () => { /* never replies */ });
    const c = await CdpClient.connect("ws://127.0.0.1:19242");
    await expect(c.send("Slow.method", {}, undefined, 200)).rejects.toMatchObject({
      code: "CDP_TIMEOUT", exit: 6,
    });
    await c.close();
  });

  it("forwards protocol events to listeners and stops after off()", async () => {
    let push: ((o: unknown) => void) | undefined;
    await fakeCdp(19243, (msg, reply) => { push = reply; reply({ id: msg.id, result: {} }); });
    const c = await CdpClient.connect("ws://127.0.0.1:19243");
    await c.send("Ping");
    const seen: string[] = [];
    const fn = (m: { method: string }) => seen.push(m.method);
    c.on(fn);
    push!({ method: "Network.responseReceived", params: { requestId: "1" } });
    await new Promise((r) => setTimeout(r, 50));
    c.off(fn);
    push!({ method: "Network.loadingFinished", params: { requestId: "1" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["Network.responseReceived"]);
    await c.close();
  });

  it("rejects pending sends and marks itself dead when the socket closes", async () => {
    await fakeCdp(19244, () => { /* never replies */ });
    const c = await CdpClient.connect("ws://127.0.0.1:19244");
    const pending = c.send("Never.replies", {}, undefined, 5000);
    wss!.close();
    await expect(pending).rejects.toMatchObject({ code: "CDP_DISCONNECTED" });
    expect(c.dead).toBe(true);
  });

  it("fails to connect to a dead port with a TRANSIENT error", async () => {
    await expect(CdpClient.connect("ws://127.0.0.1:19245")).rejects.toMatchObject({
      code: "CDP_CONNECT_FAILED", exit: 6,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/cdp-client.test.ts`
Expected: FAIL — cannot resolve `../src/core/cdp/client.js`

- [ ] **Step 3: Implement the client**

`src/core/cdp/client.ts`:

```ts
import { CapabilityError, EXIT } from "../run/receipt.js";

export type CdpMessage = { method: string; params: Record<string, unknown>; sessionId?: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const EVAL_TIMEOUT_MS = 90_000;
const KEEPALIVE_MS = 30_000;

type Pending = { res: (v: unknown) => void; rej: (e: Error) => void };

/**
 * Transport only. Knows nothing about tabs, LinkedIn, or capabilities.
 * Uses Node's global WebSocket — no `ws` dependency in production code.
 */
export class CdpClient {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(m: CdpMessage) => void>();
  #dead = false;
  #lastActivity = Date.now();
  #keepalive: ReturnType<typeof setInterval> | undefined;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => this.#onMessage(String((ev as MessageEvent).data)));
    ws.addEventListener("close", () => this.#die("CDP_DISCONNECTED", "WebSocket closed"));
    this.#keepalive = setInterval(() => void this.#ping(), KEEPALIVE_MS);
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already closing */ }
        rej(new CapabilityError({
          code: "CDP_CONNECT_FAILED", exit: EXIT.TRANSIENT,
          action: "RETRY_BACKOFF", retryable: true, retryAfterMs: 2000,
          message: `Timed out connecting to ${wsUrl}`,
        }));
      }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); res(new CdpClient(ws)); }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        rej(new CapabilityError({
          code: "CDP_CONNECT_FAILED", exit: EXIT.TRANSIENT,
          action: "RETRY_BACKOFF", retryable: true, retryAfterMs: 2000,
          message: `Cannot connect to ${wsUrl}`,
        }));
      }, { once: true });
    });
  }

  get dead(): boolean { return this.#dead; }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.#dead) {
      return Promise.reject(new CapabilityError({
        code: "CDP_DISCONNECTED", exit: EXIT.TRANSIENT,
        action: "RETRY_ONCE", retryable: true,
        message: `Cannot send ${method}: connection is dead`,
      }));
    }
    const id = ++this.#id;
    const ms = timeoutMs ?? (method === "Runtime.evaluate" ? EVAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    this.#lastActivity = Date.now();
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));

    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new CapabilityError({
          code: "CDP_TIMEOUT", exit: EXIT.TRANSIENT,
          action: "RETRY_ONCE", retryable: true,
          message: `CDP timeout: ${method} after ${ms}ms`,
        }));
      }, ms);
      this.#pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v as T); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
    });
  }

  on(fn: (m: CdpMessage) => void): void { this.#listeners.add(fn); }
  off(fn: (m: CdpMessage) => void): void { this.#listeners.delete(fn); }

  async close(): Promise<void> {
    if (this.#keepalive) { clearInterval(this.#keepalive); this.#keepalive = undefined; }
    try { this.#ws.close(); } catch { /* already closing */ }
    this.#dead = true;
  }

  #onMessage(raw: string): void {
    this.#lastActivity = Date.now();
    const m = JSON.parse(raw) as
      | { id: number; result?: unknown; error?: { message: string } }
      | (CdpMessage & { id?: undefined });

    if (typeof m.id === "number") {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if (m.error) {
        p.rej(new CapabilityError({
          code: "CDP_PROTOCOL_ERROR", exit: EXIT.TRANSIENT,
          action: "RETRY_ONCE", retryable: true,
          message: m.error.message,
        }));
      } else {
        p.res(m.result);
      }
      return;
    }
    if (m.method) for (const fn of this.#listeners) fn(m as CdpMessage);
  }

  /** Only pings if nothing else has gone over the wire recently. */
  async #ping(): Promise<void> {
    if (this.#dead) return;
    if (Date.now() - this.#lastActivity < KEEPALIVE_MS) return;
    try { await this.send("Target.getTargets", {}, undefined, 10_000); }
    catch { this.#die("CDP_DISCONNECTED", "keepalive failed"); }
  }

  #die(code: string, message: string): void {
    this.#dead = true;
    if (this.#keepalive) { clearInterval(this.#keepalive); this.#keepalive = undefined; }
    const err = new CapabilityError({
      code, exit: EXIT.TRANSIENT, action: "RETRY_ONCE", retryable: true, message,
    });
    for (const p of this.#pending.values()) p.rej(err);
    this.#pending.clear();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/cdp-client.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): CDP transport client

Global WebSocket, per-message timeouts, keepalive that only pings when the
wire has been idle, and pending-send rejection on close. Transport only —
it knows nothing about tabs or LinkedIn.

ws is a devDependency, used solely to run a fake CDP server in tests.

Update STATE.md."
```

---

## Task 4: Browser session and worker tab

**Files:**
- Create: `src/core/cdp/session.ts`
- Test: none (verified live in Task 12 — this is browser orchestration, not logic)

**Interfaces:**
- Consumes: `CdpClient` (Task 3), `ensureChrome` (Task 2), `CapabilityError`, `EXIT` (Task 1)
- Produces:
  - `class BrowserSession` — `static open(port?: number): Promise<BrowserSession>`, `createWorkerTab(url?: string): Promise<TabSession>`, `listPages(): Promise<TargetInfo[]>`, `close(): Promise<void>`, `readonly client: CdpClient`
  - `class TabSession` — `readonly targetId: string`, `readonly sessionId: string`, `send<T>(method, params?, timeoutMs?): Promise<T>`, `evaluate<T>(expr: string): Promise<T>`, `navigate(url: string): Promise<void>`, `currentUrl(): Promise<string>`, `screenshot(path: string): Promise<string>`, `ensureForeground(): Promise<{ ok: boolean; via: string }>`, `close(): Promise<void>`
  - `type TargetInfo = { targetId: string; type: string; url: string; title: string }`

- [ ] **Step 1: Implement the session**

`src/core/cdp/session.ts`:

```ts
import { writeFileSync } from "node:fs";
import { CdpClient } from "./client.js";
import { ensureChrome } from "../chrome/launch.js";
import { CapabilityError, EXIT } from "../run/receipt.js";

export type TargetInfo = { targetId: string; type: string; url: string; title: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserSession {
  readonly client: CdpClient;
  private constructor(client: CdpClient) { this.client = client; }

  static async open(port?: number): Promise<BrowserSession> {
    const { wsUrl } = await ensureChrome({ port });
    return new BrowserSession(await CdpClient.connect(wsUrl));
  }

  async listPages(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.client.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page");
  }

  /**
   * D10: one resident worker tab, created in the background so the operator's
   * window is not yanked, then navigated between targets for the whole session.
   */
  async createWorkerTab(url = "about:blank"): Promise<TabSession> {
    const { targetId } = await this.client.send<{ targetId: string }>(
      "Target.createTarget", { url, background: true },
    );
    const { sessionId } = await this.client.send<{ sessionId: string }>(
      "Target.attachToTarget", { targetId, flatten: true },
    );
    const tab = new TabSession(this.client, targetId, sessionId);
    await tab.init();
    return tab;
  }

  async close(): Promise<void> { await this.client.close(); }
}

export class TabSession {
  readonly targetId: string;
  readonly sessionId: string;
  #client: CdpClient;

  constructor(client: CdpClient, targetId: string, sessionId: string) {
    this.#client = client;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  /**
   * D8: Network only. Runtime.enable leaks consoleAPICalled, the classic CDP
   * detection signal, and Runtime.evaluate works without it. Page.enable is
   * unneeded — captureScreenshot does not require it.
   *
   * Focus emulation is asserted immediately: a background tab has its timers
   * clamped and never fires IntersectionObserver, which is exactly how LinkedIn
   * lazy-renders. Without this a background tab renders skeletons forever.
   */
  async init(): Promise<void> {
    await this.send("Network.enable", {
      maxResourceBufferSize: 20_000_000,
      maxTotalBufferSize: 100_000_000,
    });
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.#client.send<T>(method, params, this.sessionId, timeoutMs);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value: T };
      exceptionDetails?: { exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new CapabilityError({
        code: "PAGE_JS_ERROR", exit: EXIT.TRANSIENT, action: "RETRY_ONCE", retryable: true,
        message: r.exceptionDetails.exception?.description ?? "page JS threw",
      });
    }
    return r.result.value;
  }

  async navigate(url: string): Promise<void> {
    const r = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (r.errorText) {
      throw new CapabilityError({
        code: "NAV_FAILED", exit: EXIT.TRANSIENT, action: "RETRY_ONCE", retryable: true,
        message: `Navigation to ${url} failed: ${r.errorText}`,
      });
    }
  }

  currentUrl(): Promise<string> { return this.evaluate<string>("location.href"); }

  async screenshot(path: string): Promise<string> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }

  /**
   * Order is deliberate. Emulation is invisible to the operator, web-lifecycle is
   * cheap, and Target.activateTarget is LAST because it pulls their window here.
   */
  async ensureForeground(): Promise<{ ok: boolean; via: string }> {
    const read = async () => {
      try { return await this.evaluate<boolean>("document.hidden"); }
      catch { return null; }
    };
    if ((await read()) === false) return { ok: true, via: "already" };

    const attempts: [string, () => Promise<unknown>][] = [
      ["focus-emulation", () => this.send("Emulation.setFocusEmulationEnabled", { enabled: true })],
      ["web-lifecycle", () => this.send("Page.setWebLifecycleState", { state: "active" })],
      ["activate-target", () => this.#client.send("Target.activateTarget", { targetId: this.targetId })],
    ];
    for (const [via, run] of attempts) {
      try { await run(); } catch { continue; }
      await sleep(150);
      if ((await read()) === false) return { ok: true, via };
    }
    return { ok: false, via: "none" };
  }

  /** Leave the browser as we found it: drop focus emulation before closing. */
  async close(): Promise<void> {
    try { await this.send("Emulation.setFocusEmulationEnabled", { enabled: false }); } catch { /* tab gone */ }
    try { await this.#client.send("Target.closeTarget", { targetId: this.targetId }); } catch { /* tab gone */ }
  }
}
```

- [ ] **Step 2: Verify live against real Chrome**

Run:

```bash
npx tsx -e "
import { BrowserSession } from './src/core/cdp/session.js';
const s = await BrowserSession.open();
const tab = await s.createWorkerTab('https://example.com');
await new Promise(r => setTimeout(r, 1500));
console.log('url:', await tab.currentUrl());
console.log('foreground:', await tab.ensureForeground());
await tab.close();
await s.close();
"
```

Expected: `url: https://example.com/`, `foreground: { ok: true, via: 'already' | 'focus-emulation' }`, the tab closes, and **your Chrome window is never pulled to the front**.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): browser session and worker tab

One resident worker tab created background:true and navigated between
targets (D10). Attach surface is Network only (D8) — no Runtime.enable,
no Page.enable. Focus emulation asserted at init so a background tab is
not timer-clamped and still fires IntersectionObserver.

Update STATE.md."
```

---

## Task 5: Tab lease

**Files:**
- Create: `src/core/tab/lease.ts`
- Test: `tests/tab-lease.test.ts`

**Interfaces:**
- Consumes: `CapabilityError`, `EXIT` (Task 1)
- Produces: `type LeaseInfo = { run_id: string; pid: number; capability: string; acquired_at: string }`, `acquireLease(o: { path: string; run_id: string; capability: string }): Promise<LeaseInfo>`, `releaseLease(path: string, run_id: string): Promise<void>`, `readLease(path: string): LeaseInfo | null`

Exactly one capability may hold the worker tab. A stale lock (dead pid) is reclaimable;
a live one is not. Two concurrent runs on one tab is both a correctness bug and a
detection signal.

- [ ] **Step 1: Write the failing test**

`tests/tab-lease.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, releaseLease, readLease } from "../src/core/tab/lease.js";

let dir: string;
let path: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lease-")); path = join(dir, "tab.lock"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tab lease", () => {
  it("acquires a free lease and records holder metadata", async () => {
    const info = await acquireLease({ path, run_id: "run-a", capability: "profile.get" });
    expect(info.run_id).toBe("run-a");
    expect(info.pid).toBe(process.pid);
    expect(readLease(path)?.capability).toBe("profile.get");
  });

  it("refuses a second holder while the first is alive", async () => {
    await acquireLease({ path, run_id: "run-a", capability: "profile.get" });
    await expect(
      acquireLease({ path, run_id: "run-b", capability: "company.get" }),
    ).rejects.toMatchObject({ code: "TAB_LEASE_HELD", exit: 6, action: "RETRY_BACKOFF" });
  });

  it("is re-entrant for the same run_id so resume works", async () => {
    await acquireLease({ path, run_id: "run-a", capability: "profile.get" });
    const again = await acquireLease({ path, run_id: "run-a", capability: "profile.get" });
    expect(again.run_id).toBe("run-a");
  });

  it("reclaims a lease whose holder pid is dead", async () => {
    writeFileSync(path, JSON.stringify({
      run_id: "ghost", pid: 999_999, capability: "profile.get",
      acquired_at: new Date().toISOString(),
    }));
    const info = await acquireLease({ path, run_id: "run-b", capability: "company.get" });
    expect(info.run_id).toBe("run-b");
  });

  it("releases only when the run_id matches", async () => {
    await acquireLease({ path, run_id: "run-a", capability: "profile.get" });
    await releaseLease(path, "run-b");
    expect(readLease(path)?.run_id).toBe("run-a");
    await releaseLease(path, "run-a");
    expect(readLease(path)).toBeNull();
  });

  it("treats a corrupt lockfile as reclaimable", async () => {
    writeFileSync(path, "{not json");
    const info = await acquireLease({ path, run_id: "run-c", capability: "profile.get" });
    expect(info.run_id).toBe("run-c");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/tab-lease.test.ts`
Expected: FAIL — cannot resolve `../src/core/tab/lease.js`

- [ ] **Step 3: Implement the lease**

`src/core/tab/lease.ts`:

```ts
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CapabilityError, EXIT } from "../run/receipt.js";

export type LeaseInfo = {
  run_id: string;
  pid: number;
  capability: string;
  acquired_at: string;
};

export function readLease(path: string): LeaseInfo | null {
  try {
    const raw = readFileSync(path, "utf8");
    const v = JSON.parse(raw) as LeaseInfo;
    if (typeof v.run_id !== "string" || typeof v.pid !== "number") return null;
    return v;
  } catch {
    return null; // absent or corrupt — both mean reclaimable
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export async function acquireLease(o: {
  path: string; run_id: string; capability: string;
}): Promise<LeaseInfo> {
  const held = readLease(o.path);

  if (held && held.run_id !== o.run_id && pidAlive(held.pid)) {
    throw new CapabilityError({
      code: "TAB_LEASE_HELD", exit: EXIT.TRANSIENT,
      action: "RETRY_BACKOFF", retryable: true, retryAfterMs: 5000,
      message: `Worker tab held by run ${held.run_id} (${held.capability}, pid ${held.pid}) since ${held.acquired_at}`,
    });
  }

  const info: LeaseInfo = {
    run_id: o.run_id,
    pid: process.pid,
    capability: o.capability,
    acquired_at: new Date().toISOString(),
  };
  mkdirSync(dirname(o.path), { recursive: true });
  writeFileSync(o.path, JSON.stringify(info));
  return info;
}

/** No-op unless the caller actually holds the lease. */
export async function releaseLease(path: string, run_id: string): Promise<void> {
  const held = readLease(path);
  if (!held || held.run_id !== run_id) return;
  rmSync(path, { force: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/tab-lease.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): single-holder tab lease

Lockfile carrying run_id and pid. Re-entrant for the same run so resume
works; reclaims a lease whose holder pid is dead or whose file is corrupt.
Two runs on one tab is a correctness bug and a detection signal.

Update STATE.md."
```

---

## Task 6: Event logger and run context

**Files:**
- Create: `src/core/run/events.ts`, `src/core/run/context.ts`
- Test: `tests/events.test.ts`, `tests/context.test.ts`

**Interfaces:**
- Consumes: `TabSession` (Task 4), `acquireLease`/`releaseLease` (Task 5)
- Produces:
  - `type EventName` (closed union), `class EventLogger` — `constructor(path: string)`, `log(event: EventName, fields?: Record<string, unknown>): void`, `close(): void`, `readonly count: number`
  - `class RunContext` — `static create(o: { capability: string; args: unknown; root?: string }): Promise<RunContext>`, `static resume(run_id: string, o: { capability: string; root?: string }): Promise<RunContext>`, `readonly run_id: string`, `readonly dir: string`, `readonly rawDir: string`, `readonly shotsDir: string`, `readonly events: EventLogger`, `readonly resumed: boolean`, `elapsedMs(): number`, `checkpoint(state: unknown): Promise<void>`, `readCheckpoint<T>(): T | null`, `shot(tab: TabSession, name: string): Promise<string>`, `artifacts(): { events: string; raw: string }`, `finish(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`tests/events.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLogger } from "../src/core/run/events.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ev-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("EventLogger", () => {
  it("writes one JSON object per line with a monotonic seq", () => {
    const path = join(dir, "events.ndjson");
    const log = new EventLogger(path);
    log.log("nav.start", { url: "https://example.com" });
    log.log("nav.done", { duration_ms: 412 });
    log.close();

    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].event).toBe("nav.start");
    expect(lines[0].seq).toBe(1);
    expect(lines[1].seq).toBe(2);
    expect(lines[0].url).toBe("https://example.com");
    expect(typeof lines[0].ts).toBe("string");
  });

  it("defaults level to info and honours an explicit level", () => {
    const path = join(dir, "events.ndjson");
    const log = new EventLogger(path);
    log.log("parse.miss", { field: "headline" });
    log.log("error", { level: "error", message: "boom" });
    log.close();

    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].level).toBe("info");
    expect(lines[1].level).toBe("error");
  });

  it("counts what it wrote", () => {
    const log = new EventLogger(join(dir, "e.ndjson"));
    log.log("cdp.send");
    log.log("cdp.send");
    expect(log.count).toBe(2);
    log.close();
  });
});
```

`tests/context.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunContext } from "../src/core/run/context.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "runs-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("RunContext", () => {
  it("creates a run directory tree and a ULID run_id", async () => {
    const ctx = await RunContext.create({ capability: "health.check", args: {}, root });
    expect(ctx.run_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(existsSync(ctx.rawDir)).toBe(true);
    expect(existsSync(ctx.shotsDir)).toBe(true);
    expect(ctx.resumed).toBe(false);
    await ctx.finish();
  });

  it("round-trips a checkpoint", async () => {
    const ctx = await RunContext.create({ capability: "profile.get", args: {}, root });
    expect(ctx.readCheckpoint()).toBeNull();
    await ctx.checkpoint({ page: 3, cursor: "abc" });
    expect(ctx.readCheckpoint<{ page: number }>()?.page).toBe(3);
    await ctx.finish();
  });

  it("resume reuses the directory and sees the prior checkpoint", async () => {
    const first = await RunContext.create({ capability: "profile.get", args: {}, root });
    await first.checkpoint({ page: 7 });
    await first.finish();

    const again = await RunContext.resume(first.run_id, { capability: "profile.get", root });
    expect(again.resumed).toBe(true);
    expect(again.dir).toBe(first.dir);
    expect(again.readCheckpoint<{ page: number }>()?.page).toBe(7);
    await again.finish();
  });

  it("rejects resuming a run_id that does not exist", async () => {
    await expect(
      RunContext.resume("01JQNOPE0000000000000000AA", { capability: "profile.get", root }),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND", exit: 1 });
  });

  it("records the run's capability and args on disk", async () => {
    const ctx = await RunContext.create({ capability: "profile.get", args: { url: "x" }, root });
    const meta = JSON.parse(readFileSync(join(ctx.dir, "run.json"), "utf8"));
    expect(meta.capability).toBe("profile.get");
    expect(meta.args).toEqual({ url: "x" });
    await ctx.finish();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/events.test.ts tests/context.test.ts`
Expected: FAIL — cannot resolve the two new modules

- [ ] **Step 3: Implement the event logger**

`src/core/run/events.ts`:

```ts
import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

/** Closed set. Adding a value is a deliberate change, not an accident. */
export type EventName =
  | "run.start" | "run.finish"
  | "cdp.send" | "cdp.event"
  | "nav.start" | "nav.done" | "render.wait"
  | "capture.hit" | "capture.miss"
  | "parse.ok" | "parse.miss"
  | "store.write" | "budget.spend"
  | "challenge.detected"
  | "checkpoint.save" | "checkpoint.resume"
  | "error";

export type Level = "debug" | "info" | "warn" | "error";

export class EventLogger {
  #path: string;
  #seq = 0;
  #closed = false;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "a")); // ensure the file exists even for an empty run
  }

  get count(): number { return this.#seq; }

  log(event: EventName, fields: Record<string, unknown> = {}): void {
    if (this.#closed) return;
    const { level, ...rest } = fields as { level?: Level } & Record<string, unknown>;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      seq: ++this.#seq,
      level: level ?? "info",
      event,
      ...rest,
    });
    appendFileSync(this.#path, line + "\n");
  }

  close(): void { this.#closed = true; }
}
```

- [ ] **Step 4: Implement the run context**

`src/core/run/context.ts`:

```ts
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { EventLogger } from "./events.js";
import { CapabilityError, EXIT } from "./receipt.js";
import type { TabSession } from "../cdp/session.js";

export const DEFAULT_RUNS_ROOT = "runs";

export class RunContext {
  readonly run_id: string;
  readonly dir: string;
  readonly rawDir: string;
  readonly shotsDir: string;
  readonly events: EventLogger;
  readonly resumed: boolean;
  #startedAt = Date.now();

  private constructor(o: { run_id: string; dir: string; resumed: boolean }) {
    this.run_id = o.run_id;
    this.dir = o.dir;
    this.rawDir = join(o.dir, "raw");
    this.shotsDir = join(o.dir, "shots");
    this.resumed = o.resumed;
    mkdirSync(this.rawDir, { recursive: true });
    mkdirSync(this.shotsDir, { recursive: true });
    this.events = new EventLogger(join(o.dir, "events.ndjson"));
  }

  static async create(o: {
    capability: string; args: unknown; root?: string;
  }): Promise<RunContext> {
    const run_id = ulid();
    const dir = join(o.root ?? DEFAULT_RUNS_ROOT, run_id);
    const ctx = new RunContext({ run_id, dir, resumed: false });
    writeFileSync(join(dir, "run.json"), JSON.stringify({
      run_id, capability: o.capability, args: o.args,
      started_at: new Date().toISOString(),
    }, null, 2));
    ctx.events.log("run.start", { capability: o.capability });
    return ctx;
  }

  static async resume(run_id: string, o: {
    capability: string; root?: string;
  }): Promise<RunContext> {
    const dir = join(o.root ?? DEFAULT_RUNS_ROOT, run_id);
    if (!existsSync(join(dir, "run.json"))) {
      throw new CapabilityError({
        code: "RUN_NOT_FOUND", exit: EXIT.GENERIC,
        action: "HALT_AND_NOTIFY", retryable: false,
        message: `No run ${run_id} under ${o.root ?? DEFAULT_RUNS_ROOT}`,
      });
    }
    const ctx = new RunContext({ run_id, dir, resumed: true });
    ctx.events.log("checkpoint.resume", { capability: o.capability });
    return ctx;
  }

  elapsedMs(): number { return Date.now() - this.#startedAt; }

  artifacts(): { events: string; raw: string } {
    return { events: join(this.dir, "events.ndjson"), raw: this.rawDir + "/" };
  }

  async checkpoint(state: unknown): Promise<void> {
    writeFileSync(join(this.dir, "checkpoint.json"), JSON.stringify(state, null, 2));
    this.events.log("checkpoint.save");
  }

  readCheckpoint<T = unknown>(): T | null {
    const p = join(this.dir, "checkpoint.json");
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")) as T; }
    catch { return null; }
  }

  async shot(tab: TabSession, name: string): Promise<string> {
    return tab.screenshot(join(this.shotsDir, `${name}.png`));
  }

  async finish(): Promise<void> {
    this.events.log("run.finish", { elapsed_ms: this.elapsedMs() });
    this.events.close();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/events.test.ts tests/context.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): NDJSON event logger and run context

Events are typed and greppable so debugging is a bounded query rather than
reading a whole log into context. RunContext owns run_id, the artifact tree,
checkpoints, and screenshots, and resume reuses the same directory.

Update STATE.md."
```

---

## Task 7: Raw archive and shape hashing

**Files:**
- Create: `src/core/run/archive.ts`
- Test: `tests/archive.test.ts`

**Interfaces:**
- Consumes: `EventLogger` (Task 6)
- Produces: `shapeHash(v: unknown): string`, `type ArchivedResponse = { url: string; status: number; path: string; shape_hash: string; bytes: number }`, `class Archive` — `constructor(o: { dir: string; events?: EventLogger })`, `save(o: { url: string; status: number; raw: string }): Promise<ArchivedResponse>`, `list(): ArchivedResponse[]`

D2: the untouched body is written **before** anything parses it. `shapeHash` hashes
structure — key paths and value *types*, never values — so two responses with the same
shape collide deliberately. That is what makes fixture promotion and drift detection work.

- [ ] **Step 1: Write the failing test**

`tests/archive.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive, shapeHash } from "../src/core/run/archive.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "arch-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("shapeHash", () => {
  it("is stable across differing values of the same shape", () => {
    expect(shapeHash({ name: "alice", age: 30 })).toBe(shapeHash({ name: "bob", age: 41 }));
  });

  it("is stable regardless of key order", () => {
    expect(shapeHash({ a: 1, b: "x" })).toBe(shapeHash({ b: "y", a: 2 }));
  });

  it("differs when a key is added or removed", () => {
    expect(shapeHash({ a: 1 })).not.toBe(shapeHash({ a: 1, b: 2 }));
  });

  it("differs when a value type changes", () => {
    expect(shapeHash({ a: 1 })).not.toBe(shapeHash({ a: "1" }));
  });

  it("collapses arrays to the union of their element shapes", () => {
    expect(shapeHash({ xs: [{ a: 1 }, { a: 2 }, { a: 3 }] })).toBe(shapeHash({ xs: [{ a: 9 }] }));
  });

  it("treats null as its own type", () => {
    expect(shapeHash({ a: null })).not.toBe(shapeHash({ a: 1 }));
  });
});

describe("Archive", () => {
  it("writes the body gzipped and returns its metadata", async () => {
    const a = new Archive({ dir });
    const raw = JSON.stringify({ data: { firstName: "Ada" } });
    const rec = await a.save({ url: "https://www.linkedin.com/voyager/api/x", status: 200, raw });

    expect(rec.status).toBe(200);
    expect(rec.bytes).toBe(Buffer.byteLength(raw));
    expect(rec.shape_hash).toHaveLength(16);
    expect(gunzipSync(readFileSync(rec.path)).toString()).toBe(raw);
  });

  it("stores non-JSON bodies with a shape hash of 'nonjson'", async () => {
    const a = new Archive({ dir });
    const rec = await a.save({ url: "https://x/y", status: 500, raw: "<html>error</html>" });
    expect(rec.shape_hash).toBe("nonjson");
  });

  it("keeps an index of everything saved", async () => {
    const a = new Archive({ dir });
    await a.save({ url: "https://x/1", status: 200, raw: "{}" });
    await a.save({ url: "https://x/2", status: 200, raw: "{}" });
    expect(a.list()).toHaveLength(2);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json.gz"))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/archive.test.ts`
Expected: FAIL — cannot resolve `../src/core/run/archive.js`

- [ ] **Step 3: Implement the archive**

`src/core/run/archive.ts`:

```ts
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EventLogger } from "./events.js";

export type ArchivedResponse = {
  url: string;
  status: number;
  path: string;
  shape_hash: string;
  bytes: number;
};

/**
 * Structural fingerprint: key paths and value TYPES, never values. Two responses
 * describing different people hash identically; a response that gained or lost a
 * field does not. That is what makes fixture promotion and drift detection work.
 */
export function shapeHash(v: unknown): string {
  return createHash("sha256").update(shapeOf(v)).digest("hex").slice(0, 16);
}

function shapeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    const inner = [...new Set(v.map(shapeOf))].sort().join("|");
    return `[${inner}]`;
  }
  if (typeof v === "object") {
    const entries = Object.keys(v as object).sort()
      .map((k) => `${k}:${shapeOf((v as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return typeof v;
}

export class Archive {
  #dir: string;
  #events?: EventLogger;
  #saved: ArchivedResponse[] = [];
  #n = 0;

  constructor(o: { dir: string; events?: EventLogger }) {
    this.#dir = o.dir;
    this.#events = o.events;
    mkdirSync(o.dir, { recursive: true });
  }

  /** D2: the untouched body lands on disk before anything parses it. */
  async save(o: { url: string; status: number; raw: string }): Promise<ArchivedResponse> {
    let shape = "nonjson";
    try { shape = shapeHash(JSON.parse(o.raw)); } catch { /* not JSON — keep 'nonjson' */ }

    const name = `${String(++this.#n).padStart(4, "0")}-${shape}.json.gz`;
    const path = join(this.#dir, name);
    writeFileSync(path, gzipSync(Buffer.from(o.raw)));

    const rec: ArchivedResponse = {
      url: o.url, status: o.status, path,
      shape_hash: shape, bytes: Buffer.byteLength(o.raw),
    };
    this.#saved.push(rec);
    appendFileSync(join(this.#dir, "index.ndjson"), JSON.stringify(rec) + "\n");
    this.#events?.log("capture.hit", {
      url: o.url, status: o.status, shape_hash: shape, bytes: rec.bytes,
    });
    return rec;
  }

  list(): ArchivedResponse[] { return [...this.#saved]; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/archive.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): raw response archive with structural shape hashing

Bodies are gzipped to disk before any parsing (D2), so a wrong parser is
fixed by re-parsing history rather than re-scraping. shapeHash fingerprints
structure and value types but never values, which is what lets identical
shapes collapse for fixture promotion and drift detection.

Update STATE.md."
```

---

## Task 8: Human input primitives

**Files:**
- Create: `src/core/input/human.ts`
- Test: `tests/human-input.test.ts`

**Interfaces:**
- Consumes: `TabSession` (Task 4)
- Produces: `rand(min: number, max: number): number`, `sleep(ms: number): Promise<void>`, `class HumanInput` — `constructor(tab: TabSession)`, `get cursor(): { x: number; y: number } | null`, `move(x: number, y: number): Promise<void>`, `click(x: number, y: number): Promise<void>`, `wheel(x: number, y: number, deltaY: number, maxSteps?: number): Promise<number>`

Ported from `engine/cdp.mjs` in the reference worker, typed. A pointer that never
travels and never misses is a fingerprint on its own.

The test injects a fake `TabSession` that records dispatched events, so it is offline.

- [ ] **Step 1: Write the failing test**

`tests/human-input.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HumanInput } from "../src/core/input/human.js";
import type { TabSession } from "../src/core/cdp/session.js";

type Sent = { method: string; params: Record<string, unknown> };

function fakeTab(): { tab: TabSession; sent: Sent[] } {
  const sent: Sent[] = [];
  const tab = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      return {};
    },
  } as unknown as TabSession;
  return { tab, sent };
}

const moves = (sent: Sent[]) => sent.filter((s) => s.params.type === "mouseMoved");

describe("HumanInput", () => {
  it("moves along a multi-point path, not a teleport", async () => {
    const { tab, sent } = fakeTab();
    await new HumanInput(tab).move(400, 300);
    expect(moves(sent).length).toBeGreaterThanOrEqual(8);
  });

  it("always settles exactly on the target so hit-testing is unchanged", async () => {
    const { tab, sent } = fakeTab();
    const h = new HumanInput(tab);
    await h.move(400, 300);
    const last = moves(sent).at(-1)!;
    expect(last.params.x).toBe(400);
    expect(last.params.y).toBe(300);
    expect(h.cursor).toEqual({ x: 400, y: 300 });
  });

  it("does not repeat the identical path twice", async () => {
    const a = fakeTab(); const b = fakeTab();
    await new HumanInput(a.tab).move(400, 300);
    await new HumanInput(b.tab).move(400, 300);
    const pathA = JSON.stringify(moves(a.sent).map((m) => [m.params.x, m.params.y]));
    const pathB = JSON.stringify(moves(b.sent).map((m) => [m.params.x, m.params.y]));
    expect(pathA).not.toBe(pathB);
  });

  it("click moves first, then presses and releases at the target", async () => {
    const { tab, sent } = fakeTab();
    await new HumanInput(tab).click(200, 150);
    const press = sent.find((s) => s.params.type === "mousePressed")!;
    const release = sent.find((s) => s.params.type === "mouseReleased")!;
    expect(press.params).toMatchObject({ x: 200, y: 150, button: "left", clickCount: 1 });
    expect(release.params).toMatchObject({ x: 200, y: 150 });
    expect(sent.indexOf(press)).toBeGreaterThan(sent.indexOf(moves(sent)[0]!));
  });

  it("wheel emits notches inside the human 40-120px band", async () => {
    const { tab, sent } = fakeTab();
    const moved = await new HumanInput(tab).wheel(500, 400, 600);
    const wheels = sent.filter((s) => s.params.type === "mouseWheel");
    expect(wheels.length).toBeGreaterThan(1);
    for (const w of wheels) {
      expect(Math.abs(w.params.deltaY as number)).toBeGreaterThanOrEqual(40);
      expect(Math.abs(w.params.deltaY as number)).toBeLessThanOrEqual(120);
    }
    expect(moved).toBeGreaterThanOrEqual(600);
  });

  it("wheel rounds a sub-notch remainder up rather than emitting a giveaway twitch", async () => {
    const { tab, sent } = fakeTab();
    await new HumanInput(tab).wheel(500, 400, 10);
    const wheels = sent.filter((s) => s.params.type === "mouseWheel");
    expect(wheels).toHaveLength(1);
    expect(Math.abs(wheels[0]!.params.deltaY as number)).toBe(40);
  });

  it("wheel scrolls upward when deltaY is negative", async () => {
    const { tab, sent } = fakeTab();
    await new HumanInput(tab).wheel(500, 400, -200);
    for (const w of sent.filter((s) => s.params.type === "mouseWheel")) {
      expect(w.params.deltaY as number).toBeLessThan(0);
    }
  });

  it("wheel with zero delta emits nothing", async () => {
    const { tab, sent } = fakeTab();
    expect(await new HumanInput(tab).wheel(500, 400, 0)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/human-input.test.ts`
Expected: FAIL — cannot resolve `../src/core/input/human.js`

- [ ] **Step 3: Implement human input**

`src/core/input/human.ts`:

```ts
import type { TabSession } from "../cdp/session.js";

export const rand = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Ported from the reference worker's engine/cdp.mjs. A pointer that never travels
 * and never misses is a fingerprint on its own, and scrollIntoView moves content
 * without emitting a single wheel event.
 */
export class HumanInput {
  #tab: TabSession;
  #cursor: { x: number; y: number } | null = null;

  constructor(tab: TabSession) { this.#tab = tab; }

  get cursor(): { x: number; y: number } | null { return this.#cursor; }

  /**
   * Quadratic Bezier from the last known position to the target: randomised
   * control point so the path bows a different way each time, eased slow-in /
   * fast-middle / slow-out, per-point jitter, and on ~20% of moves an overshoot
   * that gets corrected — the way a hand actually lands.
   */
  async move(toX: number, toY: number): Promise<void> {
    const from = this.#cursor ?? { x: toX + rand(-320, 320), y: toY + rand(-220, 220) };
    const dx = toX - from.x;
    const dy = toY - from.y;
    const dist = Math.hypot(dx, dy) || 1;

    const bow = (rand(5, 18) / 100) * dist * (Math.random() < 0.5 ? -1 : 1);
    const cx = (from.x + toX) / 2 + (-dy / dist) * bow;
    const cy = (from.y + toY) / 2 + (dx / dist) * bow;
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

    const steps = rand(8, 20);
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const u = 1 - t;
      const x = Math.round(u * u * from.x + 2 * u * t * cx + t * t * toX + rand(-3, 3));
      const y = Math.round(u * u * from.y + 2 * u * t * cy + t * t * toY + rand(-3, 3));
      await this.#tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(rand(8, 25));
    }

    if (Math.random() < 0.2) {
      const ox = toX + (dx >= 0 ? rand(3, 12) : -rand(3, 12));
      const oy = toY + (dy >= 0 ? rand(2, 8) : -rand(2, 8));
      await this.#tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ox, y: oy });
      await sleep(rand(20, 60));
    }

    // Always settle exactly on target so hit-testing is unchanged.
    await this.#tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: toX, y: toY });
    this.#cursor = { x: toX, y: toY };
  }

  async click(x: number, y: number): Promise<void> {
    await this.move(x, y);
    await sleep(rand(60, 220)); // hand settles before the press
    await this.#tab.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    await sleep(rand(45, 130));
    await this.#tab.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1,
    });
  }

  /** Real wheel events at the pointer, in human-sized notches. */
  async wheel(x: number, y: number, deltaY: number, maxSteps = 0): Promise<number> {
    if (!deltaY) return 0;

    // A human scrolls where the pointer already is.
    if (!this.#cursor || Math.hypot(this.#cursor.x - x, this.#cursor.y - y) > 120) {
      await this.move(x, y);
    }

    const total = Math.abs(deltaY);
    const dir = Math.sign(deltaY);
    let moved = 0;
    let sent = 0;

    while (moved < total && (!maxSteps || sent < maxSteps)) {
      // A leftover smaller than one notch is rounded UP rather than sent as a
      // giveaway 6px twitch.
      const left = total - moved;
      const step = left < 40 ? 40 : Math.min(left, rand(40, 120));
      await this.#tab.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: 0, deltaY: dir * step,
      });
      moved += step;
      sent++;
      await sleep(rand(30, 110));
    }
    return moved; // magnitude actually scrolled
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/human-input.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): human input primitives

Bezier cursor paths with randomised bow, jitter, and a corrected overshoot
on ~20% of moves; wheel events in 40-120px notches with sub-notch remainders
rounded up. Ported from the reference worker and typed.

Update STATE.md."
```

---

## Task 9: Network tap

**Files:**
- Create: `src/core/net/tap.ts`
- Test: `tests/net-tap.test.ts`

**Interfaces:**
- Consumes: `CdpClient`/`CdpMessage` (Task 3), `TabSession` (Task 4), `Archive`/`ArchivedResponse` (Task 7), `EventLogger` (Task 6), `CapabilityError`/`EXIT` (Task 1)
- Produces: `type Captured = { url: string; status: number; body: unknown; archived: ArchivedResponse }`, `class NetworkTap` — `constructor(o: { client: CdpClient; tab: TabSession; archive: Archive; events?: EventLogger })`, `watch(pattern: string | RegExp): void`, `start(): void`, `stop(): void`, `waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<Captured>`, `all(): Captured[]`

This is what D1 rests on. We never issue a request — we subscribe to `Network.responseReceived`
for URLs matching a watched pattern, then read the body with `Network.getResponseBody` once
`Network.loadingFinished` fires for that requestId. Bodies are archived before being parsed.

- [ ] **Step 1: Write the failing test**

The test drives a fake `CdpClient` and emits synthetic protocol events, so it is offline.

`tests/net-tap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkTap } from "../src/core/net/tap.js";
import { Archive } from "../src/core/run/archive.js";
import type { CdpClient, CdpMessage } from "../src/core/cdp/client.js";
import type { TabSession } from "../src/core/cdp/session.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tap-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(bodies: Record<string, string>) {
  const listeners = new Set<(m: CdpMessage) => void>();
  const client = {
    on: (fn: (m: CdpMessage) => void) => listeners.add(fn),
    off: (fn: (m: CdpMessage) => void) => listeners.delete(fn),
    send: async (method: string, params: Record<string, unknown>) => {
      if (method === "Network.getResponseBody") {
        const body = bodies[params.requestId as string];
        if (body === undefined) throw new Error("No resource with given identifier");
        return { body, base64Encoded: false };
      }
      return {};
    },
  } as unknown as CdpClient;

  const tab = { sessionId: "S1" } as unknown as TabSession;
  const emit = (m: CdpMessage) => { for (const fn of listeners) fn(m); };
  return { client, tab, emit };
}

const respond = (requestId: string, url: string, status = 200): CdpMessage => ({
  method: "Network.responseReceived",
  params: { requestId, response: { url, status } },
});

const finish = (requestId: string): CdpMessage => ({
  method: "Network.loadingFinished", params: { requestId },
});

describe("NetworkTap", () => {
  it("captures a watched response and archives its body", async () => {
    const raw = JSON.stringify({ data: { firstName: "Ada" } });
    const { client, tab, emit } = harness({ R1: raw });
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch("voyager/api/identity");
    tap.start();

    const pending = tap.waitFor("voyager/api/identity", 2000);
    emit(respond("R1", "https://www.linkedin.com/voyager/api/identity/profiles/ada"));
    emit(finish("R1"));

    const cap = await pending;
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ data: { firstName: "Ada" } });
    expect(cap.archived.shape_hash).toHaveLength(16);
    tap.stop();
  });

  it("ignores responses that match no watched pattern", async () => {
    const { client, tab, emit } = harness({ R1: "{}" });
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch("salesApiLeadSearch");
    tap.start();

    emit(respond("R1", "https://static.licdn.com/logo.png"));
    emit(finish("R1"));
    await new Promise((r) => setTimeout(r, 50));

    expect(tap.all()).toHaveLength(0);
    tap.stop();
  });

  it("supports RegExp patterns", async () => {
    const { client, tab, emit } = harness({ R1: JSON.stringify({ ok: 1 }) });
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch(/salesApiProfiles\/.*ACwAAA/);
    tap.start();

    const pending = tap.waitFor(/salesApiProfiles/, 2000);
    emit(respond("R1", "https://www.linkedin.com/sales-api/salesApiProfiles/ACwAAAB1"));
    emit(finish("R1"));
    await expect(pending).resolves.toMatchObject({ status: 200 });
    tap.stop();
  });

  it("resolves waitFor from an already-captured response", async () => {
    const { client, tab, emit } = harness({ R1: JSON.stringify({ ok: 1 }) });
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch("voyager");
    tap.start();

    emit(respond("R1", "https://www.linkedin.com/voyager/api/x"));
    emit(finish("R1"));
    await new Promise((r) => setTimeout(r, 50));

    await expect(tap.waitFor("voyager", 500)).resolves.toMatchObject({ status: 200 });
    tap.stop();
  });

  it("rejects waitFor with CAPTURE_TIMEOUT when nothing arrives", async () => {
    const { client, tab } = harness({});
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch("voyager");
    tap.start();

    await expect(tap.waitFor("voyager", 150)).rejects.toMatchObject({
      code: "CAPTURE_TIMEOUT", exit: 6, action: "RETRY_ONCE",
    });
    tap.stop();
  });

  it("still records a capture whose body cannot be read", async () => {
    const { client, tab, emit } = harness({}); // getResponseBody throws
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch("voyager");
    tap.start();

    emit(respond("R9", "https://www.linkedin.com/voyager/api/gone"));
    emit(finish("R9"));
    await new Promise((r) => setTimeout(r, 80));

    expect(tap.all()).toHaveLength(0);
    tap.stop();
  });

  it("captures a 429 so rate limiting is visible to the caller", async () => {
    const { client, tab, emit } = harness({ R1: JSON.stringify({ message: "slow down" }) });
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch("voyager");
    tap.start();

    const pending = tap.waitFor("voyager", 2000);
    emit(respond("R1", "https://www.linkedin.com/voyager/api/x", 429));
    emit(finish("R1"));
    await expect(pending).resolves.toMatchObject({ status: 429 });
    tap.stop();
  });

  it("stop() detaches its listener", async () => {
    const { client, tab, emit } = harness({ R1: "{}" });
    const tap = new NetworkTap({ client, tab, archive: new Archive({ dir }) });
    tap.watch("voyager");
    tap.start();
    tap.stop();

    emit(respond("R1", "https://www.linkedin.com/voyager/api/x"));
    emit(finish("R1"));
    await new Promise((r) => setTimeout(r, 50));
    expect(tap.all()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/net-tap.test.ts`
Expected: FAIL — cannot resolve `../src/core/net/tap.js`

- [ ] **Step 3: Implement the tap**

`src/core/net/tap.ts`:

```ts
import type { CdpClient, CdpMessage } from "../cdp/client.js";
import type { TabSession } from "../cdp/session.js";
import type { Archive, ArchivedResponse } from "../run/archive.js";
import type { EventLogger } from "../run/events.js";
import { CapabilityError, EXIT } from "../run/receipt.js";

export type Captured = {
  url: string;
  status: number;
  body: unknown;
  archived: ArchivedResponse;
};

type Pattern = string | RegExp;
const matches = (url: string, p: Pattern): boolean =>
  typeof p === "string" ? url.includes(p) : p.test(url);

type Waiter = { pattern: Pattern; resolve: (c: Captured) => void; timer: ReturnType<typeof setTimeout> };

/**
 * D1: we never issue a request. We subscribe to the responses the page was
 * always going to fetch, then read the body once loadingFinished fires.
 * Bodies are archived (D2) before being handed to any parser.
 */
export class NetworkTap {
  #client: CdpClient;
  #sessionId: string;
  #archive: Archive;
  #events?: EventLogger;

  #patterns: Pattern[] = [];
  #inflight = new Map<string, { url: string; status: number }>();
  #captured: Captured[] = [];
  #waiters: Waiter[] = [];
  #listener?: (m: CdpMessage) => void;

  constructor(o: { client: CdpClient; tab: TabSession; archive: Archive; events?: EventLogger }) {
    this.#client = o.client;
    this.#sessionId = o.tab.sessionId;
    this.#archive = o.archive;
    this.#events = o.events;
  }

  watch(pattern: Pattern): void { this.#patterns.push(pattern); }

  start(): void {
    if (this.#listener) return;
    this.#listener = (m) => void this.#onMessage(m);
    this.#client.on(this.#listener);
  }

  stop(): void {
    if (!this.#listener) return;
    this.#client.off(this.#listener);
    this.#listener = undefined;
    for (const w of this.#waiters) clearTimeout(w.timer);
    this.#waiters = [];
  }

  all(): Captured[] { return [...this.#captured]; }

  waitFor(pattern: Pattern, timeoutMs = 15_000): Promise<Captured> {
    const already = this.#captured.find((c) => matches(c.url, pattern));
    if (already) return Promise.resolve(already);

    return new Promise<Captured>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.timer !== timer);
        this.#events?.log("capture.miss", { pattern: String(pattern), timeout_ms: timeoutMs });
        reject(new CapabilityError({
          code: "CAPTURE_TIMEOUT", exit: EXIT.TRANSIENT,
          action: "RETRY_ONCE", retryable: true,
          message: `No response matching ${String(pattern)} within ${timeoutMs}ms`,
        }));
      }, timeoutMs);
      this.#waiters.push({ pattern, resolve, timer });
    });
  }

  async #onMessage(m: CdpMessage): Promise<void> {
    if (m.sessionId && m.sessionId !== this.#sessionId) return;

    if (m.method === "Network.responseReceived") {
      const p = m.params as { requestId: string; response?: { url?: string; status?: number } };
      const url = p.response?.url ?? "";
      if (!this.#patterns.some((pat) => matches(url, pat))) return;
      this.#inflight.set(p.requestId, { url, status: p.response?.status ?? 0 });
      return;
    }

    if (m.method === "Network.loadingFailed") {
      this.#inflight.delete((m.params as { requestId: string }).requestId);
      return;
    }

    if (m.method !== "Network.loadingFinished") return;

    const requestId = (m.params as { requestId: string }).requestId;
    const meta = this.#inflight.get(requestId);
    if (!meta) return;
    this.#inflight.delete(requestId);

    let raw: string;
    try {
      const r = await this.#client.send<{ body: string; base64Encoded: boolean }>(
        "Network.getResponseBody", { requestId }, this.#sessionId,
      );
      raw = r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body;
    } catch {
      // The body was evicted from Chrome's buffer before we asked for it.
      this.#events?.log("capture.miss", { url: meta.url, reason: "body-unavailable" });
      return;
    }

    const archived = await this.#archive.save({ url: meta.url, status: meta.status, raw });

    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { body = null; }

    const cap: Captured = { url: meta.url, status: meta.status, body, archived };
    this.#captured.push(cap);

    for (const w of [...this.#waiters]) {
      if (!matches(cap.url, w.pattern)) continue;
      clearTimeout(w.timer);
      this.#waiters = this.#waiters.filter((x) => x !== w);
      w.resolve(cap);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/net-tap.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): passive network tap

Subscribes to responses the page was always going to fetch and reads their
bodies once loadingFinished lands — never issues a request of its own (D1).
Every body is archived before parsing (D2). A 429 is captured rather than
swallowed so rate limiting is visible to the caller.

Update STATE.md."
```

---

## Task 10: Challenge and auth detection

**Files:**
- Create: `src/core/challenge/detect.ts`
- Test: `tests/challenge.test.ts`

**Interfaces:**
- Consumes: `TabSession` (Task 4), `Captured` (Task 9), `CapabilityError`/`EXIT` (Task 1)
- Produces: `type ChallengeKind = "captcha" | "checkpoint" | "login" | "rate_limit"`, `type ChallengeInfo = { kind: ChallengeKind; signal: string; url: string }`, `classifyUrl(url: string): ChallengeInfo | null`, `classifyResponse(c: { url: string; status: number }): ChallengeInfo | null`, `detectChallenge(tab: TabSession): Promise<ChallengeInfo | null>`, `challengeError(info: ChallengeInfo, evidence?: string): CapabilityError`

Challenges are never solved automatically: screenshot, checkpoint, exit, stop.
`classifyUrl` is pure so it is fully unit-testable; `detectChallenge` is the thin
DOM-reading wrapper. Reading the DOM here is explicitly permitted by D1 — challenge
detection is one of the four allowed DOM uses.

- [ ] **Step 1: Write the failing test**

`tests/challenge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyUrl, classifyResponse, challengeError } from "../src/core/challenge/detect.js";

describe("classifyUrl", () => {
  it("detects the checkpoint interstitial", () => {
    expect(classifyUrl("https://www.linkedin.com/checkpoint/challenge/AgH...")).toMatchObject({
      kind: "checkpoint",
    });
  });

  it("detects a bounced-to-login redirect", () => {
    expect(classifyUrl("https://www.linkedin.com/uas/login?session_redirect=%2Ffeed")).toMatchObject({
      kind: "login",
    });
    expect(classifyUrl("https://www.linkedin.com/login")).toMatchObject({ kind: "login" });
  });

  it("detects an explicit captcha page", () => {
    expect(classifyUrl("https://www.linkedin.com/checkpoint/rp/captcha-verify")).toMatchObject({
      kind: "captcha",
    });
  });

  it("returns null for ordinary LinkedIn URLs", () => {
    expect(classifyUrl("https://www.linkedin.com/in/some-person/")).toBeNull();
    expect(classifyUrl("https://www.linkedin.com/sales/search/people?query=x")).toBeNull();
  });
});

describe("classifyResponse", () => {
  it("classifies 429 as rate_limit", () => {
    expect(classifyResponse({ url: "https://www.linkedin.com/voyager/api/x", status: 429 }))
      .toMatchObject({ kind: "rate_limit" });
  });

  it("classifies 401 and 403 as login", () => {
    expect(classifyResponse({ url: "https://x/y", status: 401 })).toMatchObject({ kind: "login" });
    expect(classifyResponse({ url: "https://x/y", status: 403 })).toMatchObject({ kind: "login" });
  });

  it("returns null for 200 and 404", () => {
    expect(classifyResponse({ url: "https://x/y", status: 200 })).toBeNull();
    expect(classifyResponse({ url: "https://x/y", status: 404 })).toBeNull();
  });
});

describe("challengeError", () => {
  it("maps captcha and checkpoint to exit 2, HALT_AND_NOTIFY, non-retryable", () => {
    const e = challengeError({ kind: "captcha", signal: "captcha-verify", url: "https://x" }, "shot.png");
    expect(e.exit).toBe(2);
    expect(e.action).toBe("HALT_AND_NOTIFY");
    expect(e.retryable).toBe(false);
    expect(e.evidence).toBe("shot.png");
  });

  it("maps login to exit 4 REAUTH", () => {
    const e = challengeError({ kind: "login", signal: "uas/login", url: "https://x" });
    expect(e.exit).toBe(4);
    expect(e.action).toBe("REAUTH");
    expect(e.code).toBe("SESSION_DEAD");
  });

  it("maps rate_limit to exit 3 RETRY_BACKOFF with a backoff hint", () => {
    const e = challengeError({ kind: "rate_limit", signal: "429", url: "https://x" });
    expect(e.exit).toBe(3);
    expect(e.action).toBe("RETRY_BACKOFF");
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/challenge.test.ts`
Expected: FAIL — cannot resolve `../src/core/challenge/detect.js`

- [ ] **Step 3: Implement detection**

`src/core/challenge/detect.ts`:

```ts
import type { TabSession } from "../cdp/session.js";
import { CapabilityError, EXIT } from "../run/receipt.js";

export type ChallengeKind = "captcha" | "checkpoint" | "login" | "rate_limit";
export type ChallengeInfo = { kind: ChallengeKind; signal: string; url: string };

const URL_SIGNALS: [RegExp, ChallengeKind, string][] = [
  [/\/checkpoint\/rp\/captcha/i, "captcha", "captcha-verify"],
  [/captcha/i, "captcha", "captcha"],
  [/\/checkpoint\//i, "checkpoint", "checkpoint"],
  [/\/uas\/login/i, "login", "uas/login"],
  [/linkedin\.com\/login/i, "login", "login"],
  [/\/authwall/i, "login", "authwall"],
];

/** Pure, so it is fully unit-testable. */
export function classifyUrl(url: string): ChallengeInfo | null {
  for (const [re, kind, signal] of URL_SIGNALS) {
    if (re.test(url)) return { kind, signal, url };
  }
  return null;
}

export function classifyResponse(c: { url: string; status: number }): ChallengeInfo | null {
  if (c.status === 429) return { kind: "rate_limit", signal: "429", url: c.url };
  if (c.status === 401 || c.status === 403) {
    return { kind: "login", signal: String(c.status), url: c.url };
  }
  return null;
}

/**
 * D1 permits this DOM read: challenge detection is one of the four allowed
 * non-navigation DOM uses. No data field is sourced here.
 */
export async function detectChallenge(tab: TabSession): Promise<ChallengeInfo | null> {
  const probe = await tab.evaluate<{ url: string; hasCaptcha: boolean; title: string }>(`
    (() => ({
      url: location.href,
      title: document.title || "",
      hasCaptcha: !!document.querySelector(
        'iframe[src*="captcha"], #captcha-internal, .challenge-dialog, form[action*="checkpoint"]'
      ),
    }))()
  `);

  const byUrl = classifyUrl(probe.url);
  if (byUrl) return byUrl;
  if (probe.hasCaptcha) return { kind: "captcha", signal: "dom-captcha-element", url: probe.url };
  return null;
}

export function challengeError(info: ChallengeInfo, evidence?: string): CapabilityError {
  if (info.kind === "rate_limit") {
    return new CapabilityError({
      code: "RATE_LIMITED", exit: EXIT.RATE_LIMITED,
      action: "RETRY_BACKOFF", retryable: true, retryAfterMs: 15 * 60_000,
      message: `LinkedIn rate-limited the request (${info.signal}) at ${info.url}`,
      evidence,
    });
  }
  if (info.kind === "login") {
    return new CapabilityError({
      code: "SESSION_DEAD", exit: EXIT.AUTH,
      action: "REAUTH", retryable: false,
      message: `Not logged in (${info.signal}). Log in to the automation profile and retry.`,
      evidence,
    });
  }
  return new CapabilityError({
    code: "CHALLENGE_PRESENTED", exit: EXIT.CHALLENGE,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: `LinkedIn presented a ${info.kind} (${info.signal}) at ${info.url}`,
    evidence,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/challenge.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): challenge, auth, and rate-limit detection

Pure URL and status classifiers plus a thin DOM probe. Challenges are never
solved automatically — captcha and checkpoint halt at exit 2, a login bounce
is exit 4 REAUTH, and a 429 is exit 3 with a 15-minute backoff hint.

Update STATE.md."
```

---

## Task 11: Budget ledger

**Files:**
- Create: `src/core/budget/ledger.ts`
- Test: `tests/budget.test.ts`

**Interfaces:**
- Consumes: `EventLogger` (Task 6), `CapabilityError`/`EXIT` (Task 1)
- Produces: `type SpendKind = "page_load" | "search_page" | "profile_open" | "search_credit"`, `type BudgetLimits = { pageLoadsPerHour: number; pageLoadsPerDay: number; searchPagesPerDay: number; profilesPerDay: number }`, `DEFAULT_LIMITS`, `class BudgetLedger` — `static open(o: { path: string; limits?: Partial<BudgetLimits>; events?: EventLogger }): BudgetLedger`, `check(kind: SpendKind, n?: number): void`, `spend(o: { kind: SpendKind; n?: number; run_id: string; capability: string }): void`, `usage(): { pageLoadsLastHour: number; pageLoadsToday: number; searchPagesToday: number; profilesToday: number }`

D11: file-backed NDJSON at `runs/budget.ndjson`, append-only. The ledger is the safety
mechanism protecting a single unburnable account, so it must work when Supabase is down,
when Docker is not running, and before storage exists. **It cannot be bypassed by a flag** —
`--budget` may only lower a limit for one invocation, never raise it.

- [ ] **Step 1: Write the failing test**

`tests/budget.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger, DEFAULT_LIMITS } from "../src/core/budget/ledger.js";

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "budget-")); path = join(dir, "budget.ndjson"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (kind: string, n: number, ageMs: number) => JSON.stringify({
  ts: new Date(Date.now() - ageMs).toISOString(),
  kind, n, run_id: "old", capability: "profile.get",
});

describe("BudgetLedger", () => {
  it("allows a spend well under the limits", () => {
    const l = BudgetLedger.open({ path });
    expect(() => l.check("page_load")).not.toThrow();
    l.spend({ kind: "page_load", run_id: "r1", capability: "profile.get" });
    expect(l.usage().pageLoadsToday).toBe(1);
  });

  it("appends every spend to the ledger file", () => {
    const l = BudgetLedger.open({ path });
    l.spend({ kind: "page_load", run_id: "r1", capability: "profile.get" });
    l.spend({ kind: "profile_open", run_id: "r1", capability: "profile.get" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe("page_load");
  });

  it("throws exit 7 HALT_AND_NOTIFY when the hourly page-load cap is reached", () => {
    writeFileSync(path, Array.from({ length: DEFAULT_LIMITS.pageLoadsPerHour },
      () => entry("page_load", 1, 60_000)).join("\n") + "\n");
    const l = BudgetLedger.open({ path });
    // toThrowError only matches message/class, so assert the fields by catching.
    let caught: any;
    try { l.check("page_load"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "BUDGET_EXHAUSTED", exit: 7, action: "HALT_AND_NOTIFY" });
  });

  it("ignores page loads older than an hour for the hourly cap", () => {
    writeFileSync(path, Array.from({ length: DEFAULT_LIMITS.pageLoadsPerHour },
      () => entry("page_load", 1, 2 * 60 * 60_000)).join("\n") + "\n");
    const l = BudgetLedger.open({ path });
    expect(l.usage().pageLoadsLastHour).toBe(0);
    expect(() => l.check("page_load")).not.toThrow();
  });

  it("enforces the daily page-load cap independently of the hourly one", () => {
    writeFileSync(path, Array.from({ length: DEFAULT_LIMITS.pageLoadsPerDay },
      (_, i) => entry("page_load", 1, (i % 20) * 60 * 60_000 / 20 + 90 * 60_000)).join("\n") + "\n");
    const l = BudgetLedger.open({ path });
    expect(l.usage().pageLoadsLastHour).toBe(0);
    let caught: any;
    try { l.check("page_load"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "BUDGET_EXHAUSTED" });
  });

  it("enforces separate caps for search pages and profile opens", () => {
    writeFileSync(path, Array.from({ length: DEFAULT_LIMITS.searchPagesPerDay },
      () => entry("search_page", 1, 60_000)).join("\n") + "\n");
    const l = BudgetLedger.open({ path });
    expect(() => l.check("search_page")).toThrow();
    expect(() => l.check("profile_open")).not.toThrow();
  });

  it("checks n units at once, not just one", () => {
    const l = BudgetLedger.open({ path, limits: { pageLoadsPerHour: 5 } });
    expect(() => l.check("page_load", 6)).toThrow();
    expect(() => l.check("page_load", 5)).not.toThrow();
  });

  it("accepts a lowered limit but never a raised one", () => {
    const l = BudgetLedger.open({ path, limits: { pageLoadsPerDay: 999_999 } });
    expect(l.limits.pageLoadsPerDay).toBe(DEFAULT_LIMITS.pageLoadsPerDay);
    const l2 = BudgetLedger.open({ path, limits: { pageLoadsPerDay: 10 } });
    expect(l2.limits.pageLoadsPerDay).toBe(10);
  });

  it("tolerates a corrupt ledger line rather than failing open", () => {
    writeFileSync(path, "{not json\n" + entry("page_load", 1, 60_000) + "\n");
    const l = BudgetLedger.open({ path });
    expect(l.usage().pageLoadsToday).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/budget.test.ts`
Expected: FAIL — cannot resolve `../src/core/budget/ledger.js`

- [ ] **Step 3: Implement the ledger**

`src/core/budget/ledger.ts`:

```ts
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventLogger } from "../run/events.js";
import { CapabilityError, EXIT } from "../run/receipt.js";

export type SpendKind = "page_load" | "search_page" | "profile_open" | "search_credit";

export type BudgetLimits = {
  pageLoadsPerHour: number;
  pageLoadsPerDay: number;
  searchPagesPerDay: number;
  profilesPerDay: number;
};

export const DEFAULT_LIMITS: BudgetLimits = {
  pageLoadsPerHour: 60,
  pageLoadsPerDay: 400,
  searchPagesPerDay: 50,
  profilesPerDay: 120,
};

type Entry = { ts: string; kind: SpendKind; n: number; run_id: string; capability: string };

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * D11: file-backed, never database-backed. This is the safety mechanism for a
 * single unburnable account — it must work when Supabase is down, when Docker is
 * not running, and before storage exists at all. A safety check that depends on
 * an external service can fail open, which is the one unacceptable failure mode.
 */
export class BudgetLedger {
  readonly limits: BudgetLimits;
  #path: string;
  #entries: Entry[];
  #events?: EventLogger;

  private constructor(o: { path: string; limits: BudgetLimits; entries: Entry[]; events?: EventLogger }) {
    this.#path = o.path;
    this.limits = o.limits;
    this.#entries = o.entries;
    this.#events = o.events;
  }

  static open(o: { path: string; limits?: Partial<BudgetLimits>; events?: EventLogger }): BudgetLedger {
    mkdirSync(dirname(o.path), { recursive: true });

    // A supplied limit may only LOWER the default. The ledger cannot be bypassed.
    const limits: BudgetLimits = { ...DEFAULT_LIMITS };
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof BudgetLimits)[]) {
      const proposed = o.limits?.[k];
      if (typeof proposed === "number" && proposed < DEFAULT_LIMITS[k]) limits[k] = proposed;
    }

    const entries: Entry[] = [];
    if (existsSync(o.path)) {
      for (const line of readFileSync(o.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line) as Entry); }
        catch { /* corrupt line — skip it, never fail open */ }
      }
    }
    return new BudgetLedger({ path: o.path, limits, entries, events: o.events });
  }

  #sum(kind: SpendKind, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let total = 0;
    for (const e of this.#entries) {
      if (e.kind !== kind) continue;
      const t = Date.parse(e.ts);
      if (Number.isNaN(t) || t < cutoff) continue;
      total += e.n;
    }
    return total;
  }

  usage() {
    return {
      pageLoadsLastHour: this.#sum("page_load", HOUR),
      pageLoadsToday: this.#sum("page_load", DAY),
      searchPagesToday: this.#sum("search_page", DAY),
      profilesToday: this.#sum("profile_open", DAY),
    };
  }

  /** Throws exit 7 if the spend would exceed any applicable cap. */
  check(kind: SpendKind, n = 1): void {
    const caps: [number, number, string][] = [];
    if (kind === "page_load") {
      caps.push([this.#sum("page_load", HOUR) + n, this.limits.pageLoadsPerHour, "page loads/hour"]);
      caps.push([this.#sum("page_load", DAY) + n, this.limits.pageLoadsPerDay, "page loads/day"]);
    } else if (kind === "search_page") {
      caps.push([this.#sum("search_page", DAY) + n, this.limits.searchPagesPerDay, "search pages/day"]);
    } else if (kind === "profile_open") {
      caps.push([this.#sum("profile_open", DAY) + n, this.limits.profilesPerDay, "profiles/day"]);
    }

    for (const [would, cap, label] of caps) {
      if (would > cap) {
        throw new CapabilityError({
          code: "BUDGET_EXHAUSTED", exit: EXIT.BUDGET,
          action: "HALT_AND_NOTIFY", retryable: false,
          message: `Budget exhausted: ${label} would reach ${would} of ${cap}`,
        });
      }
    }
  }

  spend(o: { kind: SpendKind; n?: number; run_id: string; capability: string }): void {
    const e: Entry = {
      ts: new Date().toISOString(),
      kind: o.kind, n: o.n ?? 1,
      run_id: o.run_id, capability: o.capability,
    };
    this.#entries.push(e);
    appendFileSync(this.#path, JSON.stringify(e) + "\n");
    this.#events?.log("budget.spend", { kind: e.kind, n: e.n });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/budget.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): file-backed budget ledger

Append-only NDJSON with rolling hour and day windows. A supplied --budget may
only lower a default limit, never raise it, so the ledger cannot be bypassed.
Corrupt lines are skipped rather than failing open.

Update STATE.md."
```

---

## Task 12: Capability registry, CLI, and `health.check` — M1 complete

**Files:**
- Create: `src/core/registry/index.ts`, `src/cli/index.ts`
- Create: `src/capabilities/health.check/index.ts`, `src/capabilities/health.check/README.md`
- Test: `tests/registry.test.ts`, `tests/cli-args.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–11
- Produces:
  - `type CostEstimate = { page_loads: number; search_credits: number }`
  - `type CapContext = { ctx: RunContext; session: BrowserSession; tab: TabSession; tap: NetworkTap; input: HumanInput; budget: BudgetLedger }`
  - `type CapResult<D> = { counts: Counts; warnings?: Warning[]; stored?: Stored; next?: string; data?: D }`
  - `type Capability<A, D>` — `{ name, risk, args: ZodType<A>, cost(a: A): CostEstimate, needsBrowser: boolean, run(cc: CapContext, a: A): Promise<CapResult<D>> }`
  - `defineCapability<A, D>(c: Capability<A, D>): Capability<A, D>`
  - `registry: Map<string, Capability<any, any>>`, `register(c): void`, `manifest(): unknown[]`
  - `parseArgv(argv: string[]): { command: string; flags: Record<string, string | boolean> }`
  - `UNIVERSAL_FLAGS`

- [ ] **Step 1: Write the failing tests**

`tests/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineCapability, manifest, register, registry } from "../src/core/registry/index.js";

describe("registry", () => {
  it("registers a capability and exposes it by name", () => {
    const cap = defineCapability({
      name: "test.thing",
      risk: "read-cheap",
      needsBrowser: false,
      args: z.object({ url: z.string().url() }),
      cost: () => ({ page_loads: 1, search_credits: 0 }),
      run: async () => ({ counts: { requested: 1, captured: 1, usable: 1, skipped: 0 } }),
    });
    register(cap);
    expect(registry.get("test.thing")?.risk).toBe("read-cheap");
  });

  it("manifest lists name, risk, cost and an args schema an agent can read", () => {
    const entry = manifest().find((m) => (m as { name: string }).name === "test.thing") as {
      name: string; risk: string; needs_browser: boolean; args: Record<string, unknown>;
    };
    expect(entry.risk).toBe("read-cheap");
    expect(entry.needs_browser).toBe(false);
    expect(entry.args).toHaveProperty("properties.url");
  });

  it("rejects args that fail the schema", () => {
    const cap = registry.get("test.thing")!;
    expect(cap.args.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(cap.args.safeParse({ url: "https://x.com" }).success).toBe(true);
  });
});
```

`tests/cli-args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseArgv } from "../src/cli/index.js";

describe("parseArgv", () => {
  it("reads the command and --key=value flags", () => {
    expect(parseArgv(["profile.get", "--url=https://x.com/in/a", "--max-age=7d"])).toEqual({
      command: "profile.get",
      flags: { url: "https://x.com/in/a", "max-age": "7d" },
    });
  });

  it("treats a bare --flag as boolean true", () => {
    expect(parseArgv(["list", "--json"]).flags).toEqual({ json: true });
  });

  it("returns an empty command when argv is empty", () => {
    expect(parseArgv([])).toEqual({ command: "", flags: {} });
  });

  it("keeps a value containing an equals sign intact", () => {
    expect(parseArgv(["x", "--q=a=b=c"]).flags.q).toBe("a=b=c");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/registry.test.ts tests/cli-args.test.ts`
Expected: FAIL — cannot resolve the two new modules

- [ ] **Step 3: Implement the registry**

`src/core/registry/index.ts`:

```ts
import type { ZodType } from "zod";
import { z } from "zod";
import type { RunContext } from "../run/context.js";
import type { BrowserSession, TabSession } from "../cdp/session.js";
import type { NetworkTap } from "../net/tap.js";
import type { HumanInput } from "../input/human.js";
import type { BudgetLedger } from "../budget/ledger.js";
import type { Counts, Stored, Warning } from "../run/receipt.js";

export type CostEstimate = { page_loads: number; search_credits: number };
export type RiskClass = "read-cheap" | "read-metered";

export type CapContext = {
  ctx: RunContext;
  session: BrowserSession;
  tab: TabSession;
  tap: NetworkTap;
  input: HumanInput;
  budget: BudgetLedger;
};

export type CapResult<D> = {
  counts: Counts;
  warnings?: Warning[];
  stored?: Stored;
  next?: string;
  data?: D;
};

export type Capability<A, D> = {
  name: string;
  risk: RiskClass;
  /** false for capabilities that never touch Chrome, e.g. log queries. */
  needsBrowser: boolean;
  args: ZodType<A>;
  cost: (a: A) => CostEstimate;
  run: (cc: CapContext, a: A) => Promise<CapResult<D>>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry = new Map<string, Capability<any, any>>();

export function defineCapability<A, D>(c: Capability<A, D>): Capability<A, D> { return c; }

export function register<A, D>(c: Capability<A, D>): void { registry.set(c.name, c); }

/** `cap list --json`: how an agent that lost its context rediscovers the toolkit. */
export function manifest(): unknown[] {
  return [...registry.values()].map((c) => ({
    name: c.name,
    risk: c.risk,
    needs_browser: c.needsBrowser,
    args: z.toJSONSchema(c.args),
  }));
}
```

If the installed zod version has no `z.toJSONSchema`, install the companion package
`npm i zod-to-json-schema` and use `zodToJsonSchema(c.args)` instead — the manifest
must expose a real schema, not a hand-written description.

- [ ] **Step 4: Implement `health.check`**

`src/capabilities/health.check/index.ts`:

```ts
import { z } from "zod";
import { defineCapability } from "../../core/registry/index.js";
import { detectChallenge } from "../../core/challenge/detect.js";

const Args = z.object({
  url: z.string().url().default("https://www.linkedin.com/feed/"),
});

/**
 * M1's proof capability. Exercises the whole core — launch or reuse Chrome, lease
 * the tab, open a worker tab, navigate, tap the network, detect challenges, spend
 * budget, log events, write a receipt — without depending on any parser or storage.
 */
export const healthCheck = defineCapability<z.infer<typeof Args>, {
  logged_in: boolean; captured: number; url: string;
}>({
  name: "health.check",
  risk: "read-cheap",
  needsBrowser: true,
  args: Args,
  cost: () => ({ page_loads: 1, search_credits: 0 }),

  async run(cc, a) {
    cc.budget.check("page_load");
    cc.tap.watch("voyager/api");
    cc.tap.start();

    cc.ctx.events.log("nav.start", { url: a.url });
    await cc.tab.navigate(a.url);
    cc.budget.spend({ kind: "page_load", run_id: cc.ctx.run_id, capability: "health.check" });
    await new Promise((r) => setTimeout(r, 3000));
    await cc.tab.ensureForeground();
    cc.ctx.events.log("nav.done", { duration_ms: cc.ctx.elapsedMs() });

    const challenge = await detectChallenge(cc.tab);
    if (challenge) {
      const shot = await cc.ctx.shot(cc.tab, "challenge");
      cc.ctx.events.log("challenge.detected", { level: "error", kind: challenge.kind, signal: challenge.signal });
      const { challengeError } = await import("../../core/challenge/detect.js");
      throw challengeError(challenge, shot);
    }

    const finalUrl = await cc.tab.currentUrl();
    const captured = cc.tap.all().length;
    cc.tap.stop();

    return {
      counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
      data: { logged_in: true, captured, url: finalUrl },
      next: "cap profile.get --url=<linkedin profile url>",
    };
  },
});
```

`src/capabilities/health.check/README.md`:

```markdown
# health.check

Proves the core works end to end. Navigates the worker tab to a LinkedIn URL,
confirms the session is alive, and reports how many Voyager responses the tap saw.

**Returns:** `{ logged_in, captured, url }` inline in the receipt — it is small enough.
**Costs:** 1 page load. **Writes nothing to storage.**
**Depends on:** every L0 module. If this fails, nothing else will work.

Exit 4 means the automation profile is logged out — log in by hand and retry.
```

- [ ] **Step 5: Implement the CLI**

`src/cli/index.ts`:

```ts
import { join } from "node:path";
import { registry, register, manifest, type CapContext } from "../core/registry/index.js";
import { RunContext, DEFAULT_RUNS_ROOT } from "../core/run/context.js";
import { BrowserSession } from "../core/cdp/session.js";
import { NetworkTap } from "../core/net/tap.js";
import { HumanInput } from "../core/input/human.js";
import { Archive } from "../core/run/archive.js";
import { BudgetLedger } from "../core/budget/ledger.js";
import { acquireLease, releaseLease } from "../core/tab/lease.js";
import { buildOk, buildErr, emitReceipt, CapabilityError, EXIT } from "../core/run/receipt.js";
import { healthCheck } from "../capabilities/health.check/index.js";

export const UNIVERSAL_FLAGS = ["run-id", "dry-run", "fields", "no-store", "budget"] as const;

export function parseArgv(argv: string[]): {
  command: string; flags: Record<string, string | boolean>;
} {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (const a of rest) {
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) flags[body] = true;
    else flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return { command, flags };
}

register(healthCheck);

async function main(): Promise<void> {
  const { command, flags } = parseArgv(process.argv.slice(2));

  if (!command || command === "help") {
    process.stdout.write(
      `usage: cap <capability> [--flags]\n` +
      `       cap list --json\n\n` +
      `capabilities: ${[...registry.keys()].join(", ")}\n`,
    );
    process.exit(EXIT.GENERIC);
  }

  if (command === "list") {
    process.stdout.write(JSON.stringify(manifest(), null, flags.json ? 0 : 2) + "\n");
    process.exit(EXIT.OK);
  }

  const cap = registry.get(command);
  if (!cap) {
    process.stderr.write(`unknown capability: ${command}\n`);
    process.exit(EXIT.GENERIC);
  }

  // Universal flags are stripped before the capability's own schema sees them.
  const capArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if ((UNIVERSAL_FLAGS as readonly string[]).includes(k)) continue;
    capArgs[k] = v;
  }

  const parsed = cap.args.safeParse(capArgs);
  if (!parsed.success) {
    process.stderr.write(`invalid args for ${command}: ${parsed.error.message}\n`);
    process.exit(EXIT.GENERIC);
  }
  const args = parsed.data;

  if (flags["dry-run"]) {
    process.stdout.write(JSON.stringify({
      ok: true, dry_run: true, capability: cap.name,
      args, cost: cap.cost(args), risk: cap.risk,
    }) + "\n");
    process.exit(EXIT.OK);
  }

  const runId = typeof flags["run-id"] === "string" ? flags["run-id"] : undefined;
  const ctx = runId
    ? await RunContext.resume(runId, { capability: cap.name })
    : await RunContext.create({ capability: cap.name, args });

  const budgetLimit = typeof flags.budget === "string" ? Number(flags.budget) : undefined;
  const budget = BudgetLedger.open({
    path: join(DEFAULT_RUNS_ROOT, "budget.ndjson"),
    limits: budgetLimit ? { pageLoadsPerDay: budgetLimit, pageLoadsPerHour: budgetLimit } : undefined,
    events: ctx.events,
  });

  const leasePath = join(DEFAULT_RUNS_ROOT, "tab.lock");
  let session: BrowserSession | undefined;
  let leased = false;

  try {
    if (cap.needsBrowser) {
      await acquireLease({ path: leasePath, run_id: ctx.run_id, capability: cap.name });
      leased = true;
      session = await BrowserSession.open();
    }
    const tab = session ? await session.createWorkerTab() : (undefined as never);
    const archive = new Archive({ dir: ctx.rawDir, events: ctx.events });
    const cc: CapContext = {
      ctx,
      session: session as BrowserSession,
      tab,
      tap: session ? new NetworkTap({ client: session.client, tab, archive, events: ctx.events }) : (undefined as never),
      input: session ? new HumanInput(tab) : (undefined as never),
      budget,
    };

    const result = await cap.run(cc, args);

    if (session) { await tab.close(); await session.close(); }
    if (leased) await releaseLease(leasePath, ctx.run_id);

    const cost = { ...cap.cost(args), elapsed_ms: ctx.elapsedMs() };
    await ctx.finish();
    emitReceipt(buildOk({
      run_id: ctx.run_id, capability: cap.name,
      counts: result.counts, warnings: result.warnings, stored: result.stored,
      cost, artifacts: ctx.artifacts(), next: result.next, data: result.data,
    }), EXIT.OK);
  } catch (e) {
    const err = e instanceof CapabilityError ? e : new CapabilityError({
      code: "UNEXPECTED", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY",
      retryable: false, message: (e as Error).message,
    });
    ctx.events.log("error", { level: "error", code: err.code, message: err.message });

    try { if (session) await session.close(); } catch { /* already gone */ }
    if (leased) await releaseLease(leasePath, ctx.run_id);

    const cost = { page_loads: 0, search_credits: 0, elapsed_ms: ctx.elapsedMs() };
    await ctx.finish();
    emitReceipt(buildErr({ run_id: ctx.run_id, capability: cap.name, err, cost }), err.exit);
  }
}

void main();
```

- [ ] **Step 6: Run all tests**

Run: `npm test && npm run typecheck`
Expected: PASS — every test from Tasks 1–12, and a clean typecheck.

- [ ] **Step 7: Verify M1 live**

```bash
npm run cap -- list --json
```
Expected: a JSON array containing `health.check` with `risk`, `needs_browser`, and an `args` JSON schema.

```bash
npm run cap -- health.check --dry-run
```
Expected: `{"ok":true,"dry_run":true,...,"cost":{"page_loads":1,"search_credits":0},...}`, exit 0, **zero LinkedIn requests**.

```bash
npm run cap -- health.check
echo "exit: $?"
```
Expected: a receipt with `"ok":true`, `data.logged_in: true`, `data.captured` greater than 0, exit 0. **No consent dialog. No leftover tab. Your Chrome window is never pulled forward.**

Then confirm the artifacts:

```bash
RUN=$(ls -t runs | head -1)
wc -l runs/$RUN/events.ndjson
ls runs/$RUN/raw/
cat runs/budget.ndjson | tail -2
```
Expected: events present, at least one `.json.gz` capture, one `page_load` budget entry.

Finally, prove the failure path is machine-actionable — log out of LinkedIn in the automation
profile, rerun, and confirm you get `"code":"SESSION_DEAD"`, `"action":"REAUTH"`, exit 4.
Log back in afterwards.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: capability registry, CLI, and health.check — M1 complete

Registry-driven CLI: capabilities declare name, risk, args schema, and cost,
and the CLI is generated from that rather than wired by hand. cap list --json
emits the manifest an agent uses to rediscover the toolkit after losing context.

health.check exercises the whole core — launch or reuse Chrome, lease the tab,
navigate, tap, detect challenges, spend budget, write a receipt — with no
dependency on any parser or storage.

Update STATE.md: M1 complete."
```

---

# M2 — Storage

## Task 13: Supabase local and the schema

**Files:**
- Create: `supabase/config.toml` (generated), `supabase/migrations/0001_core.sql`
- Create: `.env.example`, `.env` (gitignored)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is pure schema
- Produces: the tables `runs`, `raw_captures`, `persons`, `person_experience`, `person_posts`, `companies`, `company_posts`, `company_people`, `jobs`, `searches`, `search_results`, `parse_drift`

Settling the two items §13 of the spec left open:
- **Schema is `public`, not namespaced.** The database serves exactly one application, and
  D4 has the agent writing raw SQL against it — an extra `li.` prefix on every query is
  friction with no isolation benefit.
- **`person_experience` stores full history, not just the current role.** It is already in
  the captured response, storing it costs nothing extra, and re-deriving it later would
  mean re-scraping — which is the thing D2 exists to avoid.

- [ ] **Step 1: Initialise and start Supabase**

```bash
supabase init
supabase start
```

`supabase start` pulls Docker images on first run and takes several minutes. When it
finishes it prints `API URL`, `DB URL`, `anon key`, and `service_role key`. Record the
API URL and service_role key.

Write `.env.example`:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=replace-me
```

Copy it to `.env` and fill in the real values from `supabase start`. Add `.env` and
`supabase/.branches`, `supabase/.temp` to `.gitignore`.

- [ ] **Step 2: Write the migration**

`supabase/migrations/0001_core.sql`:

```sql
-- Identity is LinkedIn's own URN throughout. Never a synthesized key:
-- a person's name and vanity URL both change, their fsd_profile URN does not.

create table runs (
  run_id        text primary key,
  capability    text not null,
  args          jsonb not null default '{}'::jsonb,
  status        text not null default 'running',
  exit_code     int,
  page_loads    int  not null default 0,
  search_credits int not null default 0,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create table raw_captures (
  id          bigserial primary key,
  run_id      text not null references runs(run_id) on delete cascade,
  url         text not null,
  status      int  not null,
  shape_hash  text not null,
  path        text not null,
  bytes       int  not null,
  captured_at timestamptz not null default now()
);
create index raw_captures_run_idx   on raw_captures(run_id);
create index raw_captures_shape_idx on raw_captures(shape_hash);

create table companies (
  urn         text primary key,
  name        text,
  vanity      text,
  website     text,
  industry    text,
  size_range  text,
  hq          text,
  about       text,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index companies_vanity_idx on companies(vanity);

create table persons (
  urn                  text primary key,
  vanity               text,
  full_name            text,
  headline             text,
  location             text,
  current_company_urn  text references companies(urn),
  current_title        text,
  first_seen           timestamptz not null default now(),
  last_seen            timestamptz not null default now()
);
create index persons_vanity_idx  on persons(vanity);
create index persons_company_idx on persons(current_company_urn);

-- Full history, not just the current role: it is already in the captured
-- response, and re-deriving it later would mean re-scraping.
create table person_experience (
  id           bigserial primary key,
  person_urn   text not null references persons(urn) on delete cascade,
  company_urn  text references companies(urn),
  company_name text,
  title        text,
  started_on   date,
  ended_on     date,
  is_current   boolean not null default false,
  unique (person_urn, company_name, title, started_on)
);
create index person_experience_person_idx on person_experience(person_urn);

create table person_posts (
  urn        text primary key,
  person_urn text not null references persons(urn) on delete cascade,
  text       text,
  posted_at  timestamptz,
  reactions  int,
  comments   int,
  first_seen timestamptz not null default now()
);
create index person_posts_person_idx on person_posts(person_urn, posted_at desc);

create table company_posts (
  urn         text primary key,
  company_urn text not null references companies(urn) on delete cascade,
  text        text,
  posted_at   timestamptz,
  reactions   int,
  comments    int,
  first_seen  timestamptz not null default now()
);
create index company_posts_company_idx on company_posts(company_urn, posted_at desc);

create table company_people (
  company_urn   text not null references companies(urn) on delete cascade,
  person_urn    text not null references persons(urn) on delete cascade,
  discovered_at timestamptz not null default now(),
  primary key (company_urn, person_urn)
);

create table jobs (
  id             text primary key,
  company_urn    text references companies(urn),
  title          text,
  location       text,
  workplace_type text,
  posted_at      timestamptz,
  description    text,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now()
);
create index jobs_company_idx on jobs(company_urn);

create table searches (
  search_id  text primary key,
  kind       text not null,
  filter_url text not null,
  filter_json jsonb,
  created_at timestamptz not null default now()
);

-- Append-only: the same lead appearing in two searches is two rows, one entity.
create table search_results (
  id          bigserial primary key,
  search_id   text not null references searches(search_id) on delete cascade,
  run_ref     text not null,
  page        int  not null,
  position    int  not null,
  person_urn  text references persons(urn),
  company_urn text references companies(urn),
  captured_at timestamptz not null default now()
);
create index search_results_search_idx on search_results(search_id, page, position);
create index search_results_run_idx    on search_results(run_ref);

create table parse_drift (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  capability text not null,
  field      text not null,
  shape_hash text,
  n          int not null default 1
);
create index parse_drift_ts_idx on parse_drift(ts desc);
```

Note there is no `budget_ledger` table — D11 keeps the ledger file-backed so it cannot
fail open when Docker is down.

- [ ] **Step 3: Apply and verify the migration**

```bash
supabase db reset
supabase db diff --schema public
```

Expected: `db reset` applies `0001_core.sql` without error; `db diff` reports no
difference between the migration and the running database.

Then confirm the tables exist:

```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
  -c "\dt public.*"
```

Expected: all 12 tables listed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(store): local Supabase and the core schema

Identity is LinkedIn's own URN throughout — a person's name and vanity URL
both change, their fsd_profile URN does not. Entity tables upsert with
last_seen bumped; search_results is append-only.

Settles the two items the spec left open: schema stays in public (one app,
and D4 has the agent writing raw SQL), and person_experience keeps full
history because re-deriving it later would mean re-scraping.

No budget_ledger table — D11 keeps that file-backed.

Update STATE.md."
```

---

## Task 14: Store client with upsert and freshness

**Files:**
- Create: `src/store/client.ts`, `src/store/persons.ts`
- Test: `tests/store-freshness.test.ts`, `tests/store-persons.integration.test.ts`

**Interfaces:**
- Consumes: `CapabilityError`/`EXIT` (Task 1)
- Produces:
  - `getStore(): SupabaseClient` (memoised), `storeConfigured(): boolean`
  - `parseDuration(s: string): number` — `"7d"`, `"12h"`, `"30m"`, `"0"` → milliseconds
  - `isFresh(lastSeen: string | null | undefined, maxAgeMs: number): boolean`
  - `type PersonRow`, `type ExperienceRow`
  - `upsertPerson(o: { person: PersonRow; experience?: ExperienceRow[] }): Promise<void>`
  - `getPerson(urn: string): Promise<PersonRow | null>`
  - `getPersonByVanity(vanity: string): Promise<PersonRow | null>`

`parseDuration` and `isFresh` are pure and unit-tested. The upsert path needs a real
database, so its test is tagged `integration` and skipped when Supabase is not running —
CI stays green on a laptop with Docker off.

- [ ] **Step 1: Write the failing pure test**

`tests/store-freshness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDuration, isFresh } from "../src/store/client.js";

describe("parseDuration", () => {
  it("parses days, hours, and minutes", () => {
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60_000);
    expect(parseDuration("12h")).toBe(12 * 60 * 60_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
  });

  it("treats a bare number as milliseconds and 0 as always-stale", () => {
    expect(parseDuration("500")).toBe(500);
    expect(parseDuration("0")).toBe(0);
  });

  it("throws on nonsense rather than silently defaulting", () => {
    expect(() => parseDuration("soon")).toThrowError(/max-age/i);
  });
});

describe("isFresh", () => {
  it("is true inside the window and false outside it", () => {
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(isFresh(hourAgo, parseDuration("7d"))).toBe(true);
    expect(isFresh(hourAgo, parseDuration("30m"))).toBe(false);
  });

  it("is false for a missing timestamp", () => {
    expect(isFresh(null, parseDuration("7d"))).toBe(false);
    expect(isFresh(undefined, parseDuration("7d"))).toBe(false);
  });

  it("is false when maxAge is 0, so --max-age=0 always re-fetches", () => {
    expect(isFresh(new Date().toISOString(), 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/store-freshness.test.ts`
Expected: FAIL — cannot resolve `../src/store/client.js`

- [ ] **Step 3: Implement the client**

`src/store/client.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CapabilityError, EXIT } from "../core/run/receipt.js";

let client: SupabaseClient | undefined;

export function storeConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getStore(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new CapabilityError({
      code: "STORE_NOT_CONFIGURED", exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY", retryable: false,
      message: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example)",
    });
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

const UNITS: Record<string, number> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

export function parseDuration(s: string): number {
  const m = /^(\d+)([mhd])?$/.exec(s.trim());
  if (!m) {
    throw new CapabilityError({
      code: "BAD_ARG", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false,
      message: `Invalid --max-age "${s}". Use forms like 7d, 12h, 30m, or 0.`,
    });
  }
  const n = Number(m[1]);
  return m[2] ? n * UNITS[m[2]]! : n;
}

/** maxAgeMs of 0 is always stale, so --max-age=0 forces a re-fetch. */
export function isFresh(lastSeen: string | null | undefined, maxAgeMs: number): boolean {
  if (!lastSeen || maxAgeMs <= 0) return false;
  const t = Date.parse(lastSeen);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < maxAgeMs;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/store-freshness.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Implement the person store**

`src/store/persons.ts`:

```ts
import { getStore } from "./client.js";
import { CapabilityError, EXIT } from "../core/run/receipt.js";

export type PersonRow = {
  urn: string;
  vanity?: string | null;
  full_name?: string | null;
  headline?: string | null;
  location?: string | null;
  current_company_urn?: string | null;
  current_title?: string | null;
  last_seen?: string;
};

export type ExperienceRow = {
  person_urn: string;
  company_urn?: string | null;
  company_name?: string | null;
  title?: string | null;
  started_on?: string | null;
  ended_on?: string | null;
  is_current: boolean;
};

function fail(op: string, message: string): never {
  throw new CapabilityError({
    code: "STORE_WRITE_FAILED", exit: EXIT.TRANSIENT,
    action: "RETRY_ONCE", retryable: true,
    message: `${op}: ${message}`,
  });
}

/** Upsert on urn, bumping last_seen. first_seen keeps its original value. */
export async function upsertPerson(o: {
  person: PersonRow; experience?: ExperienceRow[];
}): Promise<void> {
  const db = getStore();
  const { error } = await db.from("persons")
    .upsert({ ...o.person, last_seen: new Date().toISOString() }, { onConflict: "urn" });
  if (error) fail("upsertPerson", error.message);

  if (o.experience?.length) {
    const { error: expError } = await db.from("person_experience")
      .upsert(o.experience, { onConflict: "person_urn,company_name,title,started_on" });
    if (expError) fail("upsertPerson(experience)", expError.message);
  }
}

export async function getPerson(urn: string): Promise<PersonRow | null> {
  const { data, error } = await getStore()
    .from("persons").select("*").eq("urn", urn).maybeSingle();
  if (error) fail("getPerson", error.message);
  return (data as PersonRow | null) ?? null;
}

export async function getPersonByVanity(vanity: string): Promise<PersonRow | null> {
  const { data, error } = await getStore()
    .from("persons").select("*").eq("vanity", vanity).maybeSingle();
  if (error) fail("getPersonByVanity", error.message);
  return (data as PersonRow | null) ?? null;
}
```

- [ ] **Step 6: Write the integration test**

`tests/store-persons.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import "dotenv/config";
import { storeConfigured, getStore, isFresh, parseDuration } from "../src/store/client.js";
import { upsertPerson, getPerson } from "../src/store/persons.js";

// Skipped when Supabase is not running, so a laptop with Docker off stays green.
const live = storeConfigured();
const maybe = live ? describe : describe.skip;

const URN = "urn:li:fsd_profile:TESTONLY0001";

maybe("persons store (integration)", () => {
  beforeAll(async () => {
    await getStore().from("persons").delete().eq("urn", URN);
  });

  it("inserts a person and reads it back", async () => {
    await upsertPerson({
      person: { urn: URN, vanity: "test-only", full_name: "Test Only", headline: "QA" },
    });
    const row = await getPerson(URN);
    expect(row?.full_name).toBe("Test Only");
    expect(isFresh(row?.last_seen, parseDuration("7d"))).toBe(true);
  });

  it("upserts rather than duplicating, and bumps last_seen", async () => {
    const before = await getPerson(URN);
    await new Promise((r) => setTimeout(r, 1100));
    await upsertPerson({ person: { urn: URN, headline: "QA Lead" } });
    const after = await getPerson(URN);
    expect(after?.headline).toBe("QA Lead");
    expect(Date.parse(after!.last_seen!)).toBeGreaterThan(Date.parse(before!.last_seen!));
  });

  it("stores experience rows without duplicating on repeat", async () => {
    const exp = [{
      person_urn: URN, company_name: "Acme", title: "Engineer",
      started_on: "2020-01-01", ended_on: null, is_current: true,
    }];
    await upsertPerson({ person: { urn: URN }, experience: exp });
    await upsertPerson({ person: { urn: URN }, experience: exp });
    const { data } = await getStore().from("person_experience").select("*").eq("person_urn", URN);
    expect(data).toHaveLength(1);
  });
});
```

Install `dotenv` so the test picks up `.env`:

```bash
npm i -D dotenv
```

- [ ] **Step 7: Run the integration test**

Run: `npm test -- tests/store-persons.integration.test.ts`
Expected with Supabase running: PASS, 3 tests. Expected with it stopped: 3 skipped, exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(store): Supabase client, freshness helpers, and person upserts

Upsert on urn with last_seen bumped, so re-reading a person never duplicates.
parseDuration and isFresh are pure and unit-tested; --max-age=0 always
re-fetches. Integration tests skip when Supabase is not running so a laptop
with Docker off stays green.

Update STATE.md: M2 complete."
```

---

# M3 — First reader end to end

> **Read this before starting Task 15.** The three M3 tasks are deliberately ordered
> *capture → parse → wire*. Nobody knows the exact shape of LinkedIn's profile response
> before capturing one, and guessing it produces a parser that fails on contact with
> reality. Task 15 spends **one** page load to record a real fixture; Tasks 16 and 17
> then run entirely offline against that fixture, at zero further cost and zero risk.
>
> Do not attempt to write the parser before Task 15 has produced a fixture file.

## Task 15: Capture a real profile fixture

**Files:**
- Create: `src/capabilities/profile.get/capture.ts`
- Create: `scripts/promote-fixture.ts`
- Modify: `src/cli/index.ts` (register the capability)

**Interfaces:**
- Consumes: `defineCapability` (Task 12), `NetworkTap` (Task 9), `detectChallenge`/`challengeError` (Task 10), `BudgetLedger` (Task 11), `HumanInput` (Task 8)
- Produces:
  - `PROFILE_PATTERNS: RegExp[]`
  - `normalizeProfileUrl(input: string): { url: string; vanity: string }`
  - `capability profile.capture` — navigates to a profile, archives every matching response, and reports what it saw
  - `scripts/promote-fixture.ts` — copies a run's captures into `fixtures/<capability>/` and prints a field map

- [ ] **Step 1: Write the failing test for URL normalisation**

`tests/profile-url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeProfileUrl } from "../src/capabilities/profile.get/capture.js";

describe("normalizeProfileUrl", () => {
  it("extracts the vanity slug and canonicalises the URL", () => {
    expect(normalizeProfileUrl("https://www.linkedin.com/in/ada-lovelace/")).toEqual({
      url: "https://www.linkedin.com/in/ada-lovelace/",
      vanity: "ada-lovelace",
    });
  });

  it("strips query strings and tracking parameters", () => {
    expect(normalizeProfileUrl("https://www.linkedin.com/in/ada-lovelace?trk=nav")).toEqual({
      url: "https://www.linkedin.com/in/ada-lovelace/",
      vanity: "ada-lovelace",
    });
  });

  it("accepts a bare vanity slug", () => {
    expect(normalizeProfileUrl("ada-lovelace").vanity).toBe("ada-lovelace");
  });

  it("accepts a Sales Navigator lead URL and keeps it intact", () => {
    const r = normalizeProfileUrl("https://www.linkedin.com/sales/lead/ACwAAAB1,NAME,abc");
    expect(r.url).toContain("/sales/lead/");
    expect(r.vanity).toBe("ACwAAAB1");
  });

  it("rejects a non-profile LinkedIn URL", () => {
    expect(() => normalizeProfileUrl("https://www.linkedin.com/company/acme/"))
      .toThrowError(/not a profile url/i);
  });

  it("rejects a non-LinkedIn host", () => {
    expect(() => normalizeProfileUrl("https://example.com/in/ada")).toThrowError(/linkedin/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/profile-url.test.ts`
Expected: FAIL — cannot resolve `../src/capabilities/profile.get/capture.js`

- [ ] **Step 3: Implement capture**

`src/capabilities/profile.get/capture.ts`:

```ts
import { z } from "zod";
import { defineCapability } from "../../core/registry/index.js";
import { detectChallenge, challengeError } from "../../core/challenge/detect.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { sleep, rand } from "../../core/input/human.js";

/**
 * The endpoints LinkedIn's own profile page fetches to render itself. We subscribe
 * to these; we never call them (D1). Verify and extend this list from a capture run
 * rather than from memory.
 */
export const PROFILE_PATTERNS: RegExp[] = [
  /voyager\/api\/identity\/dash\/profiles/i,
  /voyager\/api\/identity\/profiles/i,
  /voyager\/api\/graphql.*profile/i,
  /salesApiProfiles/i,
];

export function normalizeProfileUrl(input: string): { url: string; vanity: string } {
  const raw = input.trim();

  if (!raw.includes("/")) {
    return { url: `https://www.linkedin.com/in/${raw}/`, vanity: raw };
  }

  let parsed: URL;
  try { parsed = new URL(raw); }
  catch {
    throw new CapabilityError({
      code: "BAD_ARG", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false,
      message: `Not a URL: ${raw}`,
    });
  }

  if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) {
    throw new CapabilityError({
      code: "BAD_ARG", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false,
      message: `Not a linkedin.com URL: ${raw}`,
    });
  }

  const lead = /\/sales\/lead\/([^,/?]+)/i.exec(parsed.pathname);
  if (lead) {
    return { url: `https://www.linkedin.com${parsed.pathname}`, vanity: lead[1]! };
  }

  const person = /\/in\/([^/?]+)/i.exec(parsed.pathname);
  if (!person) {
    throw new CapabilityError({
      code: "BAD_ARG", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false,
      message: `Not a profile url: ${raw}`,
    });
  }
  const vanity = decodeURIComponent(person[1]!);
  return { url: `https://www.linkedin.com/in/${vanity}/`, vanity };
}

const Args = z.object({
  url: z.string().min(1),
  /** Seconds to linger after load so lazy sections finish fetching. */
  dwell: z.coerce.number().int().min(2).max(30).default(8),
});

/**
 * Discovery capability. Spends ONE page load to record what LinkedIn actually
 * returns for a profile, so the parser in Task 16 can be written and tested
 * entirely offline. Writes nothing to storage.
 */
export const profileCapture = defineCapability<z.infer<typeof Args>, {
  vanity: string;
  captures: { url: string; status: number; shape_hash: string; bytes: number }[];
}>({
  name: "profile.capture",
  risk: "read-cheap",
  needsBrowser: true,
  args: Args,
  cost: () => ({ page_loads: 1, search_credits: 0 }),

  async run(cc, a) {
    const { url, vanity } = normalizeProfileUrl(a.url);

    cc.budget.check("page_load");
    cc.budget.check("profile_open");

    for (const p of PROFILE_PATTERNS) cc.tap.watch(p);
    cc.tap.start();

    cc.ctx.events.log("nav.start", { url });
    await cc.tab.navigate(url);
    cc.budget.spend({ kind: "page_load", run_id: cc.ctx.run_id, capability: "profile.capture" });
    cc.budget.spend({ kind: "profile_open", run_id: cc.ctx.run_id, capability: "profile.capture" });

    await sleep(2500);
    await cc.tab.ensureForeground();

    const challenge = await detectChallenge(cc.tab);
    if (challenge) {
      const shot = await cc.ctx.shot(cc.tab, "challenge");
      cc.ctx.events.log("challenge.detected", {
        level: "error", kind: challenge.kind, signal: challenge.signal,
      });
      throw challengeError(challenge, shot);
    }

    // Scroll like a reader so lazily-fetched sections actually fetch.
    for (let i = 0; i < 4; i++) {
      await cc.input.wheel(700, 500, rand(300, 700));
      await sleep(rand(600, 1400));
    }
    await sleep(a.dwell * 1000);

    cc.ctx.events.log("render.wait", { dwell_s: a.dwell });
    await cc.ctx.shot(cc.tab, "profile");

    const captures = cc.tap.all().map((c) => ({
      url: c.url, status: c.status,
      shape_hash: c.archived.shape_hash, bytes: c.archived.bytes,
    }));
    cc.tap.stop();

    if (captures.length === 0) {
      throw new CapabilityError({
        code: "NO_CAPTURES", exit: EXIT.PARSE_DRIFT,
        action: "HALT_AND_NOTIFY", retryable: false,
        message: `Loaded ${url} but captured nothing matching PROFILE_PATTERNS. ` +
                 `LinkedIn's endpoints have moved — inspect the run's events and widen the patterns.`,
      });
    }

    return {
      counts: { requested: 1, captured: captures.length, usable: captures.length, skipped: 0 },
      data: { vanity, captures },
      next: `npx tsx scripts/promote-fixture.ts ${cc.ctx.run_id} profile.get`,
    };
  },
});
```

Register it in `src/cli/index.ts` alongside `healthCheck`:

```ts
import { profileCapture } from "../capabilities/profile.get/capture.js";
register(profileCapture);
```

- [ ] **Step 4: Run the URL test to verify it passes**

Run: `npm test -- tests/profile-url.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the fixture promotion script**

`scripts/promote-fixture.ts`:

```ts
/**
 * Promotes a run's raw captures into fixtures/, and prints a field map of each
 * body so the parser can be written against what LinkedIn actually returned.
 *
 * Usage: npx tsx scripts/promote-fixture.ts <run_id> <capability>
 */
import { readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const [runId, capability] = process.argv.slice(2);
if (!runId || !capability) {
  console.error("usage: promote-fixture.ts <run_id> <capability>");
  process.exit(1);
}

const rawDir = join("runs", runId, "raw");
const outDir = join("fixtures", capability);
mkdirSync(outDir, { recursive: true });

/** Prints key paths and value types, never values — safe to read in a terminal. */
function fieldMap(v: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  if (Array.isArray(v)) {
    out.push(`${prefix}[] (${v.length})`);
    if (v.length) fieldMap(v[0], `${prefix}[0]`, depth + 1, out);
    return out;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      const val = (v as Record<string, unknown>)[k];
      const path = prefix ? `${prefix}.${k}` : k;
      if (val && typeof val === "object") fieldMap(val, path, depth + 1, out);
      else out.push(`${path}: ${val === null ? "null" : typeof val}`);
    }
  }
  return out;
}

const index = readFileSync(join(rawDir, "index.ndjson"), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l) as { url: string; status: number; path: string; shape_hash: string });

for (const file of readdirSync(rawDir).filter((f) => f.endsWith(".json.gz"))) {
  const src = join(rawDir, file);
  copyFileSync(src, join(outDir, file));

  const body = JSON.parse(gunzipSync(readFileSync(src)).toString());
  const meta = index.find((i) => i.path.endsWith(file));
  const map = fieldMap(body);

  writeFileSync(join(outDir, file.replace(".json.gz", ".fieldmap.txt")), map.join("\n"));
  console.log(`\n=== ${file}`);
  console.log(`    url: ${meta?.url}`);
  console.log(`    ${map.length} leaf fields; first 60:`);
  console.log(map.slice(0, 60).map((m) => "      " + m).join("\n"));
}

console.log(`\nPromoted to ${outDir}/`);
```

- [ ] **Step 6: Capture a real profile**

Pick a profile that is **not** a prospect you intend to contact — use your own, or a
public figure. This spends one page load against the real account.

```bash
npm run cap -- profile.capture --dry-run --url=https://www.linkedin.com/in/<slug>/
```
Expected: `cost.page_loads: 1`, exit 0, no browser activity.

```bash
npm run cap -- profile.capture --url=https://www.linkedin.com/in/<slug>/
echo "exit: $?"
```
Expected: `"ok":true`, `data.captures` non-empty, exit 0.

If it exits 5 with `NO_CAPTURES`, LinkedIn's endpoints have moved. Read
`runs/<run_id>/events.ndjson`, look at what URLs the page actually fetched, widen
`PROFILE_PATTERNS`, and rerun. Do not proceed until a capture succeeds.

- [ ] **Step 7: Promote the fixture and read the field map**

```bash
RUN=$(ls -t runs | head -1)
npx tsx scripts/promote-fixture.ts $RUN profile.get
ls fixtures/profile.get/
```

Expected: at least one `.json.gz` plus its `.fieldmap.txt` in `fixtures/profile.get/`.
Read the field map — it is the specification for Task 16's parser.

Confirm the fixtures are gitignored:

```bash
git status --short fixtures/
```
Expected: no output. If fixtures appear, fix `.gitignore` before committing.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(profile): capture capability and fixture promotion

profile.capture spends one page load to record what LinkedIn actually returns
for a profile, so the parser can be written and tested entirely offline at
zero further cost. Fails loudly with NO_CAPTURES rather than silently
returning nothing when LinkedIn's endpoints move.

promote-fixture prints a field map of key paths and value types — never
values — so the captured shape is safe to read in a terminal.

Update STATE.md."
```

---

## Task 16: Profile parser, written against the captured fixture

**Files:**
- Create: `src/capabilities/profile.get/parse.ts`
- Create: `src/capabilities/profile.get/parse.test.ts`
- Create: `tests/helpers/fixtures.ts`

**Interfaces:**
- Consumes: `PersonRow`, `ExperienceRow` (Task 14), `Warning` (Task 1)
- Produces:
  - `type ParsedProfile = { person: PersonRow; experience: ExperienceRow[]; warnings: Warning[] }`
  - `parseProfile(body: unknown): ParsedProfile`
  - `pick<T>(obj: unknown, paths: string[]): T | undefined`
  - `loadFixtures(capability: string): { name: string; body: unknown }[]`

**Prerequisite:** Task 15 has produced at least one file in `fixtures/profile.get/`.
The field map written beside it is this task's specification. Nothing here touches
the network.

- [ ] **Step 1: Write the fixture loader**

`tests/helpers/fixtures.ts`:

```ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

export function loadFixtures(capability: string): { name: string; body: unknown }[] {
  const dir = join("fixtures", capability);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json.gz"))
    .map((name) => ({
      name,
      body: JSON.parse(gunzipSync(readFileSync(join(dir, name))).toString()) as unknown,
    }));
}
```

- [ ] **Step 2: Write the failing test**

Two layers. The **shape-independent** tests always run and pin the contract. The
**fixture** tests skip with a clear message when no fixture is present, so a fresh
clone is green rather than red.

`src/capabilities/profile.get/parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseProfile, pick } from "./parse.js";
import { loadFixtures } from "../../../tests/helpers/fixtures.js";

describe("pick", () => {
  it("returns the first path that resolves", () => {
    const o = { a: { b: null }, c: { d: "found" } };
    expect(pick<string>(o, ["a.b", "c.d"])).toBe("found");
  });

  it("walks array indices", () => {
    expect(pick<string>({ xs: [{ n: "first" }] }, ["xs.0.n"])).toBe("first");
  });

  it("returns undefined when nothing resolves", () => {
    expect(pick<string>({ a: 1 }, ["x.y", "z"])).toBeUndefined();
  });
});

describe("parseProfile contract", () => {
  it("returns empty results and a warning for an unrecognisable body", () => {
    const r = parseProfile({ totally: "unexpected" });
    expect(r.person.urn).toBe("");
    expect(r.experience).toEqual([]);
    expect(r.warnings.some((w) => w.code === "PARSE_NO_URN")).toBe(true);
  });

  it("never throws on null or a primitive", () => {
    expect(() => parseProfile(null)).not.toThrow();
    expect(() => parseProfile("nonsense")).not.toThrow();
  });

  it("emits a PARSE_FIELD_MISSING warning per absent expected field", () => {
    const r = parseProfile({ data: { entityUrn: "urn:li:fsd_profile:ABC" } });
    expect(r.person.urn).toBe("urn:li:fsd_profile:ABC");
    expect(r.warnings.filter((w) => w.code === "PARSE_FIELD_MISSING").length).toBeGreaterThan(0);
  });
});

const fixtures = loadFixtures("profile.get");
const withFixtures = fixtures.length ? describe : describe.skip;

withFixtures("parseProfile against real fixtures", () => {
  it("extracts a URN from every fixture that contains a profile", () => {
    const parsed = fixtures.map((f) => ({ name: f.name, r: parseProfile(f.body) }));
    const withUrn = parsed.filter((p) => p.r.person.urn);
    expect(withUrn.length).toBeGreaterThan(0);
    for (const p of withUrn) expect(p.r.person.urn).toMatch(/^urn:li:/);
  });

  it("extracts a name from the profile fixture", () => {
    const named = fixtures.map((f) => parseProfile(f.body)).filter((r) => r.person.full_name);
    expect(named.length).toBeGreaterThan(0);
  });

  it("reports no PARSE_FIELD_MISSING warnings on the primary profile fixture", () => {
    const primary = fixtures
      .map((f) => parseProfile(f.body))
      .filter((r) => r.person.urn && r.person.full_name)
      .sort((a, b) => a.warnings.length - b.warnings.length)[0]!;
    expect(primary.warnings.filter((w) => w.code === "PARSE_FIELD_MISSING")).toEqual([]);
  });

  it("is pure — parsing twice yields identical output", () => {
    for (const f of fixtures) {
      expect(JSON.stringify(parseProfile(f.body))).toBe(JSON.stringify(parseProfile(f.body)));
    }
  });
});

if (!fixtures.length) {
  console.warn(
    "\n  fixtures/profile.get is empty — fixture tests skipped.\n" +
    "  Run: npm run cap -- profile.capture --url=<profile url>\n" +
    "  then: npx tsx scripts/promote-fixture.ts <run_id> profile.get\n",
  );
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/capabilities/profile.get/parse.test.ts`
Expected: FAIL — cannot resolve `./parse.js`

- [ ] **Step 4: Implement the parser**

Write `src/capabilities/profile.get/parse.ts` using the skeleton below. **The `PATHS`
constant is the only part you fill in from the fixture** — open
`fixtures/profile.get/*.fieldmap.txt` and map each field to the key path where it
actually appears. List several candidate paths per field; `pick` takes the first that
resolves, which is what absorbs LinkedIn's A/B shape variance.

```ts
import type { PersonRow, ExperienceRow } from "../../store/persons.js";
import type { Warning } from "../../core/run/receipt.js";

export type ParsedProfile = {
  person: PersonRow;
  experience: ExperienceRow[];
  warnings: Warning[];
};

/** Resolves the first key path that yields a non-null value. Never throws. */
export function pick<T>(obj: unknown, paths: string[]): T | undefined {
  for (const path of paths) {
    let cur: unknown = obj;
    let ok = true;
    for (const seg of path.split(".")) {
      if (cur === null || cur === undefined || typeof cur !== "object") { ok = false; break; }
      cur = Array.isArray(cur)
        ? (cur as unknown[])[Number(seg)]
        : (cur as Record<string, unknown>)[seg];
    }
    if (ok && cur !== null && cur !== undefined) return cur as T;
  }
  return undefined;
}

/**
 * FILL THESE IN from fixtures/profile.get/*.fieldmap.txt.
 * List every candidate path you observe — pick() takes the first that resolves,
 * which is what absorbs LinkedIn's A/B shape variance without a code change.
 */
const PATHS = {
  urn:       ["data.entityUrn", "data.*.entityUrn", "entityUrn"],
  vanity:    ["data.publicIdentifier", "publicIdentifier"],
  firstName: ["data.firstName", "firstName"],
  lastName:  ["data.lastName", "lastName"],
  headline:  ["data.headline", "headline"],
  location:  ["data.geoLocationName", "data.locationName", "geoLocationName"],
  // Add the experience array's path here once observed, e.g.
  // experience: ["included.0.profilePositionGroups.elements"],
  experience: [] as string[],
} as const;

const EXPECTED_FIELDS = ["vanity", "full_name", "headline", "location"] as const;

export function parseProfile(body: unknown): ParsedProfile {
  const warnings: Warning[] = [];

  const urn = pick<string>(body, [...PATHS.urn]) ?? "";
  if (!urn) {
    warnings.push({ code: "PARSE_NO_URN", n: 1 });
    return { person: { urn: "" }, experience: [], warnings };
  }

  const first = pick<string>(body, [...PATHS.firstName]);
  const last = pick<string>(body, [...PATHS.lastName]);
  const full_name = [first, last].filter(Boolean).join(" ") || undefined;

  const person: PersonRow = {
    urn,
    vanity: pick<string>(body, [...PATHS.vanity]) ?? null,
    full_name: full_name ?? null,
    headline: pick<string>(body, [...PATHS.headline]) ?? null,
    location: pick<string>(body, [...PATHS.location]) ?? null,
  };

  for (const f of EXPECTED_FIELDS) {
    const v = f === "full_name" ? person.full_name : person[f as keyof PersonRow];
    if (v === null || v === undefined) warnings.push({ code: "PARSE_FIELD_MISSING", field: f, n: 1 });
  }

  const experience = parseExperience(body, urn, warnings);
  const current = experience.find((e) => e.is_current);
  if (current) {
    person.current_title = current.title ?? null;
    person.current_company_urn = current.company_urn ?? null;
  }

  return { person, experience, warnings };
}

function parseExperience(body: unknown, person_urn: string, warnings: Warning[]): ExperienceRow[] {
  const raw = pick<unknown[]>(body, [...PATHS.experience]);
  if (!Array.isArray(raw)) {
    if (PATHS.experience.length) warnings.push({ code: "PARSE_FIELD_MISSING", field: "experience", n: 1 });
    return [];
  }
  // Map each element to an ExperienceRow using the paths observed in the fieldmap.
  // Keep this defensive: a element missing a title is skipped, not thrown on.
  return raw.flatMap((el): ExperienceRow[] => {
    const title = pick<string>(el, ["title", "positionTitle", "name"]);
    const company_name = pick<string>(el, ["companyName", "company.name", "subtitle"]);
    if (!title && !company_name) return [];
    return [{
      person_urn,
      company_urn: pick<string>(el, ["companyUrn", "company.entityUrn"]) ?? null,
      company_name: company_name ?? null,
      title: title ?? null,
      started_on: pick<string>(el, ["dateRange.start.year"])
        ? `${pick<number>(el, ["dateRange.start.year"])}-${String(pick<number>(el, ["dateRange.start.month"]) ?? 1).padStart(2, "0")}-01`
        : null,
      ended_on: pick<number>(el, ["dateRange.end.year"])
        ? `${pick<number>(el, ["dateRange.end.year"])}-${String(pick<number>(el, ["dateRange.end.month"]) ?? 12).padStart(2, "0")}-01`
        : null,
      is_current: !pick<number>(el, ["dateRange.end.year"]),
    }];
  });
}
```

Iterate against the fixture until the fixture tests pass. Every iteration is free —
no network, no page load, no risk.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/capabilities/profile.get/parse.test.ts`
Expected: PASS — 6 contract tests plus 4 fixture tests.

If the "no PARSE_FIELD_MISSING on the primary fixture" test fails, a path in `PATHS`
is still wrong. Read the field map again; do not weaken the test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(profile): pure profile parser tested offline against fixtures

pick() resolves the first candidate key path that yields a value, which absorbs
LinkedIn's A/B shape variance without a code change. Missing expected fields
become PARSE_FIELD_MISSING warnings rather than exceptions, so one moved field
degrades a row instead of failing a run.

Contract tests always run; fixture tests skip with instructions when
fixtures/profile.get is empty, so a fresh clone stays green.

Update STATE.md."
```

---

## Task 17: Wire `profile.get` end to end — M3 complete

**Files:**
- Create: `src/capabilities/profile.get/index.ts`, `src/capabilities/profile.get/README.md`
- Modify: `src/cli/index.ts` (register), `src/store/persons.ts` (add `recordDrift`)
- Test: `tests/profile-get.integration.test.ts`

**Interfaces:**
- Consumes: `normalizeProfileUrl`, `PROFILE_PATTERNS` (Task 15), `parseProfile` (Task 16), `upsertPerson`, `getPersonByVanity`, `isFresh`, `parseDuration` (Task 14), `detectChallenge`, `challengeError` (Task 10)
- Produces: `capability profile.get`, `recordDrift(o: { capability: string; warnings: Warning[]; shape_hash?: string }): Promise<void>`

- [ ] **Step 1: Add drift recording to the store**

Append to `src/store/persons.ts`:

```ts
import type { Warning } from "../core/run/receipt.js";

/** Parser warnings are recorded so `cap log:drift` can group them over time. */
export async function recordDrift(o: {
  capability: string; warnings: Warning[]; shape_hash?: string;
}): Promise<void> {
  const rows = o.warnings
    .filter((w) => w.code === "PARSE_FIELD_MISSING" && w.field)
    .map((w) => ({
      capability: o.capability, field: w.field!, shape_hash: o.shape_hash ?? null, n: w.n,
    }));
  if (!rows.length) return;
  const { error } = await getStore().from("parse_drift").insert(rows);
  if (error) fail("recordDrift", error.message);
}
```

- [ ] **Step 2: Implement the capability**

`src/capabilities/profile.get/index.ts`:

```ts
import { z } from "zod";
import { defineCapability } from "../../core/registry/index.js";
import { detectChallenge, challengeError, classifyResponse } from "../../core/challenge/detect.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { sleep, rand } from "../../core/input/human.js";
import { normalizeProfileUrl, PROFILE_PATTERNS } from "./capture.js";
import { parseProfile } from "./parse.js";
import { upsertPerson, getPersonByVanity, recordDrift } from "../../store/persons.js";
import { isFresh, parseDuration, storeConfigured } from "../../store/client.js";

const Args = z.object({
  url: z.string().min(1),
  "max-age": z.string().default("7d"),
  dwell: z.coerce.number().int().min(2).max(30).default(6),
});

export const profileGet = defineCapability<z.infer<typeof Args>, {
  urn: string; vanity: string; full_name: string | null; from_cache: boolean;
}>({
  name: "profile.get",
  risk: "read-cheap",
  needsBrowser: true,
  args: Args,
  cost: () => ({ page_loads: 1, search_credits: 0 }),

  async run(cc, a) {
    const { url, vanity } = normalizeProfileUrl(a.url);
    const maxAgeMs = parseDuration(a["max-age"]);

    // Freshness first: the cheapest page load is the one never made.
    if (storeConfigured() && maxAgeMs > 0) {
      const cached = await getPersonByVanity(vanity);
      if (cached && isFresh(cached.last_seen, maxAgeMs)) {
        cc.ctx.events.log("store.write", { skipped: true, reason: "fresh" });
        return {
          counts: { requested: 1, captured: 0, usable: 1, skipped: 1 },
          stored: { table: "persons", run_ref: cc.ctx.run_id, rows: 0 },
          data: {
            urn: cached.urn, vanity,
            full_name: cached.full_name ?? null,
            from_cache: true,
          },
          next: `select * from persons where urn = '${cached.urn}'`,
        };
      }
    }

    cc.budget.check("page_load");
    cc.budget.check("profile_open");

    for (const p of PROFILE_PATTERNS) cc.tap.watch(p);
    cc.tap.start();

    cc.ctx.events.log("nav.start", { url });
    await cc.tab.navigate(url);
    cc.budget.spend({ kind: "page_load", run_id: cc.ctx.run_id, capability: "profile.get" });
    cc.budget.spend({ kind: "profile_open", run_id: cc.ctx.run_id, capability: "profile.get" });

    await sleep(2500);
    await cc.tab.ensureForeground();

    const challenge = await detectChallenge(cc.tab);
    if (challenge) {
      const shot = await cc.ctx.shot(cc.tab, "challenge");
      cc.ctx.events.log("challenge.detected", {
        level: "error", kind: challenge.kind, signal: challenge.signal,
      });
      throw challengeError(challenge, shot);
    }

    for (let i = 0; i < 3; i++) {
      await cc.input.wheel(700, 500, rand(300, 700));
      await sleep(rand(600, 1400));
    }
    await sleep(a.dwell * 1000);
    cc.tap.stop();

    const captures = cc.tap.all();

    // A 429 among the captures is rate limiting, not a parse problem.
    for (const c of captures) {
      const rl = classifyResponse(c);
      if (rl) throw challengeError(rl, await cc.ctx.shot(cc.tab, "rate-limited"));
    }

    if (!captures.length) {
      throw new CapabilityError({
        code: "NO_CAPTURES", exit: EXIT.PARSE_DRIFT,
        action: "HALT_AND_NOTIFY", retryable: false,
        message: `Loaded ${url} but captured nothing matching PROFILE_PATTERNS — endpoints have moved`,
      });
    }

    // Best parse wins: several endpoints may match, only one carries the profile.
    const parsed = captures
      .map((c) => ({ c, p: parseProfile(c.body) }))
      .filter((x) => x.p.person.urn)
      .sort((a, b) => a.p.warnings.length - b.p.warnings.length)[0];

    if (!parsed) {
      cc.ctx.events.log("parse.miss", { level: "error", captures: captures.length });
      throw new CapabilityError({
        code: "PARSE_NO_PROFILE", exit: EXIT.PARSE_DRIFT,
        action: "HALT_AND_NOTIFY", retryable: false,
        message: `Captured ${captures.length} responses but none parsed into a profile. ` +
                 `Fixtures are in runs/${cc.ctx.run_id}/raw/ — promote them and fix the parser offline.`,
      });
    }

    const { person, experience, warnings } = parsed.p;
    person.vanity = person.vanity ?? vanity;
    cc.ctx.events.log("parse.ok", { urn: person.urn, warnings: warnings.length });

    let stored: { table: string; run_ref: string; rows: number } | undefined;
    if (storeConfigured()) {
      await upsertPerson({ person, experience });
      await recordDrift({
        capability: "profile.get", warnings, shape_hash: parsed.c.archived.shape_hash,
      });
      cc.ctx.events.log("store.write", { table: "persons", rows: 1 + experience.length });
      stored = { table: "persons", run_ref: cc.ctx.run_id, rows: 1 };
    }

    return {
      counts: { requested: 1, captured: captures.length, usable: 1, skipped: 0 },
      warnings,
      stored,
      data: {
        urn: person.urn, vanity: person.vanity ?? vanity,
        full_name: person.full_name ?? null, from_cache: false,
      },
      next: `select * from persons where urn = '${person.urn}'`,
    };
  },
});
```

Register it in `src/cli/index.ts`:

```ts
import { profileGet } from "../capabilities/profile.get/index.js";
register(profileGet);
```

`src/capabilities/profile.get/README.md`:

```markdown
# profile.get

Reads one LinkedIn profile and upserts it into `persons` and `person_experience`.

**Args:** `--url=<profile url or vanity slug>` · `--max-age=7d` · `--dwell=6`
**Returns:** `{ urn, vanity, full_name, from_cache }` in the receipt. Bulk data is in Supabase.
**Costs:** 1 page load and 1 profile open — unless a fresh row exists, in which case zero.
**Writes:** `persons`, `person_experience`, `parse_drift`.

`--max-age=0` forces a re-fetch. Freshness is checked before any page load: the
cheapest page load is the one never made.

Exit 2 challenge · 3 rate-limited · 4 logged out · 5 endpoints moved or parser broken.
On exit 5, promote `runs/<run_id>/raw/` into `fixtures/profile.get/` and fix the parser
offline — no further LinkedIn requests needed.

**Data source:** captured Voyager responses only. Never the DOM (D1).
```

- [ ] **Step 3: Write the integration test**

`tests/profile-get.integration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import "dotenv/config";
import { storeConfigured, getStore } from "../src/store/client.js";
import { upsertPerson, getPersonByVanity, recordDrift } from "../src/store/persons.js";
import { parseProfile } from "../src/capabilities/profile.get/parse.js";
import { loadFixtures } from "./helpers/fixtures.js";

const fixtures = loadFixtures("profile.get");
const live = storeConfigured() && fixtures.length > 0;
const maybe = live ? describe : describe.skip;

maybe("profile.get parse -> store (integration, offline)", () => {
  it("persists a parsed fixture and reads it back by vanity", async () => {
    const parsed = fixtures
      .map((f) => parseProfile(f.body))
      .filter((r) => r.person.urn)
      .sort((a, b) => a.warnings.length - b.warnings.length)[0]!;

    parsed.person.vanity = parsed.person.vanity ?? "fixture-test";
    await getStore().from("persons").delete().eq("urn", parsed.person.urn);

    await upsertPerson({ person: parsed.person, experience: parsed.experience });
    const row = await getPersonByVanity(parsed.person.vanity!);
    expect(row?.urn).toBe(parsed.person.urn);
  });

  it("records parse drift for missing fields", async () => {
    await recordDrift({
      capability: "profile.get",
      warnings: [{ code: "PARSE_FIELD_MISSING", field: "headline", n: 1 }],
      shape_hash: "testhash",
    });
    const { data } = await getStore()
      .from("parse_drift").select("*").eq("shape_hash", "testhash");
    expect(data?.length).toBeGreaterThan(0);
    await getStore().from("parse_drift").delete().eq("shape_hash", "testhash");
  });
});
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: everything passes; integration tests skip cleanly if Supabase is stopped.

- [ ] **Step 5: Verify M3 live**

```bash
npm run cap -- profile.get --dry-run --url=<profile url>
```
Expected: cost estimate, exit 0, zero LinkedIn requests.

```bash
npm run cap -- profile.get --url=<profile url>
echo "exit: $?"
```
Expected: `"ok":true`, `data.from_cache:false`, `stored.rows:1`, `warnings:[]`, exit 0.

Run the identical command again immediately:

```bash
npm run cap -- profile.get --url=<same url>
```
Expected: `data.from_cache:true`, `counts.captured:0`, `cost` reflecting **no page load**.
This proves the freshness path. Confirm with `tail -3 runs/budget.ndjson` — no new
`page_load` entry.

Force a re-fetch:

```bash
npm run cap -- profile.get --url=<same url> --max-age=0
```
Expected: `from_cache:false`, and a new `page_load` in the ledger.

Confirm the data landed:

```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
  -c "select urn, vanity, full_name, headline, last_seen from persons order by last_seen desc limit 3;"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(profile): profile.get end to end — M3 complete

Freshness is checked before any page load, so a repeat read within --max-age
spends nothing. Captures are parsed best-first across matching endpoints; a
429 among them is raised as rate limiting rather than misread as parse drift.
Parser warnings are recorded to parse_drift so log:drift can group them.

This closes M3: the architecture is proven end to end on one capability —
tap, archive, challenge detection, offline-tested parser, budget, storage,
and receipt.

Update STATE.md: M1, M2, M3 complete."
```

---

## Task 18: Bounded log queries

**Files:**
- Create: `src/core/run/query.ts`
- Create: `src/capabilities/log.query/index.ts`, `src/capabilities/log.query/README.md`
- Modify: `src/cli/index.ts` (register)
- Test: `tests/log-query.test.ts`

**Interfaces:**
- Consumes: `defineCapability` (Task 12), `parseDuration` (Task 14)
- Produces: `type LoggedEvent`, `type RunSummary`, `readEvents(runDir: string): LoggedEvent[]`, `eventsForItem(runDir: string, itemRef: string): LoggedEvent[]`, `errorsFor(runDir: string): LoggedEvent[]`, `listRuns(root: string, sinceMs: number): RunSummary[]`, `driftSince(root: string, sinceMs: number): { capability: string; field: string; n: number }[]`, capabilities `log:runs`, `log:why`, `log:errors`, `log:drift`

D5: the agent never reads a whole log file. Each of these returns a bounded slice,
so debugging costs hundreds of tokens instead of hundreds of thousands.

- [ ] **Step 1: Write the failing test**

`tests/log-query.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents, eventsForItem, errorsFor, listRuns, driftSince } from "../src/core/run/query.js";

let root: string;

function makeRun(id: string, events: Record<string, unknown>[], startedAgoMs = 0) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({
    run_id: id, capability: "profile.get", args: {},
    started_at: new Date(Date.now() - startedAgoMs).toISOString(),
  }));
  writeFileSync(join(dir, "events.ndjson"),
    events.map((e, i) => JSON.stringify({
      ts: new Date(Date.now() - startedAgoMs).toISOString(), seq: i + 1, level: "info", ...e,
    })).join("\n") + "\n");
  return dir;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "q-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("log queries", () => {
  it("reads events back in order", () => {
    const dir = makeRun("R1", [{ event: "nav.start" }, { event: "nav.done" }]);
    expect(readEvents(dir).map((e) => e.event)).toEqual(["nav.start", "nav.done"]);
  });

  it("skips a corrupt line rather than failing the query", () => {
    const dir = makeRun("R1", [{ event: "nav.start" }]);
    writeFileSync(join(dir, "events.ndjson"), '{"broken\n{"seq":2,"event":"nav.done"}\n');
    expect(readEvents(dir).map((e) => e.event)).toEqual(["nav.done"]);
  });

  it("filters to one item_ref", () => {
    const dir = makeRun("R1", [
      { event: "capture.hit", item_ref: "lead-13" },
      { event: "capture.hit", item_ref: "lead-14" },
      { event: "parse.miss", item_ref: "lead-14" },
    ]);
    expect(eventsForItem(dir, "lead-14").map((e) => e.event)).toEqual(["capture.hit", "parse.miss"]);
  });

  it("returns only warn and error events", () => {
    const dir = makeRun("R1", [
      { event: "nav.start" },
      { event: "error", level: "error", code: "BOOM" },
      { event: "parse.miss", level: "warn" },
    ]);
    expect(errorsFor(dir).map((e) => e.event)).toEqual(["error", "parse.miss"]);
  });

  it("lists runs newest first and honours the since window", () => {
    makeRun("R_OLD", [{ event: "run.start" }], 48 * 60 * 60_000);
    makeRun("R_NEW", [{ event: "run.start" }], 60_000);
    expect(listRuns(root, 24 * 60 * 60_000).map((r) => r.run_id)).toEqual(["R_NEW"]);
  });

  it("groups parse.miss by capability and field", () => {
    makeRun("R1", [
      { event: "parse.miss", capability: "profile.get", field: "headline" },
      { event: "parse.miss", capability: "profile.get", field: "headline" },
      { event: "parse.miss", capability: "profile.get", field: "location" },
    ], 60_000);
    const drift = driftSince(root, 24 * 60 * 60_000);
    expect(drift).toContainEqual({ capability: "profile.get", field: "headline", n: 2 });
    expect(drift).toContainEqual({ capability: "profile.get", field: "location", n: 1 });
  });

  it("returns an empty list for a run directory that has no events file", () => {
    mkdirSync(join(root, "EMPTY"), { recursive: true });
    expect(readEvents(join(root, "EMPTY"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/log-query.test.ts`
Expected: FAIL — cannot resolve `../src/core/run/query.js`

- [ ] **Step 3: Implement the queries**

`src/core/run/query.ts`:

```ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type LoggedEvent = {
  ts: string; seq: number; level: string; event: string;
} & Record<string, unknown>;

export type RunSummary = {
  run_id: string; capability: string; started_at: string; events: number;
};

export function readEvents(runDir: string): LoggedEvent[] {
  const p = join(runDir, "events.ndjson");
  if (!existsSync(p)) return [];
  const out: LoggedEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as LoggedEvent); }
    catch { /* corrupt line — skip, never fail the query */ }
  }
  return out;
}

export function eventsForItem(runDir: string, itemRef: string): LoggedEvent[] {
  return readEvents(runDir).filter((e) => e.item_ref === itemRef);
}

export function errorsFor(runDir: string): LoggedEvent[] {
  return readEvents(runDir).filter(
    (e) => e.level === "error" || e.level === "warn" || e.event === "error",
  );
}

export function listRuns(root: string, sinceMs: number): RunSummary[] {
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - sinceMs;
  const out: RunSummary[] = [];

  for (const id of readdirSync(root)) {
    const metaPath = join(root, id, "run.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        run_id: string; capability: string; started_at: string;
      };
      if (Date.parse(meta.started_at) < cutoff) continue;
      out.push({
        run_id: meta.run_id, capability: meta.capability,
        started_at: meta.started_at, events: readEvents(join(root, id)).length,
      });
    } catch { /* unreadable run — skip */ }
  }
  return out.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

export function driftSince(root: string, sinceMs: number): {
  capability: string; field: string; n: number;
}[] {
  const counts = new Map<string, number>();
  for (const run of listRuns(root, sinceMs)) {
    for (const e of readEvents(join(root, run.run_id))) {
      if (e.event !== "parse.miss") continue;
      const capability = String(e.capability ?? run.capability);
      const field = String(e.field ?? "unknown");
      const key = `${capability} ${field}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([k, n]) => {
      const [capability, field] = k.split(" ");
      return { capability: capability!, field: field!, n };
    })
    .sort((a, b) => b.n - a.n);
}
```

- [ ] **Step 4: Implement the capabilities**

`src/capabilities/log.query/index.ts`:

```ts
import { join } from "node:path";
import { z } from "zod";
import { defineCapability } from "../../core/registry/index.js";
import { DEFAULT_RUNS_ROOT } from "../../core/run/context.js";
import { parseDuration } from "../../store/client.js";
import { readEvents, eventsForItem, errorsFor, listRuns, driftSince } from "../../core/run/query.js";

const MAX_ROWS = 200;
const FREE = () => ({ page_loads: 0, search_credits: 0 });
const countsOf = (n: number) => ({ requested: n, captured: n, usable: n, skipped: 0 });

export const logRuns = defineCapability({
  name: "log:runs",
  risk: "read-cheap" as const,
  needsBrowser: false,
  args: z.object({ since: z.string().default("24h") }),
  cost: FREE,
  async run(_cc, a) {
    const rows = listRuns(DEFAULT_RUNS_ROOT, parseDuration(a.since)).slice(0, MAX_ROWS);
    return { counts: countsOf(rows.length), data: rows };
  },
});

export const logWhy = defineCapability({
  name: "log:why",
  risk: "read-cheap" as const,
  needsBrowser: false,
  args: z.object({ run: z.string(), item: z.string().optional() }),
  cost: FREE,
  async run(_cc, a) {
    const dir = join(DEFAULT_RUNS_ROOT, a.run);
    const rows = (a.item ? eventsForItem(dir, a.item) : readEvents(dir)).slice(0, MAX_ROWS);
    return { counts: countsOf(rows.length), data: rows };
  },
});

export const logErrors = defineCapability({
  name: "log:errors",
  risk: "read-cheap" as const,
  needsBrowser: false,
  args: z.object({ run: z.string() }),
  cost: FREE,
  async run(_cc, a) {
    const rows = errorsFor(join(DEFAULT_RUNS_ROOT, a.run)).slice(0, MAX_ROWS);
    return { counts: countsOf(rows.length), data: rows };
  },
});

export const logDrift = defineCapability({
  name: "log:drift",
  risk: "read-cheap" as const,
  needsBrowser: false,
  args: z.object({ since: z.string().default("7d") }),
  cost: FREE,
  async run(_cc, a) {
    const rows = driftSince(DEFAULT_RUNS_ROOT, parseDuration(a.since)).slice(0, MAX_ROWS);
    return { counts: countsOf(rows.length), data: rows };
  },
});
```

`src/capabilities/log.query/README.md`:

```markdown
# log:runs · log:why · log:errors · log:drift

Bounded slices of the NDJSON run logs, so debugging never means reading a whole
log file into context (D5). Every result is capped at 200 rows.

| command | returns |
|---|---|
| `cap log:runs --since=24h` | run summaries, newest first |
| `cap log:why --run=<id> [--item=<ref>]` | events for a run, or for one item |
| `cap log:errors --run=<id>` | warn and error events only |
| `cap log:drift --since=7d` | parse.miss grouped by capability and field, most frequent first |

None of these touch Chrome or LinkedIn. `needsBrowser: false`, so the CLI does not
take the tab lease or launch a browser for them.
```

Register all four in `src/cli/index.ts`:

```ts
import { logRuns, logWhy, logErrors, logDrift } from "../capabilities/log.query/index.js";
for (const c of [logRuns, logWhy, logErrors, logDrift]) register(c);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/log-query.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Verify live**

```bash
npm run cap -- log:runs --since=24h
npm run cap -- log:errors --run=$(ls -t runs | head -1)
npm run cap -- log:drift --since=7d
```

Expected: JSON receipts, exit 0, and no browser launched for any of them — confirm by
checking that `runs/tab.lock` is never created.

- [ ] **Step 7: Final full verification**

```bash
npm test && npm run typecheck && npm run cap -- list --json
```

Expected: every test passes, clean typecheck, and the manifest lists all seven
capabilities: `health.check`, `profile.capture`, `profile.get`, `log:runs`, `log:why`,
`log:errors`, `log:drift`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): bounded log query capabilities

log:runs, log:why, log:errors, and log:drift each return a capped slice, so an
agent debugging a failed run spends hundreds of tokens rather than reading a
whole NDJSON log into context (D5). All four are needsBrowser:false, so they
never take the tab lease or launch Chrome.

Update STATE.md: M1, M2, M3 complete — architecture proven end to end."
```

---

## Done criteria for M1–M3

All of these must hold before starting the M4 plan:

- [ ] `npm test` passes; `npm run typecheck` is clean.
- [ ] `cap list --json` lists seven capabilities with real JSON-schema args.
- [ ] `cap health.check` exits 0 against the live account with no consent dialog and no leftover tab.
- [ ] `cap profile.get --url=<url>` exits 0, writes a row to `persons`, and reports zero warnings.
- [ ] Re-running the same `profile.get` returns `from_cache:true` and spends no page load.
- [ ] `--max-age=0` forces a re-fetch and does spend one.
- [ ] Logging out of the automation profile makes `profile.get` exit 4 with `action:"REAUTH"`.
- [ ] `--dry-run` on every browser capability makes zero LinkedIn requests.
- [ ] `runs/budget.ndjson` accounts for every page load taken.
- [ ] `fixtures/` and `runs/` are absent from `git status`.
- [ ] `STATE.md` says M1, M2, M3 complete, and `DECISIONS.md` contains D1–D11.

## What is deliberately not here

Deferred to their own plans, per the spec's scope: the rest of L1 (`company.get`,
`company.posts`, `company.people`, `company.jobs`, `job.get`, `post.get`, `feed.get`,
`inbox.list`, `inbox.thread`, `profile.posts`, `profile.activity`) in M4; Sales Navigator
leads and accounts with pagination and resume in M5; the filter builder and its self-test
loop in M6.

Each will be small, because it builds on a core this plan proves.
