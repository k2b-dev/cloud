import { describe, expect, test } from "bun:test";
import { mailboxLogoContentId } from "./mailbox-logos";
import { inlineLogoSnapshotSchema } from "./outbound-mime";

describe("mailbox logo Content-ID", () => {
  const versionId = "00000000-0000-4000-8000-000000000001";
  test("lowercases ASCII sender domains and falls back for IDN or unsupported domains", () => {
    for (const [senderEmail, domain] of [
      ["team@EXAMPLE.TEST", "example.test"],
      ["team@mail.example-test.com", "mail.example-test.com"],
      ["team@xn--bcher-kva.test", "xn--bcher-kva.test"],
      ["team@bücher.test", "mail.invalid"],
      ["team@例え.test", "mail.invalid"],
      ["team@under_score.test", "mail.invalid"],
      ["team@[127.0.0.1]", "mail.invalid"],
      [`team@${"a".repeat(208)}.test`, `${"a".repeat(208)}.test`],
      [`team@${"a".repeat(209)}.test`, "mail.invalid"],
      ["team@", "mail.invalid"],
      ["team", "mail.invalid"],
    ] as const) {
      const contentId = mailboxLogoContentId(versionId, senderEmail);
      expect(contentId).toBe(`logo.${versionId}@${domain}`);
      expect(
        inlineLogoSnapshotSchema.safeParse({
          versionId,
          contentId,
          sha256: "a".repeat(64),
          contentType: "image/png",
          byteLength: 1,
        }).success,
      ).toBe(true);
    }
  });
});
