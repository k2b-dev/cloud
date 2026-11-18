import { expect, test } from "bun:test";
import { type ComposeRenderContext, renderComposeContent, renderComposeSignatureBlock } from "./compose-renderer";

const context: ComposeRenderContext = {
  actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
  mailbox: { name: "Support", description: "" },
  sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
  message: { subject: "", to: [], cc: [] },
};

test("renders only the filled signature without outgoing styles or images", () => {
  const signature =
    "**{{ actor.display_name }}**\n\n{{ sender.email }}\n\n{{ mailbox.logo }}\n\n![Remote](https://example.test/a.png)<script>bad()</script>";
  const result = renderComposeSignatureBlock({ signature, context, format: "markdown", logoAltText: "Company <logo>" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.html).toContain("<strong>Ada Lovelace</strong>");
  expect(result.data.html).toContain("Company &#60;logo&#62;");
  expect(result.data.html).not.toMatch(/style=|class=|<img|<script|MAILLOGO/);
  const sent = renderComposeContent({
    signature,
    context,
    format: "markdown",
    body: "",
    customCss: "p { color: red; }",
    renderLiquid: true,
    logo: { src: "cid:logo", altText: "Company <logo>", displayWidth: 1, pixelWidth: 1, pixelHeight: 1, byteLength: 1 },
  });
  if (!sent.ok) throw new Error(sent.error.message);
  expect(result.data.text).toBe(sent.data.text);
});

test("plain signature has no HTML and matches the outgoing text", () => {
  const signature = "**{{ sender.display_name }}**\n\n{{ mailbox.logo }}";
  const result = renderComposeSignatureBlock({ signature, context, format: "plain", logoAltText: "Logo" });
  const sent = renderComposeContent({
    signature,
    context,
    format: "plain",
    body: "",
    customCss: "",
    renderLiquid: true,
    logo: { src: "cid:logo", altText: "Logo", displayWidth: 1, pixelWidth: 1, pixelHeight: 1, byteLength: 1 },
  });
  if (!sent.ok) throw new Error(sent.error.message);
  expect(result).toEqual({ ok: true, data: { html: null, text: sent.data.text } });
});

test("supports no signature and no mailbox logo", () => {
  expect(renderComposeSignatureBlock({ signature: null, context, format: "plain" })).toEqual({ ok: true, data: { html: null, text: "" } });
  expect(renderComposeSignatureBlock({ signature: "Hello\n\n{{ mailbox.logo }}", context, format: "markdown" })).toEqual({
    ok: true,
    data: { html: "<p>Hello</p>\n<p></p>\n", text: "Hello" },
  });
});

test("reports existing signature and complexity failure codes", () => {
  expect(renderComposeSignatureBlock({ signature: "{{ unknown }}", context, format: "markdown" })).toMatchObject({
    ok: false,
    error: { composeRender: { reason: "signatureFailed" } },
  });
  expect(renderComposeSignatureBlock({ signature: "<span>x</span>".repeat(1001), context, format: "markdown" })).toMatchObject({
    ok: false,
    error: { composeRender: { reason: "tooComplex" } },
  });
});

// The composer shows `mailHtml`: the send renderer with an empty text and no quote. Its signature must be the one the
// recipient gets, whatever text and quote the message has around it.
test("the sent signature alone matches the signature block of a sent message", () => {
  const sender: ComposeRenderContext = {
    actor: { display_name: "Erika Beispiel", email: "erika@beispiel.test" },
    mailbox: { name: "Beispiel Handel GmbH", description: "" },
    sender: { display_name: "Beispiel Handel", email: "info@beispiel.test", reply_to: "" },
    message: { subject: "", to: [], cc: [] },
  };
  const signature = [
    "{{ mailbox.logo }}",
    "<strong>{{ actor.display_name }}</strong>",
    "Musterweg 1 · 12345 Beispielstadt · [+49 30 000000](tel:+4930000000) · [beispiel.test](https://beispiel.test)",
    "---",
    "Beispiel Handel GmbH · Amtsgericht Beispielstadt",
  ].join("\n\n");
  const shared = {
    signature,
    context: sender,
    format: "markdown" as const,
    customCss: ".mail-signature strong { text-transform: uppercase; } .mail-signature hr ~ p { color: #71717a; font-size: 11px; }",
    renderLiquid: true,
    logo: { src: "data:image/png;base64,iVBORw0KGgo=", altText: "Beispiel Logo", displayWidth: 120, pixelWidth: 240, pixelHeight: 60, byteLength: 8 },
  };
  const alone = renderComposeContent({ ...shared, body: "" });
  const sent = renderComposeContent({
    ...shared,
    body: "Hallo zusammen,\n\nanbei das Angebot.",
    quoteSource: { locale: "de", timeZone: "Europe/Berlin" },
    sourceQuote: "> Frühere Nachricht",
  });
  if (!alone.ok || !alone.data.html) throw new Error("The signature did not render alone");
  if (!sent.ok || !sent.data.html) throw new Error("The message did not render");
  const wrapper = alone.data.html.slice(0, alone.data.html.indexOf(">") + 1);
  const start = alone.data.html.indexOf('<div class="mail-signature"');
  expect(start).toBe(wrapper.length);
  expect(alone.data.html.endsWith("</div>")).toBe(true);
  const block = alone.data.html.slice(start, -"</div>".length);
  expect(sent.data.html.startsWith(wrapper)).toBe(true);
  expect(sent.data.html).toContain(block);
  expect(block).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(block).toMatch(/<strong style="[^"]*text-transform: uppercase/);
  expect(block).toMatch(/<hr[^>]*>\s*<p style="[^"]*color: #71717a[^"]*font-size: 11px[^"]*">Beispiel Handel GmbH/);
  expect(block).toContain('href="tel:+4930000000"');
  expect(block).toContain("<hr");
});
