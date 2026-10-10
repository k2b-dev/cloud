import { describe, expect, test } from "bun:test";
import {
  type ComposeRenderContext,
  DEFAULT_MAIL_CSS,
  hasUnrenderedTemplateSyntax,
  markComposeTemplateSegment,
  removeOrphanComposeSegmentMarks,
  renderComposeContent,
  renderComposeTemplateSource,
  validateComposeCss,
  validateComposeTemplateSource,
} from "./compose-renderer";

const context: ComposeRenderContext = {
  actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
  mailbox: { name: "Support", description: "Customer support" },
  sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
  message: { subject: "Hello", to: ["reader@example.test"], cc: [] },
};

const MARKDOWN_SYNTAX_VALUES = [
  "**Admin** _team_ `code` ~sub~ ^sup^ ==mark== $x$ a|b",
  "<b>Bold</b> <img src=x onerror=alert(1)>",
  "[Reset](/reset) ![Logo](/logo.png)",
  "# Heading",
  "- Item",
  "1. First",
  "> Quote",
  ":::warning",
  "{{ actor.email }} {% if x %}",
  "&amp; &#64; a\\*b",
  "Line one\n- Line two\n## Line three",
  "Column\n:---",
  "    Indented $x$ &amp;",
  "Intro\r# Heading\r- Item\r\n> Quote",
];

const expectLiteralText = (rendered: ReturnType<typeof renderComposeContent>, value: string) => {
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) return;
  expect(rendered.data.text).toBe(value.trimStart().replace(/\r\n?/g, "\n"));
  const elements = new Set(rendered.data.html?.match(/<[a-z][a-z0-9]*/gi));
  expect(elements).toEqual(new Set(/[\r\n]/.test(value) ? ["<div", "<p", "<br"] : ["<div", "<p"]));
};

