import { describe, expect, test } from "bun:test";
import type { SearchItem } from "../api/search/schemas";
import { cloudResourceSearchUrl, filterCloudResourceSearchItems } from "./resource-search";

const item = (id: string, readable: boolean): SearchItem => ({
  appId: "demo",
  appName: "Demo",
  appIcon: "ti ti-box",
  readable,
  ref: { type: "demo.item", id },
  title: id,
  href: `/app/demo/${id}`,
});

describe("Cloud resource search", () => {
  test("combines text, tags, one app, and the reader requirement", () => {
    expect(
      cloudResourceSearchUrl({
        query: "launch plan",
        tags: ["note", "project"],
        appId: "notebooks",
        requireReader: true,
      }),
    ).toBe("/api/search?provider_limit=10&q=launch+plan&tag=note&tag=project&app=notebooks&require_reader=true");
  });

  test("keeps an unscoped catalog request free of filters", () => {
    expect(cloudResourceSearchUrl({ query: "", tags: [] })).toBe("/api/search?provider_limit=10");
  });

  test("can require readable resources and exclude refs already selected", () => {
    expect(
      filterCloudResourceSearchItems([item("kept", true), item("navigation-only", false), item("existing", true)], {
        requireReader: true,
        excludeRefs: [{ type: "demo.item", id: "existing" }],
      }).map((entry) => entry.ref.id),
    ).toEqual(["kept"]);
  });
});

test("resource type filtering composes with reader and excluded references", () => {
  const other = { ...item("other", true), ref: { type: "other.item", id: "other" } };
  expect(
    filterCloudResourceSearchItems([item("kept", true), other, item("hidden", false), item("existing", true)], {
      resourceType: "demo.item",
      requireReader: true,
      excludeRefs: [{ type: "demo.item", id: "existing" }],
    }).map((entry) => entry.ref.id),
  ).toEqual(["kept"]);
});
