import { expect, test } from "bun:test";
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
  expect(parseCodeAreaQuery({ sec: "policy", id })).toEqual({ sec: "policy" });
  expect(codeAreaHref({ sec: "code", status: "paused", id: undefined })).toBe("/admin/code?sec=code&status=paused");
  expect(codeAreaHref({})).toBe("/admin/code");
  expect(codeAreaLevel({ sec: "groups", id })).toBe("detail");
  expect(codeAreaLevel({ sec: "groups" })).toBe("section");
  expect(codeAreaLevel({})).toBe("area");
});
