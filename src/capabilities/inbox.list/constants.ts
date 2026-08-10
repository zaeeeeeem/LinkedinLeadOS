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

/**
 * The message pane, measured from the archived snapshot of run
 * `01KZNHBF6K79YR9G5WWVRDQ247`. The nesting matters and the first attempt got
 * it wrong: `.msg-s-message-list-container` is a `display-flex` wrapper with no
 * overflow, and `.msg-s-message-list-content` is the `ul` inside. The element
 * that actually scrolls sits between them —
 * `<div class="msg-s-message-list ... scrollable" id="message-list-ember3">`,
 * measured at `scrollHeight 2062 / clientHeight 326`.
 *
 * The id is Ember's per-render counter, so it is matched by prefix and only as
 * a second anchor; the wrapper and the list are kept as last resorts in case
 * LinkedIn moves the overflow up or down a level.
 */
export const INBOX_THREAD_SCROLLERS = [
  ".msg-s-message-list",
  "div[id^='message-list-']",
  ".msg-s-message-list-container",
  ".msg-s-message-list-content",
] as const;

export const MAX_INBOX_ROWS = 100;
export const MAX_INBOX_PARTICIPANTS = 20;
export const DEFAULT_INBOX_SCROLL_PASSES = 2;
export const MAX_INBOX_SCROLL_PASSES = 4;
