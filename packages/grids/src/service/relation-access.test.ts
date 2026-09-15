import { expect, test } from "bun:test";
import { type ExpansionViewer, resolveReadableTableIds } from "./relation-access";

test("execution authority applies only to candidate tables, including authoritative denials", async () => {
  const requested: string[] = [];
  const viewer: ExpansionViewer = {
    userId: "app-reader",
    userGroups: [],
    readableTableIds: new Set(["allowed", "denied"]),
    authorizeTable: async (tableId) => {
      requested.push(tableId);
      return tableId === "allowed";
    },
  };
  expect(await resolveReadableTableIds(["allowed", "denied", "outside", "allowed"], viewer)).toEqual(new Set(["allowed"]));
  expect(requested.sort()).toEqual(["allowed", "denied"]);
  expect(viewer.tableReadAccess?.get("denied")).toBe(false);
  expect(viewer.tableReadAccess?.get("outside")).toBe(false);
  expect(await resolveReadableTableIds(["denied", "allowed"], viewer)).toEqual(new Set(["allowed"]));
  expect(requested).toHaveLength(2);
});

test("failed authority checks fail closed instead of falling back to Base grants", async () => {
  const viewer: ExpansionViewer = {
    userId: "app-reader",
    userGroups: [],
    authorizeTable: async () => {
      throw new Error("execution scope unavailable");
    },
  };
  await expect(resolveReadableTableIds(["target"], viewer)).rejects.toThrow("execution scope unavailable");
  expect(viewer.tableReadAccess?.has("target")).toBe(false);
});
