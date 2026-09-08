import { describe, expect, test } from "bun:test";
import { createDocumentGenerationAttempt } from "./document-generation-attempt";

describe("document generation attempts", () => {
  test("retries preserve the original payload and key after form values change", () => {
    const attempt = createDocumentGenerationAttempt();
    const tags = ["original"];
    const first = attempt.start({ templateId: "tpl001", recordId: "rec001", filename: "original.pdf", tags });
    tags.push("changed");

    const retry = attempt.start({ templateId: "tpl002", recordId: "rec002", filename: "changed.pdf", tags: ["new"] });

    expect(retry).toBe(first);
    expect(retry).toEqual({
      templateId: "tpl001",
      recordId: "rec001",
      filename: "original.pdf",
      tags: ["original"],
      idempotencyKey: first.idempotencyKey,
    });
    expect(first.idempotencyKey).toBeTruthy();
    expect(attempt.request()).toBe(first);
  });

  test("an explicit reset permits corrected inputs under a fresh key", () => {
    const attempt = createDocumentGenerationAttempt();
    expect(attempt.request()).toBeNull();
    const first = attempt.start({ templateId: "tpl001", recordId: "rec001", filename: "invalid.pdf" });

    attempt.reset();
    expect(attempt.request()).toBeNull();
    const next = attempt.start({ templateId: "tpl001", recordId: "rec002", filename: "corrected.pdf" });

    expect(next.recordId).toBe("rec002");
    expect(next.filename).toBe("corrected.pdf");
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
