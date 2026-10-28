import { describe, expect, test } from "bun:test";
import { AiRequestHeadersSchema, patchAiRequestHeaders } from "../shared/ai-request-options";

describe("write-only request headers", () => {
  test("patches case-insensitively, removes nulls, keeps omitted names and canonicalizes Authorization", () => {
    expect(
      patchAiRequestHeaders(
        { "X-Token": "old", "X-Keep": "keep", "X-Remove": "remove" },
        { "x-token": "new", "X-Remove": null, authorization: "secret" },
      ),
    ).toEqual({ "x-token": "new", "X-Keep": "keep", Authorization: "secret" });
    expect(patchAiRequestHeaders({ "X-Token": "secret" }, {})).toEqual({ "X-Token": "secret" });
  });

  test("rejects reserved names, invalid tokens/values, duplicates and limits without echoing values", () => {
    for (const headers of [
      { "Content-Type": "secret" },
      { HOST: "secret" },
      { "content-length": "1" },
      { Connection: "secret" },
      { "Transfer-Encoding": "secret" },
      { "bad name": "secret" },
      { ["a".repeat(129)]: "secret" },
      { "X-Key": "secret", "x-key": "secret" },
      { "X-Key": "secret\r\ninjected" },
      { "X-Key": "secret\0" },
      { "X-Key": "private-token\u{1F600}" },
      { "X-Key": "tok\u200Bsecret" },
      { "X-Key": "caf☃-secret" },
      { "X-Key": "secret\u0001" },
      { "X-Key": "secreté" },
      { "X-Key": "x".repeat(4097) },
      { "X-Key": 123 },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, "secret"])),
      [],
      null,
    ]) {
      const parsed = AiRequestHeadersSchema.safeParse(headers);
      expect(parsed.success).toBeFalse();
      if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).not.toContain("secret");
    }
    expect(
      AiRequestHeadersSchema.safeParse({ Authorization: "Bearer custom", "X-Tab": "custom\tvalue", "X-Empty": "", "X-Delete": null })
        .success,
    ).toBeTrue();
  });
});
