import { describe, expect, it } from "vitest";
import { CapabilityError } from "../src/core/run/receipt.js";
import { HumanCursor, type InputTarget, type Point } from "../src/core/input/cursor.js";
import {
  MOVE_JITTER_PX,
  MOVE_STEPS_MIN,
  WHEEL_NOTCH_PX_MAX,
  WHEEL_NOTCH_PX_MIN,
} from "../src/core/input/constants.js";
import type { Rng } from "../src/core/input/random.js";

type Dispatch = { method: string; params: Record<string, unknown> };

/**
 * A recording stand-in for the Task 4 `WorkerTab`. Every test in this file runs
 * against it — a live browser in a unit test here would be a design error, and
 * it would prove less: the properties that matter are statistical, and only a
 * fake lets them be asserted over hundreds of dispatches in milliseconds.
 */
class FakeTab implements InputTarget {
  readonly calls: Dispatch[] = [];
  fail: Error | undefined;

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.fail) throw this.fail;
    this.calls.push({ method, params });
    return undefined as T;
  }

  events(type: string): Dispatch[] {
    return this.calls.filter((c) => c.params["type"] === type);
  }

  points(type = "mouseMoved"): Point[] {
    return this.events(type).map((c) => ({ x: c.params["x"] as number, y: c.params["y"] as number }));
  }
}

/** Records every sleep instead of performing it, so a 20-point path costs
 *  nothing and the cadence itself becomes assertable. */
function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

/** An RNG replaying a fixed script, then holding the last value. Lets a test
 *  force a branch (overshoot on / off) rather than wait for probability. */
