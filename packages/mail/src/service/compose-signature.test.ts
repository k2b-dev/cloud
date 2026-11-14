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
