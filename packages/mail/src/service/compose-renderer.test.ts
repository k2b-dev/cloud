import { describe, expect, test } from "bun:test";
import {
  type ComposeRenderContext,
  DEFAULT_MAIL_CSS,
  hasUnrenderedTemplateSyntax,
  markComposeTemplateSegment,
  renderComposeContent,
  validateComposeCss,
  validateComposeTemplateSource,
} from "./compose-renderer";

const context: ComposeRenderContext = {
  actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
  mailbox: { name: "Support", description: "Customer support" },
  sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
  message: { subject: "Hello", to: ["reader@example.test"], cc: [] },
};

describe("compose renderer", () => {
  test("renders Liquid, Markdown, inline CSS, and readable text from one source", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("Hello **{{ actor.display_name }}**"),
      format: "markdown",
      customCss: ".mail-content strong { color: #0f766e; }",
      context,
      renderLiquid: true,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toContain("Ada Lovelace");
    expect(rendered.data.html).toContain("color:#0f766e");
    expect(rendered.data.text).toBe("Hello Ada Lovelace");
  });

  test("escapes Liquid values before rendering Markdown", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("{{ actor.display_name }}"),
      format: "markdown",
      customCss: "",
      context: { ...context, actor: { ...context.actor, display_name: "<img src=x onerror=alert(1)>" } },
      renderLiquid: true,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).not.toContain("<img");
    expect(rendered.data.text).toContain("<img src=x onerror=alert(1)>");
  });

  test("keeps email variables readable without accidental Markdown links", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("Contact {{ actor.email }}"),
      format: "markdown",
      customCss: "",
      context: { ...context, actor: { ...context.actor, email: "writer-123@example.test" } },
      renderLiquid: true,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.text).toBe("Contact writer-123@example.test");
    expect(rendered.data.html).not.toContain("href=");
  });

  test("detects template syntax that sits outside a marked segment", () => {
    expect(hasUnrenderedTemplateSyntax(markComposeTemplateSegment("{{ sender.email }}"))).toBe(false);
    expect(hasUnrenderedTemplateSyntax("Regards\n{{ sender.email }}")).toBe(true);
    expect(hasUnrenderedTemplateSyntax(`${markComposeTemplateSegment("{{ sender.email }}")}\n{% if x %}`)).toBe(true);
    expect(hasUnrenderedTemplateSyntax("Plain regards")).toBe(false);
    expect(hasUnrenderedTemplateSyntax("\u2063{{ sender.email }}")).toBe(true);
  });

  test("keeps unknown user braces literal and prevents Markdown injection from variables", () => {
    const rendered = renderComposeContent({
      body: `Literal {{ customer.name }}\n\n${markComposeTemplateSegment("{{ actor.display_name }}")}`,
      format: "markdown",
      customCss: "",
      context: { ...context, actor: { ...context.actor, display_name: "[Reset](https://evil.example)" } },
      renderLiquid: true,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toContain("{{ customer.name }}");
    expect(rendered.data.html).not.toContain("href=");
    expect(rendered.data.text).toContain("[Reset](https://evil.example)");
  });

  test("rejects Liquid output inside Markdown link destinations", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("[Email support](mailto:{{ sender.email }})"),
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: true,
    });

    expect(rendered).toMatchObject({ ok: false });
  });

  test("keeps plaintext variables unescaped", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("{{ actor.display_name }}"),
      format: "plain",
      customCss: "",
      context: { ...context, actor: { ...context.actor, display_name: "O'Reilly & Partners" } },
      renderLiquid: true,
    });

    expect(rendered).toEqual({ ok: true, data: { html: null, text: "O'Reilly & Partners" } });
  });

  test("accepts known Liquid variables and logic but rejects unknown variables", () => {
    expect(validateComposeTemplateSource("Regards, {{ actor.display_name }}").ok).toBe(true);
    expect(validateComposeTemplateSource("{% if actor.email %}Hi{% endif %}").ok).toBe(true);
    expect(validateComposeTemplateSource("{{ actor.unknown }}").ok).toBe(false);
    expect(validateComposeTemplateSource("<{{ sender.reply_to }}>").ok).toBe(false);
    expect(validateComposeTemplateSource("[Support]: mailto:{{ sender.email }}").ok).toBe(false);
  });

  test("resolves variables only inside inserted template segments", () => {
    const rendered = renderComposeContent({
      body: "Quoted {{ actor.email }}\n\n{{ message.bcc }}",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: true,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.text).toContain("{{ actor.email }}");
    expect(rendered.data.text).toContain("{{ message.bcc }}");
  });

  test("bounds template expansion before allocating the rendered source", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("{{ message.to }}".repeat(2_000)),
      format: "plain",
      customCss: "",
      context: {
        ...context,
        message: {
          ...context.message,
          to: Array.from({ length: 200 }, (_, index) => `recipient-${index}@example.test`),
        },
      },
      renderLiquid: true,
    });

    expect(rendered).toMatchObject({ ok: false, error: { status: 400, message: "Rendered email content exceeds the safe size limit" } });
  });

  test("rejects malformed or excessive signature segments in linear time", () => {
    const excessive = renderComposeContent({
      body: markComposeTemplateSegment("x").repeat(101),
      format: "plain",
      customCss: "",
      context,
      renderLiquid: true,
    });
    expect(excessive).toMatchObject({
      ok: false,
      error: { status: 400, message: "Email may contain at most 100 signature segments" },
    });

    const malformed = renderComposeContent({
      body: `${markComposeTemplateSegment("x")}\u2064`,
      format: "plain",
      customCss: "",
      context,
      renderLiquid: true,
    });
    expect(malformed).toMatchObject({ ok: false, error: { status: 400, message: "Email contains an invalid signature segment" } });
  });

  test("rejects pathological Markdown before CSS inlining", () => {
    const rendered = renderComposeContent({
      body: Array.from({ length: 1_001 }, (_, index) => `Paragraph ${index}`).join("\n\n"),
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: true,
    });

    expect(rendered).toMatchObject({ ok: false, error: { status: 400 } });

    const syntaxBomb = renderComposeContent({
      body: "*".repeat(12_001),
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: true,
    });
    expect(syntaxBomb).toMatchObject({ ok: false, error: { status: 400, message: "Markdown email is too complex to render safely" } });
  });

  test("rejects active and unscoped CSS features", () => {
    for (const css of [
      "@import url(https://example.test/x.css);",
      "#mail { color: red; }",
      ".mail-content a:hover { color: red; }",
      ".mail-content { background-image: url(https://example.test/x); }",
      ".mail-content { position: fixed; }",
    ]) {
      expect(validateComposeCss(css).ok).toBe(false);
    }
    expect(validateComposeCss(`.mail-content { font-family: "${"a".repeat(513)}"; }`).ok).toBe(false);
    expect(validateComposeCss(`.mail-content { color: red; }\n/*${"a".repeat(33 * 1024)}*/`).ok).toBe(false);
  });

  test("rejects CSS work that would expand excessively during inlining", () => {
    const customCss = Array.from(
      { length: 20 },
      (_, index) => `.mail-content p { font-family: "${String(index).padStart(2, "0")}${"a".repeat(480)}"; }`,
    ).join("\n");
    const rendered = renderComposeContent({
      body: Array.from({ length: 1_000 }, (_, index) => `Paragraph ${index}`).join("\n\n"),
      format: "markdown",
      customCss,
      context,
      renderLiquid: true,
    });

    expect(rendered).toMatchObject({
      ok: false,
      error: { status: 400, message: "Email content and CSS are too complex to inline safely" },
    });
  });

  test("keeps the built-in stylesheet valid", () => {
    expect(validateComposeCss(DEFAULT_MAIL_CSS).ok).toBe(true);
  });

  test("keeps plain text plain while resolving Liquid", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("Hello **{{ actor.display_name }}**"),
      format: "plain",
      customCss: "",
      context,
      renderLiquid: true,
    });

    expect(rendered).toEqual({ ok: true, data: { html: null, text: "Hello Ada Lovelace" } });
  });
});
