import { expect, test } from "bun:test";
import { StoreFullError } from "@k2b/sync";
import { draftEditModeSchema } from "../contracts";
import { isDraftDocumentStreamFull, sharedDraftsSupported } from "./draft-documents";

test("shared activation remains disabled until retention and the deployed stream are verified", async () => {
  expect(await sharedDraftsSupported()).toBe(false);
  expect(draftEditModeSchema.parse("lock")).toBe("lock");
  expect(draftEditModeSchema.parse("shared")).toBe("shared");
  expect(draftEditModeSchema.safeParse("automatic").success).toBe(false);
});

test("the full-stream adapter recognizes typed rejections and does not guess from unrelated messages", () => {
  expect(isDraftDocumentStreamFull(new StoreFullError("Full"))).toBe(true);
  expect(isDraftDocumentStreamFull(new Error("Stream full / rejected"))).toBe(false);
  expect(isDraftDocumentStreamFull({ code: "CONFLICT" })).toBe(false);
  expect(isDraftDocumentStreamFull(null)).toBe(false);
});
