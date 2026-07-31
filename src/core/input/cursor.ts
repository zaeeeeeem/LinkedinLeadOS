import { CapabilityError, EXIT } from "../run/receipt.js";
import {
  ACTION_PAUSE_MS_MAX,
  ACTION_PAUSE_MS_MIN,
  CLICK_HOLD_MS_MAX,
  CLICK_HOLD_MS_MIN,
  CLICK_SETTLE_MS_MAX,
  CLICK_SETTLE_MS_MIN,
  MOVE_BOW_PCT_MAX,
  MOVE_BOW_PCT_MIN,
  MOVE_JITTER_PX,
  MOVE_OVERSHOOT_DELAY_MS_MAX,
  MOVE_OVERSHOOT_DELAY_MS_MIN,
  MOVE_OVERSHOOT_PROBABILITY,
  MOVE_OVERSHOOT_X_MAX,
  MOVE_OVERSHOOT_X_MIN,
  MOVE_OVERSHOOT_Y_MAX,
  MOVE_OVERSHOOT_Y_MIN,
  MOVE_SEED_X_SPREAD,
  MOVE_SEED_Y_SPREAD,
  MOVE_STEPS_MAX,
  MOVE_STEPS_MIN,
  MOVE_STEP_DELAY_MS_MAX,
  MOVE_STEP_DELAY_MS_MIN,
  WHEEL_NOTCH_DELAY_MS_MAX,
  WHEEL_NOTCH_DELAY_MS_MIN,
  WHEEL_NOTCH_PX_MAX,
  WHEEL_NOTCH_PX_MIN,
  WHEEL_POINTER_RADIUS_PX,
} from "./constants.js";
import {
  chance,
  defaultRng,
  defaultSleep,
  randDelay,
  randInt,
  randSign,
  type Rng,
  type Sleep,
} from "./random.js";

export type Point = { x: number; y: number };

/**
 * The slice of the Task 4 `WorkerTab` this layer needs: one session-scoped
 * `send`. Structural on purpose, exactly as `CdpTransport` is — every test in
 * this module runs against a recording fake, and nothing here may ever require
 * a live browser to be exercised.
 */
export type InputTarget = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type HumanCursorOptions = {
  rng?: Rng;
  sleep?: Sleep;
  /** A known starting position, when the caller has one. Otherwise the first
   *  path seeds itself from somewhere plausible near the target. */
  start?: Point;
};

export type WheelResult = {
  /** Signed distance the caller asked for. */
  requested: number;
  /** Signed distance actually dispatched. Differs from `requested` when the
   *  ask was smaller than one notch, or when `maxNotches` cut it short. */
  scrolled: number;
  notches: number;
};

function invalidCoordinate(what: string, value: unknown): CapabilityError {
  return new CapabilityError({
    code: "INPUT_INVALID_COORDINATE",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `human input received a non-finite ${what}: ${String(value)}`,
    evidence: String(value),
  });
}

/** Chrome accepts NaN coordinates and dispatches an event that lands nowhere,
 *  which surfaces later as a click that silently did nothing. Cheaper to
 *  refuse here than to debug there. */
function assertFinite(what: string, value: number): void {
  if (!Number.isFinite(value)) throw invalidCoordinate(what, value);
}

/** Slow-in, fast-middle, slow-out. A constant-velocity path is as much of a
 *  tell as a teleport — real hands accelerate and brake. */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Pointer and wheel input that is statistically human, dispatched through a
 * `WorkerTab` (spec §8, "Pacing").
 *
 * Ported from the reference worker's `engine/cdp.mjs`, typed, with the
 * randomness and the clock lifted into injectable seams so the behaviour is
 * provable offline. The properties that matter and are pinned by tests:
 *
 * - a move is a multi-point curved path, never a single teleporting dispatch;
 * - it settles on **exactly** the requested coordinates, so hit-testing is
 *   identical to what a naive implementation would have produced;
 * - two moves to the same target never replay the same path;
 * - wheel deltas stay inside the human 40–120px notch band;
 * - no delay anywhere is a constant.
 */
export class HumanCursor {
  readonly #target: InputTarget;
  readonly #rng: Rng;
  readonly #sleep: Sleep;
  #at: Point | null;

  constructor(target: InputTarget, opts: HumanCursorOptions = {}) {
    this.#target = target;
    this.#rng = opts.rng ?? defaultRng;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#at = opts.start ? { ...opts.start } : null;
  }

