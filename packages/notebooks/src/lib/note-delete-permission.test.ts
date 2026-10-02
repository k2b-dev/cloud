import { expect, test } from "bun:test";
import { isNoteDeletePermission, mayDeleteNotes } from "./note-delete-permission";

test("everyone who can write deletes notes by default; the admin rule leaves only admins", () => {
  expect(["none", "read", "write", "admin"].map((permission) => mayDeleteNotes(permission, "write"))).toEqual([false, false, true, true]);
  expect(["none", "read", "write", "admin"].map((permission) => mayDeleteNotes(permission, "admin"))).toEqual([false, false, false, true]);
});

test("only write and admin are note deletion rules", () => {
  expect(["write", "admin", "read", "none", "", undefined].map(isNoteDeletePermission)).toEqual([true, true, false, false, false, false]);
});
