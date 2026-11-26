import { expect, test } from "bun:test";
import { feedbackHref, feedbackQuery, legacyFeedbackHref, parseFeedbackAddress } from "./feedback-query";

test("the feedback address reads days, comments, search and page through its declaration", () => {
  const query = feedbackQuery("de");
  const parsed = parseFeedbackAddress(query, new URLSearchParams("days=7&comments=1&q=Kuchen&page=2"));
  expect({ days: parsed.days, comments: parsed.comments, search: parsed.search, page: parsed.page }).toEqual({
    days: 7,
    comments: true,
    search: "Kuchen",
    page: 2,
  });
  // an unknown window falls back to the default 30 days, a bad page to 1
  const fallback = parseFeedbackAddress(query, new URLSearchParams("days=9&page=x"));
  expect({ days: fallback.days, page: fallback.page }).toEqual({ days: 30, page: 1 });
  expect(feedbackHref("Cafe01", query, parsed.state, 3)).toBe("/app/venue/Cafe01/feedback?days=7&comments=1&q=Kuchen&page=3");
});

test("addresses from before v2 keep working: search= leads to q=", () => {
  expect(legacyFeedbackHref("/app/venue/Cafe01/feedback", new URLSearchParams("days=14&search=Kuchen"))).toBe(
    "/app/venue/Cafe01/feedback?days=14&q=Kuchen",
  );
  expect(legacyFeedbackHref("/app/venue/Cafe01/feedback", new URLSearchParams("days=14"))).toBeNull();
});
