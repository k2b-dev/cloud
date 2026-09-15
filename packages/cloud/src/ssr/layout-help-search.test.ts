import { expect, test } from "bun:test";
import { searchHelpTopics } from "./layout-help-search";

const topics = [
  { id: "first", title: "Forms reference", kind: "document" as const },
  { id: "second", title: "Forms", kind: "document" as const },
  { id: "shortcuts", title: "Forms shortcuts", kind: "content" as const },
];
test("renders SQL rank instead of article order and respects the returned document set", () => {
  expect(searchHelpTopics(topics, "forms", ["second", "first"]).map((t) => t.id)).toEqual(["second", "first", "shortcuts"]);
  expect(searchHelpTopics(topics, "forms", ["second"]).map((t) => t.id)).toEqual(["second", "shortcuts"]);
  expect(searchHelpTopics(topics, "forms", []).map((t) => t.id)).toEqual(["shortcuts"]);
});
test("retains metadata search while a request is pending or unavailable", () => {
  expect(searchHelpTopics(topics, "forms", null)).toEqual(topics);
  expect(searchHelpTopics(topics, "body-only term", ["second"]).map((t) => t.id)).toEqual(["second"]);
});
