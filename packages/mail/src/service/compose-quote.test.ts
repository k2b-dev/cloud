import { expect, test } from "bun:test";
import { quoteReplyBody } from "../compose-quotation";
import { draftEditableContentInputSchema } from "../contracts";
import { serializeMailDraftContent } from "../frontend/_components/mail-draft-journal";
import { createDraftDocument, readDraftDocument, writeLocalDraftHeaders } from "../lib/draft-document";
import { sha256Json } from "./canonical";
import { type ComposeRenderContext, renderComposeContent } from "./compose-renderer";
import { outboundDraftSnapshotSchema } from "./outbound-mime";

const context: ComposeRenderContext = {
  actor: { display_name: "Ada", email: "ada@example.test" },
  mailbox: { name: "Support", description: "" },
  sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
  message: { subject: "Reply", to: [], cc: [] },
};
const sourceQuote = quoteReplyBody(
  {
    from: [{ name: "Reader", address: "reader@example.test" }],
    to: [],
    subject: "Hello",
    internalDate: "2026-10-20T06:00:00.000Z",
    plainText: "Original",
  },
  "Original\n{{ actor.email }}",
  { locale: "en", timeZone: "UTC" },
);

for (const format of ["plain", "markdown"] as const) {
  test(`${format}: quote is opt-in, follows the signature, and never evaluates source templates`, () => {
    const input = {
      body: "Reply",
      format,
      context,
      customCss: "",
      renderLiquid: true,
      signature: "Regards {{ actor.display_name }}",
      sourceQuote,
    };
    const off = renderComposeContent(input);
    const explicitOff = renderComposeContent({ ...input, quoteSource: false });
    expect(off).toEqual(explicitOff);
    if (!off.ok) throw new Error(off.error.message);
    expect(off.data.text).not.toContain("Original");
    const on = renderComposeContent({ ...input, quoteSource: true });
    if (!on.ok) throw new Error(on.error.message);
    expect(on.data.text.indexOf("Regards Ada")).toBeGreaterThan(on.data.text.indexOf("Reply"));
    expect(on.data.text.indexOf("Original")).toBeGreaterThan(on.data.text.indexOf("Regards Ada"));
    expect(on.data.text).toContain("{{ actor.email }}");
    expect(on.data.text).not.toContain("ada@example.test");
    expect(renderComposeContent({ ...input, quoteSource: true, sourceQuote: null })).toEqual(off);
  });
}

test("shared settings, journals and recovery content retain quote changes", () => {
  const content = draftEditableContentInputSchema.parse({ senderIdentityId: "Send01", signatureTemplateId: null, body: "Reply" });
  const doc = createDraftDocument(content);
  try {
    expect(readDraftDocument(doc).quoteSource).toBe(false);
    writeLocalDraftHeaders(doc, content, { ...content, quoteSource: true });
    const quoted = readDraftDocument(doc);
    expect(quoted.quoteSource).toBe(true);
    expect(serializeMailDraftContent(quoted)).not.toBe(serializeMailDraftContent(content));
    const { quoteSource: _, signatureTemplateId, ...old } = content;
    expect(serializeMailDraftContent(content)).toBe(JSON.stringify({ ...old, signatureTemplateId: null }));
  } finally {
    doc.destroy();
  }
});

test("send hashes include opt-in even without source text and keep legacy off snapshots unchanged", () => {
  const legacy = outboundDraftSnapshotSchema.parse({
    revision: 1,
    from: { name: "Support", address: "support@example.test" },
    replyTo: null,
    envelopeFrom: null,
    to: [{ address: "reader@example.test" }],
    cc: [],
    bcc: [],
    subject: "Reply",
    body: "Reply",
    format: "plain",
    renderedText: "Reply",
    renderedHtml: null,
  });
  expect(Object.hasOwn(legacy, "quoteSource")).toBe(false);
  const off = outboundDraftSnapshotSchema.parse(legacy);
  expect(sha256Json(off)).toBe(sha256Json(legacy));
  const on = outboundDraftSnapshotSchema.parse({ ...legacy, quoteSource: true });
  expect(sha256Json(on)).not.toBe(sha256Json(legacy));
});

test("an unfinished code fence in the reply cannot move the automatic quote before the signature", () => {
  const rendered = renderComposeContent({
    body: "Reply\n\n```text\nUnfinished code",
    format: "markdown",
    context,
    customCss: "",
    renderLiquid: true,
    signature: "Regards Ada",
    quoteSource: true,
    sourceQuote,
  });
  if (!rendered.ok) throw new Error(rendered.error.message);
  expect(rendered.data.text.indexOf("Original")).toBeGreaterThan(rendered.data.text.indexOf("Regards Ada"));
  expect(rendered.data.html).toContain("<blockquote");
});
