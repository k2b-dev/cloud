import { expect, test } from "bun:test";
import { aiDraftText, editAiDraftText } from "./draft-content";
import type { AiDraftContentPart } from "./types";

test("queue edits retain untouched identities and remove an edited mention", () => {
  const skill: AiDraftContentPart = { type: "resource", ref: { type: "core.ai.skill", id: "Sk2345" }, title: "Invoices", inline: true };
  const file: AiDraftContentPart = { type: "file", path: "/bill.pdf", mediaType: "application/pdf", version: 2, size: 10 };
  const content: AiDraftContentPart[] = [{ type: "text", text: "Use " }, skill, { type: "text", text: " now" }, file];
  expect(aiDraftText(content)).toBe("Use Invoices now");
  expect(editAiDraftText(content, "Please use Invoices now")).toEqual([
    { type: "text", text: "Please use " },
    skill,
    { type: "text", text: " now" },
    file,
  ]);
  expect(editAiDraftText(content, "Use something else")).toEqual([{ type: "text", text: "Use something else" }, file]);
});
