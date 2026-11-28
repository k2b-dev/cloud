import { expect, test } from "bun:test";
import { legacyRoutesHref } from "./query";

test("the routes search of before v2 leads to the same list; an address without it stays", () => {
  expect(legacyRoutesHref(new URLSearchParams("search=mail&range=7d"))).toBe("/admin/observability/gateway/routes?range=7d&q=mail");
  expect(legacyRoutesHref(new URLSearchParams("search="))).toBe("/admin/observability/gateway/routes");
  expect(legacyRoutesHref(new URLSearchParams("range=7d"))).toBeNull();
});
