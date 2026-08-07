/**
 * Tunables specific to the person-activity surface. Everything about pacing,
 * layout and snapshots is `profile.capture`'s and is imported from there — one
 * set of pacing numbers on the one account, in one file.
 */

/**
 * How many relevant bodies the probe sweeps for urns.
 *
 * The sweep is offline work over already-archived bodies, but a feed page can
 * archive dozens of them and each can be a megabyte, so it is bounded rather
 * than trusted to be small. What was left out is reported on the receipt as
 * `bodies_not_inventoried`: a sweep that silently covered half the run would
 * make "no stranger urns found" mean nothing.
 */
export const MAX_INVENTORIED_BODIES = 40;
