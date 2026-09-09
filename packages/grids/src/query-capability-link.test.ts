import { expect, test } from "bun:test";
import { queryCapabilityHref } from "./query-capability-link";

test("query links preserve explicit source and punctuation", () => {
  const query = "from table {Table1}\nsearch 'a & b'\nlimit 10";
  const href = queryCapabilityHref({ baseId: "Base01", query });
  expect(href).toBeDefined();
  expect(new URL(href!, "https://example.test").searchParams.get("q")).toBe(query);
});
test("implicit table and view sources travel with the link", () => {
  for (const currentSource of [
    { kind: "table", tableId: "Table1" },
    { kind: "view", viewId: "View01" },
  ] as const) {
    const href = queryCapabilityHref({ baseId: "Base01", query: "limit 5", currentSource });
    expect(new URL(href!, "https://example.test").searchParams.get("q")).toBe(
      `from ${currentSource.kind} {${currentSource.kind === "table" ? currentSource.tableId : currentSource.viewId}}\nlimit 5`,
    );
  }
});
test("missing source, invalid and oversized queries never become misleading links", () => {
  expect(queryCapabilityHref({ baseId: "Base01", query: "limit 5" })).toBeUndefined();
  expect(queryCapabilityHref({ baseId: "Base01", query: "this is not GQL" })).toBeUndefined();
  expect(queryCapabilityHref({ baseId: "Base01", query: `from table {Table1}\nsearch '${"a".repeat(3000)}'` })).toBeUndefined();
});
