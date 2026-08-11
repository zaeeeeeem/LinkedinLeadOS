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

