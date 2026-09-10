import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import {
  buildDraftProviderMimeStream,
  draftProviderContentSchema,
  draftProviderFingerprint,
  draftProviderMessageId,
} from "./draft-provider-mime";

const snapshotId = "00000000-0000-4000-8000-000000000001";
const draftId = "00000000-0000-4000-8000-000000000002";
const attachmentId = "00000000-0000-4000-8000-000000000003";
const blobId = "00000000-0000-4000-8000-000000000004";

describe("draft provider MIME", () => {
  test("preserves editable recipients and stable projection headers", async () => {
    const content = draftProviderContentSchema.parse({
      revision: 7,
      senderIdentityId: "00000000-0000-4000-8000-000000000005",
      from: { name: "Support", address: "support@example.com" },
      replyTo: "replies@example.com",
      to: [{ name: "Alice", address: "alice@example.com" }],
      cc: [],
      bcc: [{ name: "Audit", address: "audit@example.com" }],
      subject: "Draft subject",
      body: "Hello **Alice**",
      format: "markdown",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
      attachments: [],
    });
    const fingerprint = draftProviderFingerprint(content);
    const messageId = draftProviderMessageId(snapshotId);
    const source = buildDraftProviderMimeStream({
      snapshotId,
      draftId,
      content,
      fingerprint,
      messageId,
      date: new Date("2026-07-20T10:00:00.000Z"),
      openAttachment: () => {
        throw new Error("Unexpected attachment");
      },
    });
    const parsed = await simpleParser(source);
    const bcc = Array.isArray(parsed.bcc) ? parsed.bcc[0] : parsed.bcc;

    expect(parsed.messageId).toBe(messageId);
    expect(bcc?.value[0]?.address).toBe("audit@example.com");
    expect(parsed.headers.get("x-cloud-draft-id")).toBe(draftId);
    expect(parsed.headers.get("x-cloud-draft-revision")).toBe("7");
    expect(parsed.headers.get("x-cloud-draft-snapshot")).toBe(snapshotId);
    expect(parsed.headers.get("x-cloud-draft-fingerprint")).toBe(fingerprint);
    expect(parsed.headers.get("x-cloud-draft-format")).toBe("markdown");
    expect(parsed.text?.trim()).toBe("Hello **Alice**");
    expect(parsed.html).toContain("<strong>Alice</strong>");
  });

  test("streams attachments without loading them in the renderer", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
    const content = draftProviderContentSchema.parse({
      revision: 1,
      senderIdentityId: "00000000-0000-4000-8000-000000000005",
      from: { name: "", address: "sender@example.com" },
      replyTo: null,
      to: [{ name: null, address: "recipient@example.com" }],
      cc: [],
      bcc: [],
      subject: "Attachment",
      body: "Attached.",
      format: "plain",
      inReplyTo: null,
      references: [],
      attachments: [
        {
          id: attachmentId,
          blobId,
          filename: "payload.bin",
          contentType: "application/octet-stream",
          byteLength: bytes.length,
          contentHash: "a".repeat(64),
        },
      ],
    });
    let opened = 0;
    const parsed = await simpleParser(
      buildDraftProviderMimeStream({
        snapshotId,
        draftId,
        content,
        fingerprint: draftProviderFingerprint(content),
        messageId: draftProviderMessageId(snapshotId),
        date: new Date("2026-07-20T10:00:00.000Z"),
        openAttachment: (requestedBlobId) => {
          expect(requestedBlobId).toBe(blobId);
          opened += 1;
          return Readable.from(
            (async function* () {
              for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
                yield bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
              }
            })(),
          );
        },
      }),
    );

    expect(opened).toBe(1);
    expect(parsed.attachments[0]?.content.equals(bytes)).toBe(true);
  });

  test("clamps thread references instead of rejecting the draft", () => {
    const overlong = `<${"x".repeat(1_200)}@example.com>`;
    const content = draftProviderContentSchema.parse({
      revision: 1,
      senderIdentityId: "00000000-0000-4000-8000-000000000005",
      from: { name: "", address: "sender@example.com" },
      replyTo: null,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "A",
      format: "plain",
      inReplyTo: overlong,
      references: [...Array.from({ length: 600 }, (_, index) => `<thread-${index}@example.com>`), overlong, "<parent@example.com>"],
      attachments: [],
    });

    expect(content.references).toHaveLength(500);
    expect(content.references.at(-1)).toBe("<parent@example.com>");
    expect(content.references.at(0)).toBe("<thread-101@example.com>");
    expect(content.references).not.toContain(overlong);
    expect(content.inReplyTo).toBeNull();
  });

  test("fingerprint changes only when editable content changes", () => {
    const content = draftProviderContentSchema.parse({
      revision: 1,
      senderIdentityId: "00000000-0000-4000-8000-000000000005",
      from: { name: "", address: "sender@example.com" },
      replyTo: null,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "A",
      format: "plain",
      inReplyTo: null,
      references: [],
      attachments: [],
    });
    expect(draftProviderFingerprint({ ...content, revision: 2 })).toBe(draftProviderFingerprint(content));
    expect(draftProviderFingerprint({ ...content, body: "B" })).not.toBe(draftProviderFingerprint(content));
  });
});
