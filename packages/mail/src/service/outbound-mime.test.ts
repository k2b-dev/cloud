import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import { renderComposeContent } from "./compose-renderer";
import { buildMimeSource, buildMimeStream, measureMimeStream, outboundDraftSnapshotSchema, outboundRecipients } from "./outbound-mime";

describe("outbound MIME", () => {
  test("keeps Markdown quotes and code blocks in the HTML fallback (#932)", async () => {
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.com" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: null, address: "alice@example.com" }],
      cc: [],
      bcc: [],
      subject: "Quoted code",
      body: "> quoted line\n> second\n\n```ts\nconst a = 1;\nconst b = 2;\n```",
      format: "markdown",
    });
    const parsed = await simpleParser(
      await buildMimeSource({ snapshot, messageId: "<quoted-code@example.com>", date: new Date("2026-01-02T03:04:05.000Z") }),
    );

    expect(parsed.html).toContain("<blockquote>\n<p>quoted line<br />second</p>\n</blockquote>");
    expect(parsed.html).toContain("<pre>const a = 1;\nconst b = 2;</pre>");
    expect(parsed.html).not.toContain("<span>ts</span>");
    expect(parsed.html).not.toContain(">ts<");
  });

  test.each([false, true])("keeps Mail formatting and literal formulas in MIME with rendered snapshot %s", async (preRendered) => {
    const body = "~~old~~\n\n---\n\n| Item | Formula |\n| :---: | ---: |\n| A | =1+2 |";
    const rendered = renderComposeContent({
      body,
      format: "markdown",
      customCss: "",
      renderLiquid: false,
      context: {
        actor: { display_name: "Ada", email: "ada@example.test" },
        mailbox: { name: "Support", description: "" },
        sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
        message: { subject: "Formatting", to: ["alice@example.test"], cc: [] },
      },
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.test" },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: null, address: "alice@example.test" }],
      cc: [],
      bcc: [],
      subject: "Formatting",
      body,
      format: "markdown",
      ...(preRendered ? { renderedHtml: rendered.data.html, renderedText: rendered.data.text } : {}),
    });
    const parsed = await simpleParser(
      await buildMimeSource({ snapshot, messageId: "<formatting@example.test>", date: new Date("2026-01-02T03:04:05.000Z") }),
    );
    expect(parsed.html).toContain("<del>old</del>");
    expect(parsed.html).toContain("<hr");
    expect(parsed.html).toContain('align="center"');
    expect(parsed.html).toContain('align="right"');
    expect(parsed.html).toContain("=1+2");
    expect(parsed.html).not.toMatch(/md-formula|ti-math-function/);
    expect(parsed.text).toBe(preRendered ? rendered.data.text : body);
  });

  test("keeps table cells and rows separate in the plain-text MIME alternative", async () => {
    const body =
      "Before\n\n| Item | Quantity | Note |\n| --- | --- | --- |\n| Chair | 2 | [Details](https://example.test/chair) |\n| Desk | 1 | |\n\nAfter";
    const rendered = renderComposeContent({
      body,
      format: "markdown",
      customCss: "",
      renderLiquid: false,
      context: {
        actor: { display_name: "Ada", email: "ada@example.test" },
        mailbox: { name: "Support", description: "" },
        sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
        message: { subject: "Order", to: ["reader@example.test"], cc: [] },
      },
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    const snapshot = outboundDraftSnapshotSchema.parse({
      revision: 1,
      from: { name: "Support", address: "support@example.test" },
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      replyTo: null,
      envelopeFrom: null,
      subject: "Order",
      body,
      format: "markdown",
      renderedHtml: rendered.data.html,
      renderedText: rendered.data.text,
    });
    const parsed = await simpleParser(
      await buildMimeSource({ snapshot, messageId: "<table@example.test>", date: new Date("2026-01-02T03:04:05.000Z") }),
    );
    expect(parsed.text).toMatch(/Item +Quantity +Note/);
    expect(parsed.text).toMatch(/Chair +2 +Details \[https:\/\/example.test\/chair\]/);
    expect(parsed.text).toMatch(/\nDesk +1(?: +)?\n/);
    expect(parsed.text).toMatch(/^Before\n\n/);
    expect(parsed.text).toMatch(/\n\nAfter$/);
    expect(parsed.html).toContain("<table");
    expect(parsed.html).toContain(">Chair</span></td>");
    expect(parsed.html).toContain(">Desk</span></td>");
  });

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

test("remote content in mail: a frozen logo is a related inline part with the same CID as HTML", async () => {
  const content = Buffer.from("frozen logo bytes");
  const contentId = "logo.00000000-0000-4000-8000-000000000001@example.test";
  const rendered = renderComposeContent({
    body: "Hello",
    format: "markdown",
    customCss: "",
    context: {
      actor: { display_name: "Ada", email: "ada@example.test" },
      mailbox: { name: "Support", description: "" },
      sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
      message: { subject: "Inline logo", to: ["reader@example.test"], cc: [] },
    },
    renderLiquid: true,
    signature: "{{ mailbox.logo }}",
    logo: {
      src: `cid:${contentId}`,
      altText: "Support",
      displayWidth: 200,
      pixelWidth: 1200,
      pixelHeight: 400,
      byteLength: content.length,
    },
  });
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) return;
  const snapshot = outboundDraftSnapshotSchema.parse({
    revision: 1,
    from: { name: "Support", address: "support@example.test" },
    replyTo: null,
    envelopeFrom: null,
    to: [{ address: "reader@example.test", name: null }],
    cc: [],
    bcc: [],
    subject: "Inline logo",
    body: "Hello",
    format: "markdown",
    renderedHtml: rendered.data.html,
    renderedText: rendered.data.text,
    inlineLogo: {
      versionId: "00000000-0000-4000-8000-000000000001",
      sha256: "a".repeat(64),
      contentType: "image/png",
      byteLength: content.length,
      contentId,
    },
  });
  const source = await buildMimeSource({
    snapshot,
    inlineLogoContent: content,
    messageId: "<inline@example.test>",
    date: new Date("2026-01-02T03:04:05.000Z"),
  });
  const mime = source.toString();
  expect(mime).toContain("multipart/related");
  expect(mime).toContain(`Content-ID: <${contentId}>`);
  expect(mime).toContain("Content-Disposition: inline");
  expect(mime).not.toMatch(/src=["']https?:/i);
  const parsed = await simpleParser(source, { skipImageLinks: true });
  expect(parsed.html).toContain(`<img src="cid:${contentId}" alt="Support" width="200" height="67"`);
  expect(parsed.html).not.toMatch(/src=["']https?:/i);
  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0]).toMatchObject({
    contentId: `<${contentId}>`,
    contentDisposition: "inline",
    contentType: "image/png",
    content,
  });
  expect(
    await measureMimeStream({
      snapshot,
      inlineLogoContent: content,
      messageId: "<inline@example.test>",
      date: new Date("2026-01-02T03:04:05.000Z"),
      openAttachment: () => {
        throw new Error("No ordinary attachments");
      },
    }),
  ).toBe(source.byteLength);
  await expect(
    buildMimeSource({ snapshot, messageId: "<missing@example.test>", date: new Date("2026-01-02T03:04:05.000Z") }),
  ).rejects.toMatchObject({ code: "INLINE_LOGO_UNAVAILABLE" });
  const plain = outboundDraftSnapshotSchema.parse({ ...snapshot, format: "plain", renderedHtml: null });
  const plainMime = await simpleParser(
    await buildMimeSource({ snapshot: plain, messageId: "<plain@example.test>", date: new Date("2026-01-02T03:04:05.000Z") }),
  );
  expect(plainMime.attachments).toHaveLength(0);
});
