import { describe, expect, test } from "bun:test";
import { publicAttachmentMessages } from "./public-attachment-messages";

describe("public attachment messages", () => {
  test("keeps German complete and inherits regional locales", () => {
    expect(publicAttachmentMessages.check()).toEqual([]);
    expect(publicAttachmentMessages.resolve(["de-CH"]).t.unlock).toBe("Download freigeben");
  });

  test("falls back to English", () => {
    expect(publicAttachmentMessages.resolve(["fr"]).t.unlock).toBe("Unlock download");
  });
});
