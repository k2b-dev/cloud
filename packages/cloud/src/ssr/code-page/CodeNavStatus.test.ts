import { expect, test } from "bun:test";
import { codeNavAttentionLabel } from "./CodeNavStatus";

test("Code navigation keeps its attention label localized, including the base-locale fallback", () => {
  expect(codeNavAttentionLabel("en")).toBe("Code needs attention");
  expect(codeNavAttentionLabel("de")).toBe("Code braucht Aufmerksamkeit");
  expect(codeNavAttentionLabel("fr")).toBe("Code needs attention");
});
