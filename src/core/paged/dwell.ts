import { defaultRng, defaultSleep, randFloat, randInt, type Rng, type Sleep } from "../input/random.js";
import {
  PAGE_BREAK_EVERY, PAGE_BREAK_MS_MAX, PAGE_BREAK_MS_MIN,
  PAGE_DWELL_LONG_FLOOR_PCT, PAGE_DWELL_LONG_PROBABILITY,
  PAGE_DWELL_MAX_MS_GUARD, PAGE_DWELL_MEDIAN_PCT,
  PAGE_DWELL_MICRO_MS_MAX, PAGE_DWELL_MICRO_MS_MIN, PAGE_DWELL_MICRO_PROBABILITY,
  PAGE_DWELL_MS_MAX, PAGE_DWELL_MS_MIN, PAGE_DWELL_SIGMA,
} from "./constants.js";

/**
 * A standard normal draw, Box-Muller. `rng()` is uniform in `[0, 1)`, so the
 * log guard matters: `Math.log(0)` is `-Infinity` and would produce a dwell of
 * `Infinity` roughly once in 2^53 runs — cheap to exclude, impossible to debug.
 */
function gaussian(rng: Rng): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(ms: number, min: number, max: number): number {
  if (!Number.isFinite(ms)) return max;
  return Math.min(max, Math.max(min, Math.round(ms)));
}

/**
 * One inter-page dwell, in milliseconds. Three-part mixture — see the constants
 * file for why the shape is not a uniform draw.
 */
export function nextDwellMs(rng: Rng = defaultRng): number {
  const roll = rng();
  if (roll < PAGE_DWELL_MICRO_PROBABILITY) {
    return randInt(rng, PAGE_DWELL_MICRO_MS_MIN, PAGE_DWELL_MICRO_MS_MAX);
  }
  const span = PAGE_DWELL_MS_MAX - PAGE_DWELL_MS_MIN;
  if (roll < PAGE_DWELL_MICRO_PROBABILITY + PAGE_DWELL_LONG_PROBABILITY) {
    // The tail draws from the top of the configured band, never from a band of
    // its own — the reference worker's one measured pacing bug.
    return randInt(rng, Math.round(PAGE_DWELL_MS_MIN + span * PAGE_DWELL_LONG_FLOOR_PCT), PAGE_DWELL_MS_MAX);
  }
  const median = PAGE_DWELL_MS_MIN + span * PAGE_DWELL_MEDIAN_PCT;
  return clamp(median * Math.exp(PAGE_DWELL_SIGMA * gaussian(rng)), PAGE_DWELL_MS_MIN, PAGE_DWELL_MS_MAX);
}

/** The longer break taken every `PAGE_BREAK_EVERY` pages instead of a dwell. */
export function nextBreakMs(rng: Rng = defaultRng): number {
  return Math.round(randFloat(rng, PAGE_BREAK_MS_MIN, PAGE_BREAK_MS_MAX));
}

export type DwellDecision = { ms: number; kind: "dwell" | "break" };

/** Which of the two this page boundary gets. `pagesDone` is the number of
 *  pages completed so far, so the break lands *after* every fifth page. */
export function decideDwell(pagesDone: number, rng: Rng = defaultRng): DwellDecision {
  if (pagesDone > 0 && pagesDone % PAGE_BREAK_EVERY === 0) return { ms: nextBreakMs(rng), kind: "break" };
  return { ms: nextDwellMs(rng), kind: "dwell" };
}

/**
 * What the loop calls between pages. Injectable end to end (`rng`, `sleep`) so
 * the whole paged core is provable offline in milliseconds rather than in the
 * minutes a real run deliberately takes.
 *
 * `PAGE_DWELL_MAX_MS_GUARD` is a ceiling on what any of this can produce: a
 * mis-set constant that stalls a live run holding the tab lease is a worse
 * failure than a dwell that is one draw too short.
 */
export async function dwellBetweenPages(o: {
  pagesDone: number;
  rng?: Rng;
  sleep?: Sleep;
}): Promise<DwellDecision> {
  const decision = decideDwell(o.pagesDone, o.rng ?? defaultRng);
  const ms = Math.min(decision.ms, PAGE_DWELL_MAX_MS_GUARD);
  await (o.sleep ?? defaultSleep)(ms);
  return { ms, kind: decision.kind };
}
