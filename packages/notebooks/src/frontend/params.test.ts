import { expect, test } from "bun:test";
import { buildAttachmentsUrl, buildNoteUrl, buildTagPageUrl } from "./params";

test.each(["write", "readonly", "book"] as const)("workspace URLs preserve explicit %s presentation", (mode) => {
  expect(buildNoteUrl("book01", "note01", mode)).toBe(`/app/notebooks/book01/notes/note01?mode=${mode}`);
  expect(buildAttachmentsUrl("book01", mode)).toBe(`/app/notebooks/book01/attachments?mode=${mode}`);
  expect(buildTagPageUrl("book01", "team/news", mode)).toBe(`/app/notebooks/book01/tags/team%2Fnews?mode=${mode}`);
});

test("unselected presentation leaves workspace URLs at notebook defaults", () => {
  expect(buildNoteUrl("book01", "note01")).toBe("/app/notebooks/book01/notes/note01");
  expect(buildAttachmentsUrl("book01")).toBe("/app/notebooks/book01/attachments");
  expect(buildTagPageUrl("book01", "team/news")).toBe("/app/notebooks/book01/tags/team%2Fnews");
});