function scriptedRng(values: number[]): Rng {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

function cursor(opts: { rng?: Rng; start?: Point } = {}) {
  const tab = new FakeTab();
  const { slept, sleep } = fakeSleep();
  return { tab, slept, c: new HumanCursor(tab, { sleep, ...opts }) };
}

describe("HumanCursor.moveTo", () => {
  it("walks a multi-point path instead of teleporting", async () => {
    const { tab, c } = cursor({ start: { x: 10, y: 10 } });
    await c.moveTo(600, 400);

    const moves = tab.points();
    expect(moves.length).toBeGreaterThanOrEqual(MOVE_STEPS_MIN + 1);
    // Every dispatch is a mouseMoved; nothing else was sent.
    expect(tab.calls.every((k) => k.method === "Input.dispatchMouseEvent")).toBe(true);
    // The very first dispatch is not the target — that would be the teleport.
    expect(moves[0]).not.toEqual({ x: 600, y: 400 });
  });

  it("settles on exactly the requested coordinates", async () => {
    const { tab, c } = cursor({ start: { x: 0, y: 0 } });
    const at = await c.moveTo(431, 209);

    expect(at).toEqual({ x: 431, y: 209 });
    expect(tab.points().at(-1)).toEqual({ x: 431, y: 209 });
    expect(c.position).toEqual({ x: 431, y: 209 });
  });

  it("settles exactly even when the move overshoots", async () => {
    // 0.99 forces the overshoot branch (probability 0.2).
    const { tab, c } = cursor({ rng: scriptedRng([0.99]), start: { x: 0, y: 0 } });
    await c.moveTo(300, 200);

    const moves = tab.points();
    const last = moves.at(-1)!;
    const penultimate = moves.at(-2)!;
    expect(last).toEqual({ x: 300, y: 200 });
    // The corrected point really was past the target, on both axes.
    expect(penultimate.x).toBeGreaterThan(300);
    expect(penultimate.y).toBeGreaterThan(200);
  });

  it("overshoots on a minority of moves, not all and not none", async () => {
    // Detected by a penultimate point further off-target than jitter can reach:
    // jitter is bounded by MOVE_JITTER_PX on both axes, so this never fires on
    // an ordinary settle, and it catches almost every real overshoot.
    let overshoots = 0;
    const runs = 300;
    for (let i = 0; i < runs; i++) {
      const { tab, c } = cursor({ start: { x: 0, y: 0 } });
      await c.moveTo(500, 300);
      const before = tab.points().at(-2)!;
      if (
        Math.abs(before.x - 500) > MOVE_JITTER_PX ||
        Math.abs(before.y - 300) > MOVE_JITTER_PX
      ) {
        overshoots++;
      }
    }
    // ~20% expected; the band is wide enough not to flake and narrow enough to
    // catch "always" and "never".
    expect(overshoots).toBeGreaterThan(runs * 0.08);
    expect(overshoots).toBeLessThan(runs * 0.35);
  });

  it("never replays the same path to the same target", async () => {
    const a = cursor({ start: { x: 20, y: 20 } });
    const b = cursor({ start: { x: 20, y: 20 } });
    await a.c.moveTo(700, 500);
    await b.c.moveTo(700, 500);

    expect(JSON.stringify(a.tab.points())).not.toEqual(JSON.stringify(b.tab.points()));
  });

  it("bows to both sides across repeated moves", async () => {
    // A path that always bows the same way is a fingerprint of its own.
    const sides = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const { tab, c } = cursor({ start: { x: 0, y: 0 } });
      await c.moveTo(400, 0);
      const mid = tab.points()[3]!;
      sides.add(Math.sign(mid.y));
    }
    expect(sides.has(1)).toBe(true);
    expect(sides.has(-1)).toBe(true);
  });

  it("seeds a real path when the cursor position is unknown", async () => {
    const { tab, c } = cursor();
    expect(c.position).toBeNull();
    await c.moveTo(200, 200);

    const moves = tab.points();
    expect(moves.length).toBeGreaterThanOrEqual(MOVE_STEPS_MIN + 1);
    // It did not start on top of the target.
    expect(Math.hypot(moves[0]!.x - 200, moves[0]!.y - 200)).toBeGreaterThan(0);
  });

  it("uses no fixed cadence between points", async () => {
    const { slept, c } = cursor({ start: { x: 0, y: 0 } });
    await c.moveTo(800, 600);
    expect(new Set(slept).size).toBeGreaterThan(1);
  });

  it("refuses non-finite coordinates rather than dispatching them", async () => {
    const { tab, c } = cursor({ start: { x: 0, y: 0 } });
    await expect(c.moveTo(Number.NaN, 10)).rejects.toMatchObject({
      code: "INPUT_INVALID_COORDINATE",
      retryable: false,
      exit: 1,
    });
    await expect(c.moveTo(10, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(CapabilityError);
    expect(tab.calls).toHaveLength(0);
  });

  it("lets a transport failure through untouched", async () => {
    const { tab, c } = cursor({ start: { x: 0, y: 0 } });
    tab.fail = new CapabilityError({
      code: "CDP_CONNECTION_CLOSED",
      exit: 6,
      action: "RETRY_BACKOFF",
      retryable: true,
      message: "socket died",
    });
    await expect(c.moveTo(100, 100)).rejects.toMatchObject({ code: "CDP_CONNECTION_CLOSED" });
  });
});

describe("HumanCursor.click", () => {
  it("presses and releases at the settled position, after moving there", async () => {
    const { tab, c } = cursor({ start: { x: 0, y: 0 } });
    await c.click(320, 240);

    const press = tab.events("mousePressed");
    const release = tab.events("mouseReleased");
    expect(press).toHaveLength(1);
    expect(release).toHaveLength(1);
    expect(press[0]!.params).toMatchObject({ x: 320, y: 240, button: "left", buttons: 1, clickCount: 1 });
    // `buttons` is the mask of buttons still held: a real mouseup reports none.
    expect(release[0]!.params).toMatchObject({ x: 320, y: 240, button: "left", buttons: 0 });

    // The pointer arrived before the press, and the last move was the target.
    const order = tab.calls.map((k) => k.params["type"]);
    expect(order.indexOf("mousePressed")).toBeGreaterThan(order.lastIndexOf("mouseMoved"));
    expect(tab.points().at(-1)).toEqual({ x: 320, y: 240 });
  });

  it("holds the button down for a randomized, non-zero time", async () => {
    const holds: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { slept, c } = cursor({ start: { x: 0, y: 0 } });
      await c.click(100, 100);
      holds.push(slept.at(-1)!); // the hold is the last delay of a click
    }
    expect(holds.every((ms) => ms >= 45 && ms <= 130)).toBe(true);
    expect(new Set(holds).size).toBeGreaterThan(1);
  });
});

describe("HumanCursor.wheel", () => {
  it("dispatches real mouseWheel notches inside the human band", async () => {
    const { tab, c } = cursor({ start: { x: 400, y: 300 } });
    await c.wheel(400, 300, 1000);

    const deltas = tab.events("mouseWheel").map((k) => k.params["deltaY"] as number);
    expect(deltas.length).toBeGreaterThan(1);
    for (const d of deltas) {
      expect(Math.abs(d)).toBeGreaterThanOrEqual(WHEEL_NOTCH_PX_MIN);
      expect(Math.abs(d)).toBeLessThanOrEqual(WHEEL_NOTCH_PX_MAX);
    }
  });

  it("sums exactly to the requested distance, over many random distances", async () => {
    for (let i = 0; i < 200; i++) {
      const want = WHEEL_NOTCH_PX_MIN + Math.floor(Math.random() * 4000);
      const { tab, c } = cursor({ start: { x: 400, y: 300 } });
      const r = await c.wheel(400, 300, want);

      const deltas = tab.events("mouseWheel").map((k) => k.params["deltaY"] as number);
      expect(deltas.reduce((a, b) => a + b, 0)).toBe(want);
      expect(r.scrolled).toBe(want);
      expect(r.notches).toBe(deltas.length);
      expect(deltas.every((d) => d >= WHEEL_NOTCH_PX_MIN && d <= WHEEL_NOTCH_PX_MAX)).toBe(true);
    }
  });

  it("scrolls up with negative deltas", async () => {
    const { tab, c } = cursor({ start: { x: 400, y: 300 } });
    const r = await c.wheel(400, 300, -600);

    const deltas = tab.events("mouseWheel").map((k) => k.params["deltaY"] as number);
    expect(deltas.every((d) => d < 0)).toBe(true);
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(-600);
    expect(r.scrolled).toBe(-600);
  });

  it("rounds an ask smaller than one notch up, and says so", async () => {
    const { tab, c } = cursor({ start: { x: 400, y: 300 } });
    const r = await c.wheel(400, 300, 12);

    const deltas = tab.events("mouseWheel").map((k) => k.params["deltaY"] as number);
    expect(deltas).toEqual([WHEEL_NOTCH_PX_MIN]);
    expect(r).toEqual({ requested: 12, scrolled: WHEEL_NOTCH_PX_MIN, notches: 1 });
  });

  it("caps at maxNotches and reports the short scroll", async () => {
    const { tab, c } = cursor({ start: { x: 400, y: 300 } });
    const r = await c.wheel(400, 300, 5000, { maxNotches: 3 });

    expect(tab.events("mouseWheel")).toHaveLength(3);
    expect(r.notches).toBe(3);
    expect(r.scrolled).toBeLessThan(5000);
    expect(r.requested).toBe(5000);
  });

  it("dispatches nothing for a zero delta", async () => {
    const { tab, c } = cursor({ start: { x: 400, y: 300 } });
    expect(await c.wheel(400, 300, 0)).toEqual({ requested: 0, scrolled: 0, notches: 0 });
    expect(tab.calls).toHaveLength(0);
  });

  it("walks the pointer over first when it is far from the scroll point", async () => {
    const { tab, c } = cursor({ start: { x: 0, y: 0 } });
    await c.wheel(700, 500, 200);

    expect(tab.points().length).toBeGreaterThan(1);
    expect(c.position).toEqual({ x: 700, y: 500 });
    const order = tab.calls.map((k) => k.params["type"]);
    expect(order.indexOf("mouseWheel")).toBeGreaterThan(order.lastIndexOf("mouseMoved"));
  });

  it("does not move the pointer when it is already near the scroll point", async () => {
    const { tab, c } = cursor({ start: { x: 400, y: 300 } });
    await c.wheel(410, 310, 200);
    expect(tab.events("mouseMoved")).toHaveLength(0);
  });

  it("dispatches every notch at the requested point", async () => {
    const { tab, c } = cursor({ start: { x: 400, y: 300 } });
    await c.wheel(400, 300, 800);
    for (const k of tab.events("mouseWheel")) {
      expect(k.params).toMatchObject({ x: 400, y: 300, deltaX: 0 });
    }
  });

  it("uses no fixed cadence between notches", async () => {
    const { slept, c } = cursor({ start: { x: 400, y: 300 } });
    await c.wheel(400, 300, 2000);
    expect(new Set(slept).size).toBeGreaterThan(1);
  });
});

describe("HumanCursor.pause", () => {
  it("sleeps a randomized duration inside the requested band", async () => {
    const { slept, c } = cursor();
    for (let i = 0; i < 30; i++) await c.pause(100, 200);
    expect(slept.every((ms) => ms >= 100 && ms <= 200)).toBe(true);
    expect(new Set(slept).size).toBeGreaterThan(1);
  });
});
