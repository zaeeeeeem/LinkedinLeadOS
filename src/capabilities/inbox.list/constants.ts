export const DEFAULT_INBOX_LIST_LIMIT = 20;
export const DEFAULT_INBOX_THREAD_LIMIT = 50;
/**
 * Which box each inbox read scrolls, most specific first.
 *
 * `/messaging/` is the first surface with two scrollers side by side, and the
 * tallest-element rule picks the conversation rail for both — right for the
 * list, wrong for a thread. Measured from the archived snapshot of run
 * `01KZNFTXE2D1530BHYAFEGH7HV`: the rail is
 * `.msg-conversations-container__conversations-list`, the message pane is
 * `.msg-s-message-list-container`. Both are LinkedIn's semantic BEM class
 * names, not the per-build content-hashed kind D128 warns against. See D298.
 */
export const INBOX_LIST_SCROLLERS = [
  ".msg-conversations-container__conversations-list",
] as const;

export const INBOX_THREAD_SCROLLERS = [
  ".msg-s-message-list-container",
  ".msg-s-message-list-content",
] as const;

export const MAX_INBOX_ROWS = 100;
export const MAX_INBOX_PARTICIPANTS = 20;
export const DEFAULT_INBOX_SCROLL_PASSES = 2;
export const MAX_INBOX_SCROLL_PASSES = 4;
