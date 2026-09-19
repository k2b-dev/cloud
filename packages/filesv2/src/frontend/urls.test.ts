import { expect, test } from "bun:test";
import { adminHref, parseAdminLocation } from "./admin-location";
import { filesUrl, pathCrumbs } from "./urls";

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
  const url = new URL(
    adminHref(parseAdminLocation("/admin/filesv2?view=directories&area=freeipa&kind=groups&status=orphaned&q=old"), { after: "next/name" }),
    "https://cloud.test",
  );
  expect(url.searchParams.get("area")).toBe("freeipa");
  expect(url.searchParams.get("kind")).toBe("groups");
  expect(url.searchParams.get("after")).toBe("next/name");
  expect(url.searchParams.get("view")).toBe("directories");
  expect(url.searchParams.get("status")).toBe("orphaned");
  expect(url.searchParams.get("q")).toBe("old");
});


test("paging and reload URLs preserve the whole global browse query", () => {
  const options = { sort: "modified" as const, order: "desc" as const, type: "files" as const, groupFolders: false };
  const url = new URL(filesUrl("home", "Docs", "opaque-cursor", "Docs/a.txt", "report", "folder", options), "https://cloud.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({ base: "home", path: "Docs", after: "opaque-cursor", file: "Docs/a.txt", q: "report", scope: "folder", sort: "modified", order: "desc", type: "files", groupFolders: "false" });
});
