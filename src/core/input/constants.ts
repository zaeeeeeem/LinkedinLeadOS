/**
 * Every tunable in the human-input layer, in one file.
 *
 * These bands are not decoration — they are the shape of the fingerprint. The
 * reference worker (`engine/cdp.mjs`) arrived at them deliberately after a
 * pointer that teleported straight to its target, 25 times per page, proved to
 * be a tell on its own. Widening or narrowing one is a safety decision, not a
 * tuning convenience.
 */

/** Points dispatched along one cursor path, before overshoot and settle. */
export const MOVE_STEPS_MIN = 8;
export const MOVE_STEPS_MAX = 20;

/** How far the Bézier control point is pushed off the straight line, as a
 *  percentage of the travel distance. The sign is random, so two moves along
 *  the same line bow opposite ways. */
export const MOVE_BOW_PCT_MIN = 5;
export const MOVE_BOW_PCT_MAX = 18;

/** Per-point jitter, in pixels, on every intermediate point. Never applied to
 *  the final point — see `MOVE_SETTLES_EXACTLY`. */
export const MOVE_JITTER_PX = 3;

/** Gap between two consecutive points of a path. */
export const MOVE_STEP_DELAY_MS_MIN = 8;
export const MOVE_STEP_DELAY_MS_MAX = 25;

/** Fraction of moves that overshoot the target and correct back. A hand that
 *  lands perfectly every single time is as unnatural as one that teleports. */
export const MOVE_OVERSHOOT_PROBABILITY = 0.2;

/** How far past the target an overshoot goes, along each axis. */
export const MOVE_OVERSHOOT_X_MIN = 3;
export const MOVE_OVERSHOOT_X_MAX = 12;
export const MOVE_OVERSHOOT_Y_MIN = 2;
export const MOVE_OVERSHOOT_Y_MAX = 8;

/** Pause at the overshot point before correcting back onto the target. */
export const MOVE_OVERSHOOT_DELAY_MS_MIN = 20;
export const MOVE_OVERSHOOT_DELAY_MS_MAX = 60;

/** When the cursor position is unknown, the path starts from somewhere
 *  plausible rather than from the target itself — a zero-length path would be
 *  a teleport wearing a different name. */
export const MOVE_SEED_X_SPREAD = 320;
export const MOVE_SEED_Y_SPREAD = 220;

/** The hand settling before the press, and the press itself. */
export const CLICK_SETTLE_MS_MIN = 60;
export const CLICK_SETTLE_MS_MAX = 220;
export const CLICK_HOLD_MS_MIN = 45;
export const CLICK_HOLD_MS_MAX = 130;

/** The human wheel-notch band. A delta outside it is either a giveaway twitch
 *  or a scroll no wheel produces. */
export const WHEEL_NOTCH_PX_MIN = 40;
export const WHEEL_NOTCH_PX_MAX = 120;

/** Gap between notches. */
export const WHEEL_NOTCH_DELAY_MS_MIN = 30;
export const WHEEL_NOTCH_DELAY_MS_MAX = 110;

/** How far the pointer may already be from the scroll point before the cursor
 *  is walked over to it first. A human scrolls where the pointer already is;
 *  they also do not scroll an element the pointer is nowhere near. */
export const WHEEL_POINTER_RADIUS_PX = 120;

/** Default band for `HumanCursor.pause()` — the generic inter-action delay
 *  that keeps the cadence off a fixed grid. */
export const ACTION_PAUSE_MS_MIN = 250;
export const ACTION_PAUSE_MS_MAX = 900;

/** Documentation anchor for the invariant the tests pin: every path ends with
 *  one dispatch on the exact requested coordinates, so hit-testing sees the
 *  target the caller asked for and nothing else. */
export const MOVE_SETTLES_EXACTLY = true;
