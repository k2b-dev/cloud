import { expect, test } from "bun:test";
import { adminUrl, filesUrl, pathCrumbs } from "./urls";

test("navigation retains opaque identities and filenames as query values", () => {
  const url = new URL(filesUrl("freeipa:group:123", "Budget #1/über uns?", "next/+="), "https://cloud.test");
  expect(url.pathname).toBe("/app/filesv2");
  expect(url.searchParams.get("base")).toBe("freeipa:group:123");
  expect(url.searchParams.get("path")).toBe("Budget #1/über uns?");
  expect(url.searchParams.get("after")).toBe("next/+=");
  expect(filesUrl()).toBe("/app/filesv2");
  expect(pathCrumbs("one/two")).toEqual([
    { name: "one", path: "one" },
    { name: "two", path: "one/two" },
  ]);
});

test("inventory pagination preserves selected area and identity kind", () => {
  const url = new URL(adminUrl("freeipa", "groups", "next/name"), "https://cloud.test");
  expect(url.searchParams.get("area")).toBe("freeipa");
  expect(url.searchParams.get("kind")).toBe("groups");
  expect(url.searchParams.get("after")).toBe("next/name");
});
