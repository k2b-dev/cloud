import { expect, test } from "bun:test";
import { quoteReplyBody } from "../compose-quotation";
import { draftEditableContentInputSchema, draftQuoteSourceSchema } from "../contracts";
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
    const explicitOff = renderComposeContent({ ...input, quoteSource: null });
    expect(off).toEqual(explicitOff);
    if (!off.ok) throw new Error(off.error.message);
    expect(off.data.text).not.toContain("Original");
    const on = renderComposeContent({ ...input, quoteSource: { locale: "de", timeZone: "Europe/Berlin" } });
    if (!on.ok) throw new Error(on.error.message);
    expect(on.data.text.indexOf("Regards Ada")).toBeGreaterThan(on.data.text.indexOf("Reply"));
    expect(on.data.text.indexOf("Original")).toBeGreaterThan(on.data.text.indexOf("Regards Ada"));
    expect(on.data.text).toContain("{{ actor.email }}");
    expect(on.data.text).not.toContain("ada@example.test");
    expect(renderComposeContent({ ...input, quoteSource: { locale: "de", timeZone: "Europe/Berlin" }, sourceQuote: null })).toEqual(off);
  });
}

test("shared settings, journals and recovery content retain quote changes", () => {
  const content = draftEditableContentInputSchema.parse({ senderIdentityId: "Send01", signatureTemplateId: null, body: "Reply" });
  const doc = createDraftDocument(content);
  try {
    expect(readDraftDocument(doc).quoteSource).toBeNull();
    writeLocalDraftHeaders(doc, content, { ...content, quoteSource: { locale: "de", timeZone: "Europe/Berlin" } });
    const quoted = readDraftDocument(doc);
    expect(quoted.quoteSource).toEqual({ locale: "de", timeZone: "Europe/Berlin" });
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
  const on = outboundDraftSnapshotSchema.parse({ ...legacy, quoteSource: { locale: "de", timeZone: "Europe/Berlin" } });
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
    quoteSource: { locale: "de", timeZone: "Europe/Berlin" },
    sourceQuote,
  });
  if (!rendered.ok) throw new Error(rendered.error.message);
  expect(rendered.data.text.indexOf("Original")).toBeGreaterThan(rendered.data.text.indexOf("Regards Ada"));
  expect(rendered.data.html).toContain("<blockquote");
});

test("quote context validates BCP-47 locales, resolves shipped languages and rejects invalid IANA zones", () => {
  for (const [locale, expected] of [
    ["de-CH", "de"],
    ["en-US", "en"],
    ["fr-FR", "en"],
  ] as const) {
    expect(draftQuoteSourceSchema.parse({ locale, timeZone: "Europe/Berlin" }).locale).toBe(expected);
  }
  for (const locale of ["", "not_a_locale", "de-DE, en"]) {
    expect(draftQuoteSourceSchema.safeParse({ locale, timeZone: "UTC" }).success).toBe(false);
  }
  for (const timeZone of ["", "Mars/Olympus", "+01:00"]) {
    expect(draftQuoteSourceSchema.safeParse({ locale: "de", timeZone }).success).toBe(false);
  }
  expect(draftEditableContentInputSchema.safeParse({ senderIdentityId: "Send01", quoteSource: true }).success).toBe(false);
});

test("quote locale and time zone each affect the hash, even without source text", () => {
  const content = { body: "Reply", quoteSource: { locale: "de", timeZone: "Europe/Berlin" } };
  expect(sha256Json(content)).not.toBe(sha256Json({ ...content, quoteSource: { ...content.quoteSource, locale: "en" } }));
  expect(sha256Json(content)).not.toBe(sha256Json({ ...content, quoteSource: { ...content.quoteSource, timeZone: "UTC" } }));
});

test("equal quote contexts do not rewrite shared settings during unrelated edits", () => {
  const content = draftEditableContentInputSchema.parse({
    senderIdentityId: "Send01",
    quoteSource: { locale: "de", timeZone: "Europe/Berlin" },
  });
  const doc = createDraftDocument(content);
  try {
    const updates: unknown[] = [];
    doc.on("update", (update) => updates.push(update));
    writeLocalDraftHeaders(doc, readDraftDocument(doc), draftEditableContentInputSchema.parse(content));
    expect(updates).toEqual([]);
  } finally {
    doc.destroy();
  }
});
