import { setTimeout as delay } from "node:timers/promises";

/**
 * A source of randomness, injectable so tests can force a branch (an overshoot,
 * a particular notch size) without waiting for probability to cooperate.
 * Contract is `Math.random`'s: uniform in `[0, 1)`.
 */
export type Rng = () => number;

/** A sleep, injectable for the same reason — a full offline test of a 20-point
 *  path would otherwise spend half a second doing nothing. */
export type Sleep = (ms: number) => Promise<void>;

export const defaultRng: Rng = Math.random;

export const defaultSleep: Sleep = async (ms) => {
  await delay(ms);
};

/** Uniform integer in `[min, max]`, both inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Uniform float in `[min, max)`. */
export function randFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** True with probability `p`. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** `+1` or `-1`, evenly. */
export function randSign(rng: Rng): 1 | -1 {
  return rng() < 0.5 ? -1 : 1;
}

/** Sleeps for a uniformly random duration in `[min, max]` ms. The single
 *  reason no delay anywhere in this layer is a constant. */
export async function randDelay(rng: Rng, sleep: Sleep, min: number, max: number): Promise<number> {
  const ms = randInt(rng, min, max);
  await sleep(ms);
  return ms;
}