  /** Last known pointer position, or `null` before the first move. Moves are
   *  paths *from* here, which is why the cursor is stateful at all. */
  get position(): Point | null {
    return this.#at ? { ...this.#at } : null;
  }

  /**
   * Walks the pointer to `(x, y)` along a quadratic Bézier with a randomly
   * bowed control point, eased timing, per-point jitter, and — on roughly one
   * move in five — an overshoot that is corrected.
   *
   * The last dispatch is always the unjittered target, so a caller relying on
   * the pointer being over an element gets exactly that guarantee.
   */
  async moveTo(x: number, y: number): Promise<Point> {
    assertFinite("x coordinate", x);
    assertFinite("y coordinate", y);

    // Already there: dispatch nothing. Twenty identical mousemoves at one pixel
    // is a stranger signal than the single one a naive implementation sends,
    // and it is what `dist || 1` would otherwise produce for a no-op move.
    if (this.#at && this.#at.x === x && this.#at.y === y) return { x, y };

    const from = this.#at ?? this.#seedOrigin(x, y);
    const dx = x - from.x;
    const dy = y - from.y;
    const dist = Math.hypot(dx, dy) || 1;

    // Control point pushed perpendicular off the straight line, either side.
    const bow = (randInt(this.#rng, MOVE_BOW_PCT_MIN, MOVE_BOW_PCT_MAX) / 100) * dist * randSign(this.#rng);
    const cx = (from.x + x) / 2 + (-dy / dist) * bow;
    const cy = (from.y + y) / 2 + (dx / dist) * bow;

    const steps = randInt(this.#rng, MOVE_STEPS_MIN, MOVE_STEPS_MAX);
    for (let i = 1; i <= steps; i++) {
      const t = easeInOutQuad(i / steps);
      const u = 1 - t;
      const px = Math.round(u * u * from.x + 2 * u * t * cx + t * t * x + this.#jitter());
      const py = Math.round(u * u * from.y + 2 * u * t * cy + t * t * y + this.#jitter());
      await this.#dispatchMove(px, py);
      await randDelay(this.#rng, this.#sleep, MOVE_STEP_DELAY_MS_MIN, MOVE_STEP_DELAY_MS_MAX);
    }

    if (chance(this.#rng, MOVE_OVERSHOOT_PROBABILITY)) {
      const ox = x + (dx >= 0 ? 1 : -1) * randInt(this.#rng, MOVE_OVERSHOOT_X_MIN, MOVE_OVERSHOOT_X_MAX);
      const oy = y + (dy >= 0 ? 1 : -1) * randInt(this.#rng, MOVE_OVERSHOOT_Y_MIN, MOVE_OVERSHOOT_Y_MAX);
      await this.#dispatchMove(ox, oy);
      await randDelay(
        this.#rng,
        this.#sleep,
        MOVE_OVERSHOOT_DELAY_MS_MIN,
        MOVE_OVERSHOOT_DELAY_MS_MAX,
      );
    }

    // Settle exactly on target — unjittered, unconditional, always last.
    await this.#dispatchMove(x, y);
    return { x, y };
  }

  /**
   * Moves to `(x, y)`, lets the hand settle, then presses and releases there.
   *
   * Every click in the toolkit goes through here rather than through a page-JS
   * `element.click()`: a synthetic DOM click carries `isTrusted: false` and
   * arrives with no preceding pointer traffic at all.
   */
  async click(x: number, y: number, opts: { clickCount?: number } = {}): Promise<Point> {
    const at = await this.moveTo(x, y);
    await randDelay(this.#rng, this.#sleep, CLICK_SETTLE_MS_MIN, CLICK_SETTLE_MS_MAX);

    const clickCount = opts.clickCount ?? 1;
    await this.#target.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: at.x,
      y: at.y,
      button: "left",
      buttons: 1,
      clickCount,
      modifiers: 0,
    });
    await randDelay(this.#rng, this.#sleep, CLICK_HOLD_MS_MIN, CLICK_HOLD_MS_MAX);
    await this.#target.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: at.x,
      y: at.y,
      button: "left",
      // Zero, not one: `buttons` is the mask of buttons still held, and a real
      // mouseup reports none. The reference worker sent 1 here.
      buttons: 0,
      clickCount,
      modifiers: 0,
    });
    return at;
  }

  /**
   * Scrolls by `deltaY` at `(x, y)` using real `mouseWheel` input events, in
   * randomized notches inside the human band.
   *
   * `scrollIntoView` and any JS-driven scroll are forbidden (spec §8): they
   * move content without emitting a single wheel event, and the dispatch point
   * matters besides — a wheel outside the results scroller scrolls the wrong
   * element.
   *
   * Notches are planned so the band holds *and* the total lands exactly on the
   * request: when the remainder would fall below one notch, the current notch
   * is shortened rather than the last one being rounded up. The one case that
   * cannot satisfy both is an ask smaller than a single notch — there the
   * notch wins (a 6px wheel event is a giveaway) and `scrolled` reports the
   * truth.
   */
  async wheel(
    x: number,
    y: number,
    deltaY: number,
    opts: { maxNotches?: number } = {},
  ): Promise<WheelResult> {
    assertFinite("x coordinate", x);
    assertFinite("y coordinate", y);
    assertFinite("wheel delta", deltaY);

    if (deltaY === 0) return { requested: 0, scrolled: 0, notches: 0 };

    // A human scrolls where the pointer already is. Walk it over if it is not.
    if (!this.#at || Math.hypot(this.#at.x - x, this.#at.y - y) > WHEEL_POINTER_RADIUS_PX) {
      await this.moveTo(x, y);
    }

    const total = Math.abs(deltaY);
    const dir = Math.sign(deltaY);
    const cap = opts.maxNotches ?? Infinity;

    let moved = 0;
    let notches = 0;
    while (moved < total && notches < cap) {
      const step = this.#planNotch(total - moved);
      await this.#target.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: dir * step,
        modifiers: 0,
      });
      moved += step;
      notches++;
      await randDelay(this.#rng, this.#sleep, WHEEL_NOTCH_DELAY_MS_MIN, WHEEL_NOTCH_DELAY_MS_MAX);
    }

    return { requested: deltaY, scrolled: dir * moved, notches };
  }

  /** A randomized inter-action delay. Exposed so callers pace themselves
   *  through this layer instead of reaching for a bare `setTimeout`, which is
   *  how a fixed cadence gets reintroduced one call site at a time. */
  async pause(min: number = ACTION_PAUSE_MS_MIN, max: number = ACTION_PAUSE_MS_MAX): Promise<number> {
    return randDelay(this.#rng, this.#sleep, min, max);
  }

  /**
   * Chooses one notch for a remaining distance, keeping every notch inside the
   * band and never leaving an un-scrollable sub-notch remainder behind.
   */
  #planNotch(left: number): number {
    if (left <= WHEEL_NOTCH_PX_MIN) return WHEEL_NOTCH_PX_MIN;
    // Whatever is left fits in one notch: take all of it and finish exactly.
    if (left <= WHEEL_NOTCH_PX_MAX) return left;
    const step = randInt(this.#rng, WHEEL_NOTCH_PX_MIN, WHEEL_NOTCH_PX_MAX);
    // Never leave a remainder smaller than one notch — that is what forces the
    // reference implementation's rounded-up final notch.
    return Math.min(step, left - WHEEL_NOTCH_PX_MIN);
  }

  #jitter(): number {
    return randInt(this.#rng, -MOVE_JITTER_PX, MOVE_JITTER_PX);
  }

  /** Somewhere plausible for a path to have come from, when nothing has moved
   *  the pointer yet. Never the target itself: a zero-length path is a
   *  teleport with extra steps. */
  #seedOrigin(x: number, y: number): Point {
    return {
      x: x + randInt(this.#rng, -MOVE_SEED_X_SPREAD, MOVE_SEED_X_SPREAD),
      y: y + randInt(this.#rng, -MOVE_SEED_Y_SPREAD, MOVE_SEED_Y_SPREAD),
    };
  }

  /**
   * Dispatches one point and records it as the new position.
   *
   * Per dispatch, not once per completed path: a mid-path failure (a transport
   * hiccup, a tab detaching) leaves the real pointer stranded partway along the
   * curve, and a `#at` still holding the origin would make the next `moveTo`
   * plan from a position the browser does not share — its first dispatch would
   * then jump from the true location onto the new curve. That is a teleport,
   * the one thing this module exists never to emit, and it would land right
   * after a retryable failure, which is exactly when a caller retries.
   */
  async #dispatchMove(x: number, y: number): Promise<void> {
    await this.#target.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      modifiers: 0,
    });
    this.#at = { x, y };
  }
}
