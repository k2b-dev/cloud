import { expect, test } from "bun:test";
import { searchHelpTopics } from "./layout-help-search";

const topics = [
  { id: "first", title: "Forms reference" },
  { id: "second", title: "Forms" },
  { id: "third", title: "Calendars" },
];
test("renders SQL rank instead of article order and respects the returned article set", () => {
  expect(searchHelpTopics(topics, "forms", ["second", "first"]).map((t) => t.id)).toEqual(["second", "first"]);
  expect(searchHelpTopics(topics, "forms", ["second", "unknown"]).map((t) => t.id)).toEqual(["second"]);
  expect(searchHelpTopics(topics, "forms", [])).toEqual([]);
});
test("retains metadata search while a request is pending or unavailable", () => {
  expect(searchHelpTopics(topics, "forms", null).map((t) => t.id)).toEqual(["first", "second"]);
  expect(searchHelpTopics(topics, "body-only term", ["second"]).map((t) => t.id)).toEqual(["second"]);
});