describe("compose renderer", () => {
  test("shares one time budget across looping signature segments", () => {
    let reads = 0;
    const loopingContext: ComposeRenderContext = {
      ...context,
      actor: {
        ...context.actor,
        get display_name() {
          reads++;
          const start = performance.now();
          while (performance.now() - start < 1) {
            // About 100 ms per segment: the first segment finishes even on a loaded runner,
            // while all segments together need far more than one second.
          }
          return "";
        },
      },
    };
    const signature = markComposeTemplateSegment(
      "{% for a in (1..10) %}{% for b in (1..10) %}{{ actor.display_name }}{% endfor %}{% endfor %}",
    );
    const start = performance.now();
    const result = renderComposeContent({
      body: signature.repeat(80),
      format: "markdown",
      customCss: "",
      context: loopingContext,
      renderLiquid: true,
    });
    expect(result).toMatchObject({ ok: false, error: { composeRender: { reason: "signatureFailed" } } });
    // More reads than one segment has: the time budget carried over into later segments.
    expect(reads).toBeGreaterThan(100);
    expect(performance.now() - start).toBeLessThan(3_000);
  });

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

  test("inserts snippet addresses and URLs as plain text and sends them as ordinary links", () => {
    const inserted = renderComposeTemplateSource(
      "Reach me at {{ actor.email }} or {{ sender.reply_to }}. Help: {{ mailbox.description }}.",
      {
        ...context,
        mailbox: { ...context.mailbox, description: "https://example.test/help" },
        sender: { ...context.sender, reply_to: "grace_hopper@example.test" },
      },
      "markdown",
    );
    const draft = "Reach me at ada@example.test or grace_hopper@example.test. Help: https://example.test/help.";
    expect(inserted).toEqual({ ok: true, data: draft });

    const sent = renderComposeContent({ body: draft, format: "markdown", customCss: "", context, renderLiquid: true });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const link = (href: string, text: string) => `<a href="${href}" style="color:#0f766e;text-decoration:underline">${text}</a>`;
    expect(sent.data.html).toContain(
      `Reach me at ${link("mailto:ada@example.test", "ada@example.test")} or ${link("mailto:grace_hopper@example.test", "grace_hopper@example.test")}. Help: ${link("https://example.test/help", "https://example.test/help")}.`,
    );
    expect(sent.data.text).toBe(draft);
  });

  test("sends typed Markdown links as their label followed by the address in plain text", () => {
    const sent = renderComposeContent({
      body: "Read [the **offer**](https://example.test/offer).",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: true,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.data.html).not.toContain("[");
    expect(sent.data.text).toBe("Read the offer [https://example.test/offer].");
    expect(renderComposeTemplateSource("Read [the offer](https://example.test/offer).", context, "plain")).toEqual({
      ok: true,
      data: "Read the offer [https://example.test/offer].",
    });
  });

  test("keeps inserted snippet values literal when the draft is sent", () => {
    for (const display_name of MARKDOWN_SYNTAX_VALUES) {
      const inserted = renderComposeTemplateSource(
        "{{ actor.display_name }}",
        { ...context, actor: { ...context.actor, display_name } },
        "markdown",
      );
      expect(inserted.ok).toBe(true);
      if (!inserted.ok) continue;
      expect(hasUnrenderedTemplateSyntax(inserted.data)).toBe(false);

      const sent = renderComposeContent({ body: inserted.data, format: "markdown", customCss: "", context, renderLiquid: true });
      expectLiteralText(sent, display_name);
    }
  });

  test("keeps signature values literal at delivery", () => {
    for (const display_name of MARKDOWN_SYNTAX_VALUES) {
      const sent = renderComposeContent({
        body: markComposeTemplateSegment("{{ actor.display_name }}"),
        format: "markdown",
        customCss: "",
        context: { ...context, actor: { ...context.actor, display_name } },
        renderLiquid: true,
      });
      expectLiteralText(sent, display_name);
    }
  });

  test("detects template syntax that sits outside a marked segment", () => {
    expect(hasUnrenderedTemplateSyntax(markComposeTemplateSegment("{{ sender.email }}"))).toBe(false);
    expect(hasUnrenderedTemplateSyntax("Regards\n{{ sender.email }}")).toBe(true);
    expect(hasUnrenderedTemplateSyntax(`${markComposeTemplateSegment("{{ sender.email }}")}\n{% if x %}`)).toBe(true);
    expect(hasUnrenderedTemplateSyntax("Plain regards")).toBe(false);
    expect(hasUnrenderedTemplateSyntax("\u2063{{ sender.email }}")).toBe(true);
    expect(hasUnrenderedTemplateSyntax(`\u2063{{ sender.email }}${markComposeTemplateSegment("Regards")}`)).toBe(true);
    expect(hasUnrenderedTemplateSyntax("{{ sender.email }}\u2064")).toBe(true);
    expect(hasUnrenderedTemplateSyntax("{\u2064{ sender.email }}")).toBe(true);
    // A marked segment that is no valid signature template is sent as written, too.
    expect(hasUnrenderedTemplateSyntax(markComposeTemplateSegment("{{ customer.name }}"))).toBe(true);
    expect(hasUnrenderedTemplateSyntax(markComposeTemplateSegment("{% if actor.email %}Hi"))).toBe(true);
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

  test("never fills in Liquid output inside Markdown link destinations", () => {
    const body = markComposeTemplateSegment("[Email support](mailto:{{ sender.email }})");
    const rendered = renderComposeContent({ body, format: "markdown", customCss: "", context, renderLiquid: true });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.text).toBe("[Email support](mailto:{{ sender.email }})");
    expect(rendered.data.html).not.toContain("href=");
    expect(hasUnrenderedTemplateSyntax(body)).toBe(true);
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

    expect(rendered).toMatchObject({ ok: false, error: { status: 400, composeRender: { reason: "tooLarge" } } });
  });

  test("caps real signature segments in linear time", () => {
    const excessive = renderComposeContent({
      body: markComposeTemplateSegment("x").repeat(101),
      format: "plain",
      customCss: "",
      context,
      renderLiquid: true,
    });
    expect(excessive).toMatchObject({
      ok: false,
      error: { status: 400, composeRender: { reason: "tooManySignatures", limit: 100 } },
    });

    const allowed = renderComposeContent({
      body: markComposeTemplateSegment("{{ actor.display_name }}").repeat(100),
      format: "plain",
      customCss: "",
      context,
      renderLiquid: true,
    });
    expect(allowed).toEqual({ ok: true, data: { html: null, text: "Ada Lovelace".repeat(100) } });

    // Leftover marks do not count as signatures, however many a hand edit leaves.
    for (const body of [`${"\u2063".repeat(10_000)}text`, `text${"\u2064".repeat(10_000)}`]) {
      const leftovers = renderComposeContent({ body, format: "plain", customCss: "", context, renderLiquid: true });
      expect(leftovers).toEqual({ ok: true, data: { html: null, text: "text" } });
    }
  });

  test("reads the largest body of nothing but marks without going through all of it", () => {
    // Every API path accepts a body of 2 MiB characters; these are a million empty segments.
    const body = "\u2063\u2064".repeat(1_048_576);
    const start = performance.now();
    expect(renderComposeContent({ body, format: "plain", customCss: "", context, renderLiquid: true })).toMatchObject({
      ok: false,
      error: { composeRender: { reason: "tooManySignatures", limit: 100 } },
    });
    expect(removeOrphanComposeSegmentMarks(body)).toBe(body);
    expect(hasUnrenderedTemplateSyntax(body)).toBe(false);
    expect(hasUnrenderedTemplateSyntax(`{{ customer.name }}${body}`)).toBe(true);
    // The review stops where rendering stops: a body with more segments is never sent.
    expect(hasUnrenderedTemplateSyntax(`${body}{{ customer.name }}`)).toBe(false);
    // Reading every segment took about two seconds; reading up to the cap takes a small part of that.
    expect(performance.now() - start).toBeLessThan(1_500);
  });

  describe("keeps text of a partly deleted signature as plain text", () => {
    const render = (body: string) => renderComposeContent({ body, format: "markdown", customCss: "", context, renderLiquid: true });
    const textOf = (body: string) => {
      const rendered = render(body);
      expect(rendered.ok).toBe(true);
      return rendered.ok ? rendered.data.text : null;
    };

    test("a start mark without an end", () => {
      expect(textOf("Hello\n\n\u2063Regards, {{ actor.display_name }}")).toBe("Hello\n\nRegards, {{ actor.display_name }}");
      expect(textOf("Hello\u2063")).toBe("Hello");
    });

    test("an end mark without a start", () => {
      expect(textOf("Regards, {{ actor.display_name }}\u2064\n\nThanks")).toBe("Regards, {{ actor.display_name }}\n\nThanks");
      expect(textOf(`${markComposeTemplateSegment("By {{ actor.display_name }}")}\u2064`)).toBe("By Ada Lovelace");
    });

    test("a start mark inside a signature", () => {
      expect(textOf(`\u2063Kept {{ actor.email }} ${markComposeTemplateSegment("By {{ actor.display_name }}")}`)).toBe(
        "Kept {{ actor.email }} By Ada Lovelace",
      );
    });

    test("complete signatures next to leftovers", () => {
      const body = `\u2064A ${markComposeTemplateSegment("{{ actor.display_name }}")} B \u2063C ${markComposeTemplateSegment("{{ actor.email }}")}\u2064`;
      expect(textOf(body)).toBe("A Ada Lovelace B C ada@example.test");
    });

    test("a signature whose Liquid a hand edit broke", () => {
      for (const format of ["markdown", "plain"] as const) {
        const send = (body: string) => renderComposeContent({ body, format, customCss: "", context, renderLiquid: true });
        // Only the closing tag was deleted; the marks still enclose the rest.
        const unclosed = "Hi\n\n\u2063{% if sender.email %}Best, {{ actor.display_name }}\u2064";
        // A pasted end mark closes the signature early; a pasted start mark opens a second one.
        const pastedEnd = "\u2063{% if actor.display_name %}Regards\u2064{% endif %}\u2064";
        const pastedStart = "\u2063{% if actor.display_name %}Regards\u2063{% endif %}\u2064";
        // The end of one signature and the start of the next were deleted, so their marks enclose the text between.
        const original = `Hi\n\n${markComposeTemplateSegment("Regards {{ actor.display_name }}")}\n\nPS: use {{ name }} in your template\n\n${markComposeTemplateSegment("Sent by {{ sender.email }}")}`;
        const crossed =
          "Hi\n\n\u2063Regards {{ actor.display_name }}\n\nPS: use {{ name }} in your template\n\nSent by {{ sender.email }}\u2064";
        expect(send(original)).toMatchObject({
          ok: true,
          data: { text: "Hi\n\nRegards Ada Lovelace\n\nPS: use {{ name }} in your template\n\nSent by support@example.test" },
        });
        for (const [body, text] of [
          [unclosed, "Hi\n\n{% if sender.email %}Best, {{ actor.display_name }}"],
          [pastedEnd, "{% if actor.display_name %}Regards{% endif %}"],
          [pastedStart, "{% if actor.display_name %}Regards{% endif %}"],
          [crossed, "Hi\n\nRegards {{ actor.display_name }}\n\nPS: use {{ name }} in your template\n\nSent by {{ sender.email }}"],
        ] as const) {
          expect(send(body)).toMatchObject({ ok: true, data: { text } });
          // Saving keeps the draft sendable, and the review before sending points out the text sent as written.
          expect(send(removeOrphanComposeSegmentMarks(body))).toMatchObject({ ok: true, data: { text } });
          expect(hasUnrenderedTemplateSyntax(body)).toBe(true);
        }
      }
    });

    test("marks written as character references", () => {
      const rendered = render("&#8291;{{ actor.email }}&#8292; and &#x2063;");
      expect(rendered).toMatchObject({ ok: true, data: { text: "{{ actor.email }} and" } });
      expect(rendered.ok && `${rendered.data.html}${rendered.data.text}`).not.toMatch(/[\u2063\u2064]|&#(?:8291|8292|x206[34]);/i);
    });

    test("leftover marks in filled-in values never reach the message", () => {
      const rendered = renderComposeContent({
        body: markComposeTemplateSegment("{{ actor.display_name }}"),
        format: "plain",
        customCss: "",
        context: { ...context, actor: { ...context.actor, display_name: "Ada\u2064\u2063 Lovelace" } },
        renderLiquid: true,
      });
      expect(rendered).toEqual({ ok: true, data: { html: null, text: "Ada Lovelace" } });
    });
  });

  test("keeps only complete signature segments when a draft is saved", () => {
    const signature = markComposeTemplateSegment("{{ actor.display_name }}");
    expect(removeOrphanComposeSegmentMarks(`\u2064Hi\u2063 ${signature}\u2064\u2063`)).toBe(`Hi ${signature}`);
    expect(removeOrphanComposeSegmentMarks(`A ${signature} B`)).toBe(`A ${signature} B`);
    expect(removeOrphanComposeSegmentMarks("")).toBe("");
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
    expect(syntaxBomb).toMatchObject({ ok: false, error: { status: 400, composeRender: { reason: "tooComplex" } } });
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
      error: { status: 400, composeRender: { reason: "tooComplex" } },
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
