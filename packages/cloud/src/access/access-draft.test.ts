import { expect, test } from "bun:test";
import type { AccessEntry } from "../contracts/shared";
import {
  addPrincipal,
  applied,
  draftChanges,
  draftRows,
  emptyDraft,
  lastManagerKeys,
  removeRow,
  restoreRow,
  saveOrder,
  setLevel,
} from "./access-draft";

const entry = (id: string, userId: string, permission: AccessEntry["permission"], displayName: string): AccessEntry => ({
  id,
  principal: { type: "user", userId },
  permission,
  createdAt: "2026-11-03T00:00:00.000Z",
  displayName,
});
const mia = entry("11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "admin", "Mia");
const lea = entry("22222222-2222-4222-8222-222222222222", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "read", "Lea");
const tom = { type: "user" as const, userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };

test("nothing changes before saving, and every pending change is listed once", () => {
  let draft = emptyDraft([mia, lea]);
  expect(draftChanges(draft)).toEqual([]);
  const [, leaRow] = draftRows(draft);
  draft = setLevel(draft, leaRow!, { permission: "write" });
  draft = addPrincipal(draft, tom, { displayName: "Tom" }, { permission: "write" });
  draft = addPrincipal(draft, { type: "authenticated" }, { displayName: "" }, { permission: "read" });
  expect(draft.base).toEqual([mia, lea]);
  expect(draftChanges(draft).map((change) => [change.kind, change.row.display.displayName || change.row.principal.type])).toEqual([
    ["change", "Lea"],
    ["add", "Tom"],
    ["add", "authenticated"],
  ]);
  // Choosing the stored level again is no change.
  draft = setLevel(draft, draftRows(draft)[1]!, { permission: "read" });
  expect(draftChanges(draft).map((change) => change.kind)).toEqual(["add", "add"]);
});

test("removing marks a stored row, undo restores it, and removing an added row drops it", () => {
  let draft = removeRow(emptyDraft([mia, lea]), draftRows(emptyDraft([mia, lea]))[1]!);
  expect(draftRows(draft)[1]!.next).toBeNull();
  expect(draftChanges(draft)).toMatchObject([{ kind: "remove", from: { permission: "read" } }]);
  draft = restoreRow(draft, draftRows(draft)[1]!);
  expect(draftChanges(draft)).toEqual([]);
  draft = addPrincipal(draft, tom, { displayName: "Tom" }, { permission: "read" });
  draft = removeRow(draft, draftRows(draft)[2]!);
  expect(draftRows(draft)).toHaveLength(2);
  // Adding a removed principal again brings its stored row back.
  draft = removeRow(draft, draftRows(draft)[1]!);
  draft = addPrincipal(draft, lea.principal, { displayName: "Lea" }, { permission: "write" });
  expect(draftChanges(draft)).toMatchObject([{ kind: "change", to: { permission: "write" } }]);
});

test("the only manager after saving is protected, counted on the result and not on the stored list", () => {
  let draft = emptyDraft([mia, lea]);
  expect([...lastManagerKeys(draft)]).toEqual([`u:${mia.principal.type === "user" ? mia.principal.userId : ""}`]);
  draft = setLevel(draft, draftRows(draft)[1]!, { permission: "admin" });
  expect(lastManagerKeys(draft).size).toBe(0);
  // Signed-in people with Manage keep the resource manageable like a person.
  draft = addPrincipal(emptyDraft([mia]), { type: "authenticated" }, { displayName: "" }, { permission: "admin" });
  expect(lastManagerKeys(draft).size).toBe(0);
});

test("saving adds first and removes last; each saved change leaves only the open ones", () => {
  let draft = emptyDraft([mia, lea]);
  draft = removeRow(draft, draftRows(draft)[1]!);
  draft = setLevel(draft, draftRows(draft)[0]!, { permission: "write" });
  draft = addPrincipal(draft, tom, { displayName: "Tom" }, { permission: "admin" });
  const order = saveOrder(draftChanges(draft));
  expect(order.map((change) => change.kind)).toEqual(["add", "change", "remove"]);
  const saved: AccessEntry = { id: "33333333-3333-4333-8333-333333333333", principal: tom, permission: "admin", createdAt: "now" };
  draft = applied(draft, order[0]!, saved);
  expect(draftChanges(draft).map((change) => change.kind)).toEqual(["change", "remove"]);
  draft = applied(draft, order[1]!);
  expect(draft.base.find((stored) => stored.id === mia.id)?.permission).toBe("write");
  expect(draftChanges(draft).map((change) => change.kind)).toEqual(["remove"]);
  draft = applied(draft, order[2]!);
  expect(draftChanges(draft)).toEqual([]);
  expect(draft.base.map((stored) => stored.id)).toEqual([mia.id, saved.id]);
});
