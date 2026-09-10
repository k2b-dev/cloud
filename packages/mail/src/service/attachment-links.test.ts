import { describe, expect, test } from "bun:test";
import {
  createAttachmentLink,
  hashAttachmentLinkToken,
  MAX_ATTACHMENT_LINK_FILE_BYTES,
  publicAttachmentLinkUrlForAppUrl,
} from "./attachment-links";

const NOW = new Date("2026-07-17T10:00:00.000Z");

const createLink = async (overrides: Partial<Parameters<typeof createAttachmentLink>[0]> = {}) => {
  const result = await createAttachmentLink({ fileSizeBytes: 1024, now: NOW, ...overrides });
  if (!result.ok) throw new Error(`Expected link creation to succeed, got ${result.code}`);
  return result;
};

describe("mail public attachment links", () => {
  test("requires HTTPS for non-local public origins", () => {
    expect(publicAttachmentLinkUrlForAppUrl("https://cloud.example.com/path", "token")).toBe(
      "https://cloud.example.com/path/share/mail/attachments/token",
    );
    expect(publicAttachmentLinkUrlForAppUrl("http://localhost:3000", "token")).toBe("http://localhost:3000/share/mail/attachments/token");
    expect(() => publicAttachmentLinkUrlForAppUrl("http://cloud.example.com", "token")).toThrow("must use HTTPS");
  });

  test("returns an opaque token once and keeps only its hash in persistent state", async () => {
    const first = await createLink();
    const second = await createLink();

    expect(first.publicToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.publicToken).not.toBe(second.publicToken);
    expect(first.persistent.tokenHash).toBe(hashAttachmentLinkToken(first.publicToken));
    expect(first.persistent.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.persistent.tokenHash).not.toContain(first.publicToken);
    expect(first.persistent).not.toHaveProperty("publicToken");
  });

  test("enforces the 100 MiB per-file boundary without an aggregate quota", async () => {
    expect((await createAttachmentLink({ fileSizeBytes: MAX_ATTACHMENT_LINK_FILE_BYTES, now: NOW })).ok).toBe(true);
    expect(await createAttachmentLink({ fileSizeBytes: MAX_ATTACHMENT_LINK_FILE_BYTES + 1, now: NOW })).toEqual({
      ok: false,
      code: "invalid_file_size",
    });
  });

  test("bounds password work and persisted download counters", async () => {
    expect(await createAttachmentLink({ fileSizeBytes: 1, now: NOW, password: "short" })).toEqual({
      ok: false,
      code: "invalid_password",
    });
    expect(await createAttachmentLink({ fileSizeBytes: 1, now: NOW, password: "x".repeat(257) })).toEqual({
      ok: false,
      code: "invalid_password",
    });
    expect(await createAttachmentLink({ fileSizeBytes: 1, now: NOW, maxDownloads: 1_000_001 })).toEqual({
      ok: false,
      code: "invalid_download_limit",
    });
  });

  test("hashes a password with Bun argon2id", async () => {
    const created = await createLink({ password: "correct horse battery staple" });
    expect(created.persistent.passwordHash).toStartWith("$argon2id$");
  });
});
