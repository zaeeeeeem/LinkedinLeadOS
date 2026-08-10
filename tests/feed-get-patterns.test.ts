import { describe, expect, it } from "vitest";
import { carriesFeedPayload, isFeedIsh, isNonFeedRail } from "../src/capabilities/feed.get/patterns.js";
import { summarizeCaptures } from "../src/capabilities/profile.capture/patterns.js";

/** The notification rail, in the shape the live run archived it: activity urns
 *  and a comment count, inside a body that is not the feed. */
const NOTIFICATION_BODY = JSON.stringify({
  data: { cards: [{ entityUrn: "urn:li:activity:7492274794852220928", numComments: 3 }] },
});
const NOTIFICATION_URL = "https://www.linkedin.com/voyager/api/voyagerIdentityDashNotificationCards?q=filter";
const FEED_DOC_URL = "https://www.linkedin.com/feed/";
const FEED_API_URL = "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashUpdates.abc";
const FEED_BODY = JSON.stringify({ data: { elements: [{ entityUrn: "urn:li:activity:7492274794852220928" }] } });

describe("what counts as a feed payload", () => {
  it("calls the notification rail feed-ish by body alone — which is the trap", () => {
    // Not a bug in isFeedIsh: promotion excludes the rails by endpoint. It is
    // only a trap when the same test is used to answer "did an API answer".
    expect(isFeedIsh(NOTIFICATION_BODY)).toBe(true);
    expect(isNonFeedRail(NOTIFICATION_URL)).toBe(true);
    expect(carriesFeedPayload(NOTIFICATION_BODY, NOTIFICATION_URL)).toBe(false);
  });

  it("does not count the page's own document as a payload", () => {
    // The document carries the feed because it *is* the page. Counting it kept
    // NO_FEED_PAYLOAD from ever firing.
    expect(carriesFeedPayload("<html>urn:li:activity:123</html>", FEED_DOC_URL)).toBe(false);
    expect(carriesFeedPayload("<html>urn:li:activity:123</html>", "https://www.linkedin.com/feed")).toBe(false);
  });

  it("counts a real feed endpoint's body", () => {
    expect(carriesFeedPayload(FEED_BODY, FEED_API_URL)).toBe(true);
  });

  it("counts nothing when the page answers only with its document and its rails", () => {
    // The live shape, twice on 2026-08-10. Both probe signals must be silent
    // about noise and loud about the finding.
    const captures = [
      { url: FEED_DOC_URL, body: "<html>urn:li:activity:1</html>", status: 200, bytes: 10, patterns: ["feed-document"], archived: { shapeHash: "a", file: "0000" } },
      { url: NOTIFICATION_URL, body: NOTIFICATION_BODY, status: 200, bytes: 10, patterns: ["linkedin-api"], archived: { shapeHash: "b", file: "0001" } },
    ] as never;
    const summary = summarizeCaptures(captures, [], [
      { name: "gql-feed-updates", tier: "specific", match: "voyagerFeedDashUpdates" },
      { name: "linkedin-api", tier: "broad", match: () => true },
    ], { isRelevant: carriesFeedPayload });

    // NO_FEED_PAYLOAD is gated on this being zero. It never was.
    expect(summary.profile_ish).toBe(0);
    // PATTERN_MISMATCH is gated on this. It fired on every single run.
    expect(summary.unmatched_profile_ish).toBe(0);
  });

  it("still reports an unpredicted endpoint that really does carry the feed", () => {
    const captures = [
      { url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashSomethingNew.x", body: FEED_BODY, status: 200, bytes: 10, patterns: ["linkedin-api"], archived: { shapeHash: "c", file: "0002" } },
    ] as never;
    const summary = summarizeCaptures(captures, [], [
      { name: "gql-feed-updates", tier: "specific", match: "voyagerFeedDashUpdates" },
      { name: "linkedin-api", tier: "broad", match: () => true },
    ], { isRelevant: carriesFeedPayload });
    expect(summary.profile_ish).toBe(1);
    expect(summary.unmatched_profile_ish).toBe(1);
  });
});
