import { expect, test } from "bun:test";
import { checkImageEditorMessages } from "./messages";

test("image editor English and German cover the same controls and recovery states", () => {
  expect(checkImageEditorMessages()).toEqual([]);
});
