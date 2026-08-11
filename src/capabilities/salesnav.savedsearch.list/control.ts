import type { TrustedControlSpec } from "../salesnav.probe/pager.js";

/** The exact control measured in the archived `/sales/` snapshot and granted
 * by D408. Neither the selector nor the accessible name has a fallback. */
export const SAVED_SEARCHES_CONTROL: TrustedControlSpec = {
  selector: "button[data-x--link--saved-searches]",
  accessibleName: /^saved searches$/i,
  label: "saved searches",
  codePrefix: "SAVED_SEARCHES_CONTROL",
  decision: "D408",
};

/** Measured in the open-panel snapshot from run
 * `01KZQC6PQAN3ZZ6ZW3T0PXB6XQ`. It is a button-role tab with no href and only
 * switches between the operator's own lead/account saved-search collections,
 * so it passes all four D409 parts. */
export const SAVED_ACCOUNT_TAB_CONTROL: TrustedControlSpec = {
  selector: 'button[role="tab"][aria-label="Account- View all account saved searches"]',
  accessibleName: /^account- view all account saved searches$/i,
  label: "saved account searches tab",
  codePrefix: "SAVED_ACCOUNT_TAB_CONTROL",
  decision: "D409",
};
