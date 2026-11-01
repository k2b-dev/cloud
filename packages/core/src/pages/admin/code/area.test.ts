import { expect, test } from "bun:test";
import { decodeCodeAdminCursor, encodeCodeAdminCursor } from "../../../code/admin";
import { codeAreaHref, codeAreaLevel, parseCodeAreaQuery } from "./area";

test("the URL keeps only valid selections, so reload and back return to the same place", () => {
  const id = "a0000000-0000-4000-8000-000000000003";
  expect(parseCodeAreaQuery({})).toEqual({});
  expect(parseCodeAreaQuery({ sec: "nope", id })).toEqual({});
  expect(parseCodeAreaQuery({ sec: "approvals", id, tab: "decided" })).toEqual({ sec: "approvals", id, tab: "decided" });
  expect(parseCodeAreaQuery({ sec: "approvals", id: "c_abcd" })).toEqual({ sec: "approvals" });
  expect(parseCodeAreaQuery({ sec: "code", id: "c_abcd", status: "paused", app: "mail", q: "  Bericht " })).toEqual({
    sec: "code",
    id: "c_abcd",
    status: "paused",
    app: "mail",
    q: "Bericht",
  });
  expect(parseCodeAreaQuery({ sec: "code", status: "gone", app: "Not An App" })).toEqual({ sec: "code" });
  expect(parseCodeAreaQuery({ sec: "code", id: "c_abcd", version: id })).toEqual({ sec: "code", id: "c_abcd", version: id });
  expect(parseCodeAreaQuery({ sec: "code", id: "c_abcd", version: "x" })).toEqual({ sec: "code", id: "c_abcd" });
  expect(parseCodeAreaQuery({ sec: "code", version: id })).toEqual({ sec: "code" });
  expect(parseCodeAreaQuery({ sec: "policy", id })).toEqual({ sec: "policy" });
  expect(codeAreaHref({ sec: "code", status: "paused", id: undefined })).toBe("/admin/code?sec=code&status=paused");
  expect(codeAreaHref({})).toBe("/admin/code");
  expect(codeAreaLevel({ sec: "groups", id })).toBe("detail");
  expect(codeAreaLevel({ sec: "groups" })).toBe("section");
  expect(codeAreaLevel({})).toBe("area");
});

test("page cursors survive the URL, also for the longest Unicode titles", () => {
  for (const title of ["🧑‍💻".repeat(40), "\u0001".repeat(200), "Ü".repeat(200)]) {
    const after = encodeCodeAdminCursor({ title, id: "c_abcdefghijklmnop" });
    expect(parseCodeAreaQuery({ sec: "code", after })).toEqual({ sec: "code", after });
    expect(decodeCodeAdminCursor(after)).toEqual({ title, id: "c_abcdefghijklmnop" });
  }
  const approvalCursor = "2026-11-01T11:10:00.123456Z|e0000000-0000-4000-8000-000000000001";
  expect(parseCodeAreaQuery({ sec: "approvals", after: approvalCursor })).toEqual({ sec: "approvals", after: approvalCursor });
  expect(parseCodeAreaQuery({ sec: "approvals", tab: "decided", after: approvalCursor })).toEqual({ sec: "approvals", tab: "decided" });
  expect(parseCodeAreaQuery({ sec: "cleanup", after: "e0000000-0000-4000-8000-000000000001" })).toMatchObject({
    after: "e0000000-0000-4000-8000-000000000001",
  });
  expect(parseCodeAreaQuery({ sec: "cleanup", after: "x" })).toEqual({ sec: "cleanup" });
});
