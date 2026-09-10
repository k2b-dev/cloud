import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import { buildMimeSource, buildMimeStream, measureMimeStream, outboundDraftSnapshotSchema, outboundRecipients } from "./outbound-mime";

describe("outbound MIME", () => {
  test("builds a stable threaded multipart message without exposing Bcc", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 3,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: "Alice", address: "alice@example.com" }],
      cc: [],
      bcc: [{ name: null, address: "audit@example.com" }],
      subject: "Re: Request",
      body: "Hello **Alice**\n\n<script>alert('xss')</script>\n\n[unsafe](javascript:alert(1))",
      format: "markdown",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
    });
    const source = await buildMimeSource({
      snapshot,
      messageId: "<stable@example.com>",
      date: new Date("2026-01-02T03:04:05.000Z"),
    });
    const parsed = await simpleParser(source);
    expect(parsed.messageId).toBe("<stable@example.com>");
    expect(parsed.inReplyTo).toBe("<parent@example.com>");
    expect(parsed.text).toContain("Hello **Alice**");
    expect(parsed.html).toContain("<strong>Alice</strong>");
    expect(parsed.html).not.toContain("<script");
    expect(parsed.html).not.toContain("javascript:");
    expect(source.toString("utf8")).not.toMatch(/^Bcc:/im);
    expect(outboundRecipients(snapshot)).toEqual(["alice@example.com", "audit@example.com"]);
  });

  test("keeps Bcc only in the sender's own Sent copy", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: null, address: "alice@example.com" }],
      cc: [],
      bcc: [{ name: "Audit", address: "audit@example.com" }],
      subject: "Blind copy",
      body: "Hello",
      format: "plain",
      inReplyTo: null,
      references: [],
    });
    const build = async (keepBcc: boolean) => {
      const chunks: Buffer[] = [];
      for await (const value of buildMimeStream({
        snapshot,
        messageId: "<bcc@example.com>",
        date: new Date("2026-01-02T03:04:05.000Z"),
        openAttachment: () => Readable.from([]),
        keepBcc,
      })) {
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array));
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    expect(await build(false)).not.toMatch(/^Bcc:/im);
    const sentCopy = await build(true);
    expect(sentCopy).toMatch(/^Bcc: Audit <audit@example.com>$/im);
    expect(sentCopy).toMatch(/^To: alice@example.com$/im);
  });

  test("streams attachment content into MIME without changing bytes", async () => {
    const attachment = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let index = 0; index < attachment.length; index += 1) attachment[index] = (index * 31) % 256;
    const blobId = "00000000-0000-4000-8000-000000000001";
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: null, address: "alice@example.com" }],
      cc: [],
      bcc: [],
      subject: "Attachment stream",
      body: "Attached.",
      format: "plain",
      inReplyTo: null,
      references: [],
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          blobId,
          filename: "payload.bin",
          contentType: "application/octet-stream",
          byteLength: attachment.length,
          contentHash: "a".repeat(64),
        },
      ],
    });
    let opened = 0;
    const source = buildMimeStream({
      snapshot,
      messageId: "<attachment@example.com>",
      date: new Date("2026-07-12T12:00:00.000Z"),
      openAttachment: (requestedBlobId) => {
        expect(requestedBlobId).toBe(blobId);
        opened += 1;
        return Readable.from(
          (async function* () {
            for (let offset = 0; offset < attachment.length; offset += 64 * 1024) {
              yield attachment.subarray(offset, Math.min(offset + 64 * 1024, attachment.length));
            }
          })(),
        );
      },
    });
    const parsed = await simpleParser(source);

    expect(opened).toBe(1);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("payload.bin");
    expect(parsed.attachments[0]?.content.equals(attachment)).toBe(true);
  });

  test("measures the same encoded bytes that are sent", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: null, address: "alice@example.com" }],
      cc: [],
      bcc: [],
      subject: "Measured message",
      body: "The encoded payload is authoritative.",
      format: "plain",
    });
    const params = {
      snapshot,
      messageId: "<measured@example.com>",
      date: new Date("2026-07-24T10:00:00.000Z"),
      openAttachment: () => Readable.from([]),
    };
    const [source, measured] = await Promise.all([buildMimeSource(params), measureMimeStream(params)]);
    expect(measured).toBe(source.byteLength);
  });

  test("marks automatic replies without exposing blind recipients", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      useNullEnvelopeSender: true,
      automaticReply: true,
      to: [{ name: null, address: "customer@example.com" }],
      cc: [],
      bcc: [{ name: null, address: "audit@example.com" }],
      subject: "Re: Request",
      body: "We received your message.",
      format: "plain",
      inReplyTo: "<request@example.com>",
      references: ["<request@example.com>"],
    });
    const source = await buildMimeSource({
      snapshot,
      messageId: "<automatic-reply@example.com>",
      date: new Date("2026-07-17T09:00:00.000Z"),
    });
    const text = source.toString("utf8");
    expect(text).toMatch(/^Auto-Submitted: auto-replied$/im);
    expect(text).toMatch(/^X-Auto-Response-Suppress: All$/im);
    expect(text).not.toMatch(/^Bcc:/im);
  });

  test("emits frozen priority, MDN, and vCard identity options", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 4,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      priority: "high",
      requestReadReceipt: true,
      receiptAddress: "support@example.com",
      vcard: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Support\r\nEMAIL:support@example.com\r\nEND:VCARD",
      to: [{ name: null, address: "customer@example.com" }],
      cc: [],
      bcc: [],
      subject: "Priority request",
      body: "Please review.",
      format: "plain",
    });
    const source = await buildMimeSource({
      snapshot,
      messageId: "<priority@example.com>",
      date: new Date("2026-07-25T08:00:00.000Z"),
    });
    const raw = source.toString("utf8");
    const parsed = await simpleParser(source);

    expect(raw).toMatch(/^Importance: high$/im);
    expect(raw).toMatch(/^Priority: urgent$/im);
    expect(raw).toMatch(/^X-Priority: 1$/im);
    expect(raw).toMatch(/^Disposition-Notification-To: support@example.com$/im);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("contact.vcf");
    expect(parsed.attachments[0]?.content.toString("utf8")).toContain("EMAIL:support@example.com");
  });

  test("emits plaintext drafts without an HTML alternative", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: null, address: "customer@example.com" }],
      cc: [],
      bcc: [],
      subject: "Plain text",
      body: "This stays **plain**.",
      format: "plain",
      renderedText: "This stays **plain**.",
      renderedHtml: null,
      inReplyTo: null,
      references: [],
    });
    const source = await buildMimeSource({
      snapshot,
      messageId: "<plain@example.com>",
      date: new Date("2026-07-17T11:00:00.000Z"),
    });
    const raw = source.toString("utf8");
    const parsed = await simpleParser(source);

    expect(parsed.text?.trimEnd()).toBe("This stays **plain**.");
    expect(parsed.html).toBe(false);
    expect(raw).toMatch(/^Content-Type: text\/plain;/im);
    expect(raw).not.toMatch(/multipart\/alternative/i);
    expect(
      outboundDraftSnapshotSchema.safeParse({
        ...snapshot,
        renderedHtml: "<strong>This must not be sent</strong>",
      }).success,
    ).toBe(false);
  });

  test("uses frozen rendered output instead of re-rendering mutable source", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 2,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: null, address: "customer@example.com" }],
      cc: [],
      bcc: [],
      subject: "Frozen output",
      body: "Hello {{ actor.display_name }}",
      format: "markdown",
      renderedText: "Hello Ada",
      renderedHtml: '<div style="color:#123456"><p>Hello Ada</p></div>',
      inReplyTo: null,
      references: [],
    });
    const parsed = await simpleParser(
      await buildMimeSource({
        snapshot,
        messageId: "<frozen@example.com>",
        date: new Date("2026-07-17T10:00:00.000Z"),
      }),
    );

    expect(parsed.text).toBe("Hello Ada");
    expect(parsed.html).toContain("Hello Ada");
    expect(parsed.html).not.toContain("actor.display_name");
  });
});
