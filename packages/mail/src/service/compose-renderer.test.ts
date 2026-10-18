import { describe, expect, spyOn, test } from "bun:test";
import { type ComposeFormattingWarning, MAX_COMPOSE_FORMATTING_WARNINGS } from "../contracts";
import {
  type ComposeRenderContext,
  composeFormattingWarnings,
  DEFAULT_MAIL_CSS,
  hasUnrenderedTemplateSyntax,
  moveSignatureSegment,
  previewFormattingWarnings,
  removeOrphanComposeSegmentMarks,
  renderComposeContent,
  renderComposeTemplateSource,
  splitQuotedHistory,
  storedComposeCss,
  validateComposeCss,
  validateComposeTemplateSource,
  withoutSignatureSegments,
} from "./compose-renderer";

const markComposeTemplateSegment = (source: string): string => `\u2063${source}\u2064`;

const context: ComposeRenderContext = {
  actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
  mailbox: { name: "Support", description: "Customer support" },
  sender: { display_name: "Support", email: "support@example.test", reply_to: "" },
  message: { subject: "Hello", to: ["reader@example.test"], cc: [] },
};

const longBody = Array.from({ length: 900 }, (_, i) => `Paragraph ${i}`).join("\n\n");
const largeMailboxCss = Array.from(
  { length: 40 },
  (_, i) => `${i % 2 ? "p" : ".mail-content"} { color: #991abc; font-family: "Mailbox991${i}${"a".repeat(480)}"; }`,
).join("\n");

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
  test("merges preview warnings design first and caps the combined list", () => {
    const design = storedComposeCss(".mail-content { color: #123456; font-family: var(--font); }");
    expect(design.formattingWarnings).toEqual([{ code: "ignored_mailbox_css", property: "font-family" }]);
    expect(
      previewFormattingWarnings(
        design.formattingWarnings,
        "<small>fine print</small>\n\n![logo](https://example.test/logo.png)",
        "markdown",
      ),
    ).toEqual([
      { code: "ignored_mailbox_css", property: "font-family" },
      { code: "unsupported_element", element: "small" },
      { code: "unsupported_element", element: "img" },
    ]);
    const body = Array.from({ length: MAX_COMPOSE_FORMATTING_WARNINGS }, (_, index) => `<bad${index}>text</bad${index}>`).join("\n");
    const capped = previewFormattingWarnings(design.formattingWarnings, body, "markdown");
    expect(capped).toHaveLength(MAX_COMPOSE_FORMATTING_WARNINGS);
    expect(capped[0]).toEqual(design.formattingWarnings[0]);
    expect(capped.at(-1)).toEqual({ code: "unsupported_element", element: `bad${MAX_COMPOSE_FORMATTING_WARNINGS - 2}` });
    expect(previewFormattingWarnings([], body, "plain")).toEqual([]);
  });

  test("keeps Markdown quotes and code lines without a language label (#932)", () => {
    const rendered = renderComposeContent({
      body: "> quoted line\n> second\n\n```ts\nconst a = 1;\nconst b = 2;\n```",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: false,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toMatch(
      /<blockquote style="[^"]*border-left:3px solid #d4d4d8[^"]*">\s*<p[^>]*>quoted line<br \/>second<\/p>\s*<\/blockquote>/,
    );
    expect(rendered.data.html).toMatch(/<pre style="[^"]*white-space:pre-wrap[^"]*">const a = 1;\nconst b = 2;<\/pre>/);
    expect(rendered.data.html).not.toContain("<span>ts</span>");
    expect(rendered.data.html).not.toContain(">ts<");
    expect(rendered.data.text).toContain("> quoted line\n> second");
    expect(rendered.data.text).toContain("const a = 1;\nconst b = 2;");
    expect(rendered.data.text).not.toContain("tsconst");
  });

  test("keeps nested Markdown quotes in HTML and text", () => {
    const rendered = renderComposeContent({
      body: "> outer\n> > inner",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: false,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toMatch(
      /<blockquote[^>]*>\s*<p[^>]*>outer<\/p>\s*<blockquote[^>]*>\s*<p[^>]*>inner<\/p>\s*<\/blockquote>\s*<\/blockquote>/,
    );
    expect(rendered.data.text).toContain("> > inner");
  });

  test("lets mailbox CSS style quotes and preformatted blocks", () => {
    const customCss = "blockquote { color: #3f3f46; }";
    expect(validateComposeCss(customCss).ok).toBe(true);
    expect(validateComposeCss("pre { white-space: pre; }").ok).toBe(true);
    const rendered = renderComposeContent({ body: "> quoted", format: "markdown", customCss, context, renderLiquid: false });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toMatch(/<blockquote style="[^"]*color:#3f3f46/);
    expect(rendered.data.html).not.toContain("#52525b");
  });

  test("renders a Mermaid fence as its source without loading text", () => {
    const rendered = renderComposeContent({
      body: "```mermaid\ngraph TD\nA-->B\n```",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: false,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toMatch(/<pre[^>]*>graph TD\nA--&gt;B<\/pre>/);
    expect(rendered.data.html).not.toContain("Loading diagram");
  });

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

    expect(rendered).toEqual({ ok: true, data: { logoUsed: false, html: null, text: "O'Reilly & Partners", formattingWarnings: [] } });
  });

  test("accepts known Liquid variables and logic but rejects unknown variables", () => {
    expect(validateComposeTemplateSource("Regards, {{ actor.display_name }}").ok).toBe(true);
    expect(validateComposeTemplateSource("{% if actor.email %}Hi{% endif %}").ok).toBe(true);
    expect(validateComposeTemplateSource("{{ actor.unknown }}").ok).toBe(false);
    expect(validateComposeTemplateSource("{{ user.name }}\n")).toMatchObject({
      ok: false,
      error: {
        message:
          'Mail template variable "user.name" is not available here. Available: actor.display_name, actor.email, sender.display_name, sender.email, sender.reply_to, mailbox.name, mailbox.description, message.subject, message.to, message.cc.',
      },
    });
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
    expect(allowed).toEqual({ ok: true, data: { logoUsed: false, html: null, text: "Ada Lovelace".repeat(100), formattingWarnings: [] } });

    // Leftover marks do not count as signatures, however many a hand edit leaves.
    for (const body of [`${"\u2063".repeat(10_000)}text`, `text${"\u2064".repeat(10_000)}`]) {
      const leftovers = renderComposeContent({ body, format: "plain", customCss: "", context, renderLiquid: true });
      expect(leftovers).toEqual({ ok: true, data: { logoUsed: false, html: null, text: "text", formattingWarnings: [] } });
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

    test("marks inside a link address never hide its scheme from the sanitizer", () => {
      for (const body of [
        '<a href="java&#8291;script:alert(1)">click</a>',
        "[click](java&#8291;script:alert(1))",
        '<a href="te&#8291;l:*123#">click</a>',
        "[click](te&#x2064;l:*123#)",
      ]) {
        const rendered = render(body);
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) continue;
        expect(rendered.data.html).toContain(">click</a>");
        expect(rendered.data.html).not.toContain("href");
        expect(composeFormattingWarnings(body, "markdown")).toEqual([{ code: "unsupported_link", element: "a" }]);
      }
    });

    test("leftover marks in filled-in values never reach the message", () => {
      const rendered = renderComposeContent({
        body: markComposeTemplateSegment("{{ actor.display_name }}"),
        format: "plain",
        customCss: "",
        context: { ...context, actor: { ...context.actor, display_name: "Ada\u2064\u2063 Lovelace" } },
        renderLiquid: true,
      });
      expect(rendered).toEqual({ ok: true, data: { logoUsed: false, html: null, text: "Ada Lovelace", formattingWarnings: [] } });
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
      // Other functions that load an image, CSS escapes that spell one, and a function after a line break.
      "a { background: image-set('https://example.test/p.png' 1x); }",
      "a { background: -webkit-image-set(url(https://example.test/p.png) 1x); }",
      "a { background: cross-fade(50% 'https://example.test/p.png', red); }",
      "a { background: -moz-element(#x); }",
      "p { background: u\\72l(https://example.test/p); }",
      "p { background: \\75\\72\\6c(https://example.test/p); }",
      "p { background: #fff\n  image-set('https://example.test/p.png' 1x); }",
    ]) {
      expect(validateComposeCss(css).ok).toBe(false);
    }
    expect(validateComposeCss(`.mail-content { font-family: "${"a".repeat(513)}"; }`).ok).toBe(false);
    expect(validateComposeCss(`.mail-content { color: red; }\n/*${"a".repeat(33 * 1024)}*/`).ok).toBe(false);
  });

  test("rejects raw line breaks inside CSS strings and drops only the unsafe stored declaration", () => {
    for (const lineBreak of ["\n", "\r"]) {
      const value = `"a${lineBreak};display:none;position:fixed;inset:0;${lineBreak}"`;
      const customCss = `p {\n  font-family: ${value};\n}`;
      expect(validateComposeCss(customCss).ok).toBe(false);
      const stored = storedComposeCss(`p {\n  color: blue;\n  font-family: ${value};\n}`);
      expect(stored.css).toContain("color: blue");
      expect(stored.css).not.toContain("font-family");
      expect(stored.formattingWarnings).toEqual([{ code: "ignored_mailbox_css", property: "font-family" }]);
      const rendered = renderComposeContent({ body: "hello", format: "markdown", customCss, context, renderLiquid: false });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) continue;
      for (const removed of ["display:none", "position", "inset"]) expect(rendered.data.html).not.toContain(removed);
    }
  });

  test("rejects mixed quotes inside CSS strings before inlining", () => {
    for (const customCss of [
      `p { font-family: "a'; color:red !important; x:'"; }`,
      `p { font-family: 'a"; color:red !important; x:"'; }`,
    ]) {
      expect(validateComposeCss(customCss)).toMatchObject({
        ok: false,
        error: { message: 'CSS value for "font-family" is not allowed' },
      });
      const stored = storedComposeCss(customCss);
      expect(stored.css).not.toContain("font-family");
      expect(stored.formattingWarnings).toEqual([{ code: "ignored_mailbox_css", property: "font-family" }]);
      const rendered = renderComposeContent({ body: "hello", format: "markdown", customCss, context, renderLiquid: false });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) continue;
      for (const removed of ["!important", "color:red"]) expect(rendered.data.html).not.toContain(removed);
    }
  });

  test("rejects HTML entities in CSS strings before inlining and ignores unsafe stored declarations", () => {
    for (const selector of [".mail-content", ".mail-signature"]) {
      for (const value of [
        `"&apos;;background:u&#92;72l(https://example.test/pixel);x:&apos;"`,
        `'&quot;;background:u&#x5c;72l(https://example.test/pixel);x:&quot;'`,
      ]) {
        const customCss = `${selector} { font-family: ${value}; }`;
        expect(validateComposeCss(customCss)).toMatchObject({
          ok: false,
          error: { message: 'CSS value for "font-family" is not allowed' },
        });
        const stored = storedComposeCss(customCss);
        expect(stored.css).not.toContain("font-family");
        expect(stored.formattingWarnings).toEqual([{ code: "ignored_mailbox_css", property: "font-family" }]);
        const rendered = renderComposeContent({
          body: "Hello",
          signature: selector === ".mail-signature" ? "Regards" : undefined,
          format: "markdown",
          customCss,
          context,
          renderLiquid: false,
        });
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) continue;
        for (const removed of ["example.test", "background"]) expect(rendered.data.html).not.toContain(removed);
      }
    }
  });

  test("allows line breaks outside CSS strings and separate strings with different quotes", () => {
    for (const css of ["p { font-family: Arial,\n  sans-serif; }", `p { font-family: "Segoe UI", 'Arial', sans-serif; }`]) {
      expect(validateComposeCss(css).ok).toBe(true);
    }
  });

  test("renders old mailbox designs without unsafe values while saving stays strict", () => {
    const customCss = String.raw`.mail-content { color: #123456; font-family: "\5FAE\8F6F\96C5\9ED1", sans-serif; }
h1 { background: image-set("https://example.test/a.png" 1x); font-size: 30px; }`;
    const warnings: ComposeFormattingWarning[] = [
      { code: "ignored_mailbox_css", property: "font-family" },
      { code: "ignored_mailbox_css", property: "background" },
    ];
    expect(validateComposeCss(customCss)).toMatchObject({
      ok: false,
      error: { message: 'CSS value for "font-family" is not allowed' },
    });
    const stored = storedComposeCss(customCss);
    expect(stored.formattingWarnings).toEqual(warnings);
    expect(validateComposeCss(stored.css).ok).toBe(true);
    const rendered = renderComposeContent({ body: "# Hello", format: "markdown", customCss, context, renderLiquid: true });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toContain("color:#123456");
    expect(rendered.data.html).toContain("font-size:30px");
    for (const removed of ["\\", "5FAE", "image-set", "example.test"]) expect(rendered.data.html).not.toContain(removed);
    expect(rendered.data.formattingWarnings).toEqual(warnings);
  });

  test("renders signatures with safe stored design values while saving stays strict", () => {
    const customCss = String.raw`.mail-signature { color: #52525b; font-family: "\5FAE", sans-serif; }`;
    const rendered = renderComposeContent({
      body: "Answer",
      signature: "Regards **Ada**",
      format: "markdown",
      customCss,
      context,
      renderLiquid: false,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toContain('class="mail-signature"');
    expect(rendered.data.html).toContain("Regards <strong>Ada</strong>");
    expect(rendered.data.html).toMatch(/<div class="mail-signature" style="[^"]*color:#52525b/);
    for (const removed of ["\\", "5FAE"]) expect(rendered.data.html).not.toContain(removed);
    expect(rendered.data.formattingWarnings).toEqual([{ code: "ignored_mailbox_css", property: "font-family" }]);
    expect(validateComposeCss(customCss).ok).toBe(false);
  });

  test("removes consecutive and final bad declarations without losing safe siblings", () => {
    const stored = storedComposeCss(String.raw`p {
      color: #123456;
      background: url(https://example.test/a.png);
      font-family: u\72l(https://example.test/b.png);
      position: fixed;
      font-size: 30px;
      margin: 0 !important;
    }`);
    expect(stored.formattingWarnings).toEqual(
      ["background", "font-family", "position", "margin"].map((property) => ({ code: "ignored_mailbox_css", property })),
    );
    expect(stored.css).toContain("color: #123456");
    expect(stored.css).toContain("font-size: 30px");
    for (const removed of ["url", "\\", "position", "!important"]) expect(stored.css).not.toContain(removed);
    expect(validateComposeCss(stored.css).ok).toBe(true);
  });

  test("removes at-rules and entire rules with any disallowed selector", () => {
    const stored = storedComposeCss(`@import "https://example.test/a.css";
      @media screen { p { color: red; } }
      #id { color: red; font-size: 20px; }
      p, a:hover { color: blue; padding: 2px; }
      .other { margin: 0; }
      h1 { font-size: 30px; }`);
    expect(stored.formattingWarnings).toEqual(
      ["@import", "@media", "color", "font-size", "padding", "margin"].map((property) => ({ code: "ignored_mailbox_css", property })),
    );
    expect(stored.css.trim()).toBe("h1 { font-size: 30px; }");
    expect(validateComposeCss(stored.css).ok).toBe(true);
  });

  test("shares value limits and selector checks with strict saves", () => {
    for (const customCss of [
      `p { font-family: "${"a".repeat(513)}"; color: red; }`,
      `p${" ".repeat(201)}a { font-family: Arial; } p { color: red; }`,
      "p { background: var(--color); color: red; }",
      "p { background: expression(alert(1)); color: red; }",
      "p { background: attr(data-color); color: red; }",
    ]) {
      expect(validateComposeCss(customCss).ok).toBe(false);
      const stored = storedComposeCss(customCss);
      expect(stored.formattingWarnings).toHaveLength(1);
      expect(stored.css).toContain("color: red");
      expect(validateComposeCss(stored.css).ok).toBe(true);
    }
  });

  test("ignores the whole design on parse or size and complexity failures", () => {
    for (const customCss of [
      "p { color:",
      `p { color: red; } /*${"a".repeat(33 * 1024)}*/`,
      "p { color: red; }".repeat(201),
      `p { ${"color: red;".repeat(1_001)} }`,
    ]) {
      expect(validateComposeCss(customCss).ok).toBe(false);
      const stored = storedComposeCss(customCss);
      expect(stored).toEqual({ css: "", formattingWarnings: [{ code: "ignored_mailbox_css" }] });
      expect(validateComposeCss(stored.css).ok).toBe(true);
      const rendered = renderComposeContent({ body: "# Hello", format: "markdown", customCss, context, renderLiquid: false });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) continue;
      expect(rendered.data.html).toContain("font-size:24px");
      expect(rendered.data.formattingWarnings).toEqual(stored.formattingWarnings);
    }
  });

  test("bounds and deduplicates terminal-safe design warning properties", () => {
    const properties = [
      "position",
      "position",
      "bad\u001bname",
      "ümlaut",
      "x".repeat(100),
      ...Array.from({ length: 30 }, (_, i) => `bad${i}`),
    ];
    const stored = storedComposeCss(`p { ${properties.map((property) => `${property}: red;`).join(" ")} }`);
    expect(validateComposeCss(stored.css).ok).toBe(true);
    expect(stored.formattingWarnings).toHaveLength(MAX_COMPOSE_FORMATTING_WARNINGS);
    expect(stored.formattingWarnings.slice(0, 4)).toEqual(
      ["position", "badname", "mlaut", "x".repeat(64)].map((property) => ({ code: "ignored_mailbox_css", property })),
    );
    expect(storedComposeCss(" \n\t ")).toEqual({ css: "", formattingWarnings: [] });
  });

  test("plain text ignores even unparseable stored CSS without warnings", () => {
    const rendered = renderComposeContent({ body: "Hello", format: "plain", customCss: "p { color:", context, renderLiquid: false });
    expect(rendered).toEqual({ ok: true, data: { logoUsed: false, html: null, text: "Hello", formattingWarnings: [] } });
  });

  test("uses the built-in design when valid mailbox CSS exceeds the inline-work budget (#991)", () => {
    expect(validateComposeCss(largeMailboxCss).ok).toBe(true);
    const params = { body: longBody, format: "markdown", context, renderLiquid: false } as const;
    const baseline = renderComposeContent({ ...params, customCss: "" });
    const rendered = renderComposeContent({ ...params, customCss: largeMailboxCss });
    expect(baseline.ok).toBe(true);
    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok || !baseline.ok) return;
    expect(rendered.data.formattingWarnings).toEqual([{ code: "ignored_mailbox_css" }]);
    expect(rendered.data.html).toContain("font-family:Arial");
    for (const value of ["#991abc", "Mailbox991"]) expect(rendered.data.html).not.toContain(value);
    expect(rendered.data.html).toBe(baseline.data.html);
    expect(rendered.data.text).toBe(baseline.data.text);
  });

  test("keeps the signature when the mailbox design exceeds the inline-work budget", () => {
    const params = { body: longBody, signature: "Regards **Ada**", format: "markdown", context, renderLiquid: false } as const;
    const baseline = renderComposeContent({ ...params, customCss: "" });
    const rendered = renderComposeContent({ ...params, customCss: largeMailboxCss });
    expect(rendered).toMatchObject({ ok: true });
    expect(baseline.ok).toBe(true);
    if (!rendered.ok || !baseline.ok) return;
    expect(rendered.data.html).toContain('class="mail-signature"');
    expect(rendered.data.html).toContain("Regards <strong>Ada</strong>");
    expect(rendered.data.formattingWarnings).toEqual([{ code: "ignored_mailbox_css" }]);
    expect(rendered.data.html).toBe(baseline.data.html);
    expect(rendered.data.text).toBe(baseline.data.text);
  });

  test("uses the built-in design when inlined mailbox CSS makes the HTML too large", () => {
    const color = `rgb(0.${"1".repeat(470)}% 0% 0%)`;
    const customCss = `p {
      ${[
        "color",
        "background-color",
        "border-top-color",
        "border-right-color",
        "border-bottom-color",
        "border-left-color",
        "text-decoration-color",
      ]
        .map((property) => `${property}: ${color};`)
        .join("\n")}
      font-family: "${"Mailbox991".repeat(48)}";
      text-shadow: ${Array.from({ length: 20 }, () => "1px 2px 3px #abcdef").join(", ")};
    }`;
    expect(validateComposeCss(customCss).ok).toBe(true);
    const params = { body: longBody, format: "markdown", context, renderLiquid: false } as const;
    const baseline = renderComposeContent({ ...params, customCss: "" });
    const rendered = renderComposeContent({ ...params, customCss });
    expect(rendered).toMatchObject({ ok: true });
    expect(baseline.ok).toBe(true);
    if (!rendered.ok || !baseline.ok) return;
    expect(rendered.data.formattingWarnings).toEqual([{ code: "ignored_mailbox_css" }]);
    expect(rendered.data.html).toContain("font-family:Arial");
    for (const value of [color, "Mailbox991", "#abcdef"]) expect(rendered.data.html).not.toContain(value);
    expect(rendered.data.html).toBe(baseline.data.html);
    expect(rendered.data.text).toBe(baseline.data.text);
  });

  test("drops property warnings when none of the mailbox design can be applied", () => {
    const rendered = renderComposeContent({
      body: longBody,
      format: "markdown",
      customCss: `${largeMailboxCss}\np { position: fixed; }`,
      context,
      renderLiquid: false,
    });
    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;
    expect(rendered.data.formattingWarnings).toEqual([{ code: "ignored_mailbox_css" }]);
  });

  test("still rejects bodies that exceed the built-in design's rendering limits", () => {
    for (const customCss of ["", largeMailboxCss]) {
      expect(
        renderComposeContent({ body: "x".repeat(3 * 1024 * 1024), format: "markdown", customCss, context, renderLiquid: false }),
      ).toMatchObject({ ok: false, error: { composeRender: { reason: "tooLarge" } } });
      expect(
        renderComposeContent({ body: "<span>x</span>".repeat(1_001), format: "markdown", customCss, context, renderLiquid: false }),
      ).toMatchObject({ ok: false, error: { composeRender: { reason: "tooComplex" } } });
    }
  });

  test("rejects a body whose inlining work exceeds the budget with the built-in design alone", () => {
    // One paragraph renders as `<p>${"&amp;".repeat(n)}</p>\n`; the fallback estimate adds the built-in CSS and its separator once.
    // This body is one byte over that budget, so the fallback must fail before juice runs. The 8 MB render takes a few seconds.
    const budget = 8 * 1024 * 1024;
    const builtInCssBytes = Buffer.byteLength(`${DEFAULT_MAIL_CSS}\n`);
    const body = "&".repeat(Math.floor((budget - builtInCssBytes - "<p></p>\n".length) / "&amp;".length) + 1);
    expect(renderComposeContent({ body, format: "markdown", customCss: largeMailboxCss, context, renderLiquid: false })).toMatchObject({
      ok: false,
      error: { composeRender: { reason: "tooComplex" } },
    });
  }, 30_000);

  test("keeps the built-in stylesheet valid", () => {
    // Mailbox CSS may not use pseudo-classes; the built-in design uses `:where()` only to lower its specificity.
    expect(validateComposeCss(DEFAULT_MAIL_CSS.replace(/:where\((\.[a-z-]+)\)/g, "$1")).ok).toBe(true);
  });

  test("keeps plain text plain while resolving Liquid", () => {
    const rendered = renderComposeContent({
      body: markComposeTemplateSegment("Hello **{{ actor.display_name }}**"),
      format: "plain",
      customCss: "",
      context,
      renderLiquid: true,
    });

    expect(rendered).toEqual({ ok: true, data: { logoUsed: false, html: null, text: "Hello Ada Lovelace", formattingWarnings: [] } });
  });

  test("keeps phone links and drops a tel: link that holds no phone number", () => {
    const rendered = renderComposeContent({
      body: '[+49 731 000000](tel:+49731000000), <a href="tel:+49 (731) 000-000;ext=12">desk</a> and [not a number](tel:call-me)',
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: true,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data.html).toContain('href="tel:+49731000000"');
    expect(rendered.data.html).toContain('href="tel:+49 (731) 000-000;ext=12"');
    expect(rendered.data.html).not.toContain("call-me");
    expect(rendered.data.html).toContain("not a number</a>");
  });

  test("lets every mailbox CSS rule win over the built-in design for the same element", () => {
    const render = (customCss: string) => {
      const rendered = renderComposeContent({
        body: "Read [the offer](https://example.test/offer).",
        format: "markdown",
        customCss,
        context,
        renderLiquid: true,
      });
      if (!rendered.ok) throw new Error(rendered.error.message);
      return rendered.data.html ?? "";
    };

    expect(render("")).toContain("color:#0f766e");
    for (const css of ["a { color: #262626; }", "p a { color: #262626; }", ".mail-content a { color: #262626; }"]) {
      const html = render(css);
      expect(html).toContain("color:#262626");
      expect(html).not.toContain("#0f766e");
    }
    expect(render("p { margin: 0; }")).toContain('<p style="margin:0">');
    expect(render(".mail-content { color: #123456; }")).toMatch(/^<div style="[^"]*color:#123456/);
    // The message wrapper is a `div` too.
    const wrapper = render("div { color: #ff0000; font-size: 18px; }").match(/^<div style="([^"]*)"/)?.[1] ?? "";
    expect(wrapper).toContain("color:#ff0000");
    expect(wrapper).toContain("font-size:18px");
    expect(wrapper).not.toContain("#18181b");
    expect(wrapper).not.toContain("15px");
  });

  test("reports removed elements, attributes and links instead of dropping them silently", () => {
    expect(
      composeFormattingWarnings(
        'Text\n\n<div style="color:#999">a</div> <small>b</small> <span class="x">c</span>\n\n[j](javascript:alert(1)) [t](tel:nope)',
        "markdown",
      ),
    ).toEqual([
      { code: "unsupported_element", element: "small" },
      { code: "unsupported_attribute", element: "div", attribute: "style" },
      { code: "unsupported_attribute", element: "span", attribute: "class" },
      { code: "unsupported_link", element: "a" },
    ]);
  });

  test("reports raw HTML links whose address email removes, like Markdown links", () => {
    for (const href of ["sms:+49", "javascript:alert(1)", "data:text/html,x", "note:abc"]) {
      expect(composeFormattingWarnings(`<a href="${href}">x</a>`, "markdown")).toEqual([{ code: "unsupported_link", element: "a" }]);
      expect(composeFormattingWarnings(`[x](${href})`, "markdown")).toEqual([{ code: "unsupported_link", element: "a" }]);
    }
  });

  test("reports HTML after a closing tag or a comment in the same block", () => {
    const expected: ComposeFormattingWarning[] = [
      { code: "unsupported_element", element: "small" },
      { code: "unsupported_attribute", element: "span", attribute: "class" },
    ];
    expect(composeFormattingWarnings('<div>\n\ntext\n\n</div>\n<small>Bye</small> <span class="x">y</span>', "markdown")).toEqual(expected);
    expect(composeFormattingWarnings('<!-- note --><small>Bye</small> <span class="x">y</span>', "markdown")).toEqual(expected);
  });

  test("reports Markdown images like <img>, because email leaves both out", () => {
    const image: ComposeFormattingWarning[] = [{ code: "unsupported_element", element: "img" }];
    expect(composeFormattingWarnings("![logo](https://example.test/l.png)", "markdown")).toEqual(image);
    expect(composeFormattingWarnings('<img src="https://example.test/l.png" alt="logo">', "markdown")).toEqual(image);
  });

  test("keeps authored quote and pre elements while still reporting images", () => {
    const body = "<blockquote>x</blockquote>\n\n<pre>y</pre>";
    const image: ComposeFormattingWarning[] = [{ code: "unsupported_element", element: "img" }];
    expect(composeFormattingWarnings(body, "markdown")).toEqual([]);
    expect(
      composeFormattingWarnings(`${body}\n\n<img src="https://example.test/a.png">\n\n![a](https://example.test/b.png)`, "markdown"),
    ).toEqual(image);
  });

  test("reports names as printable text only", () => {
    const [element] = composeFormattingWarnings("<div>\n<x\u001b]0;pwn\u0007 class=y>hi</x>\n</div>", "markdown");
    expect(element).toEqual({ code: "unsupported_element", element: "x]0;pwn" });
    const [attribute] = composeFormattingWarnings('<div>\n<span \u001b[2j="1">hi</span>\n</div>', "markdown");
    expect(attribute).toEqual({ code: "unsupported_attribute", element: "span", attribute: "[2j" });
  });

  test("reports nothing for supported Markdown, supported HTML, and plain text", () => {
    const supported = [
      "**Bold**, _em_, `code`, [web](https://example.test), [mail](mailto:a@example.test), [phone](tel:+49731000000)",
      '<strong>Bold</strong> <a href="https://example.test" target="_blank">link</a><br>',
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "> A quote keeps its text",
      markComposeTemplateSegment("Regards\n{{ sender.display_name }}"),
    ];
    for (const body of supported) expect(composeFormattingWarnings(body, "markdown")).toEqual([]);
    expect(composeFormattingWarnings('<span class="x">plain</span>', "plain")).toEqual([]);
  });

  test("keeps the report short and stable for repeated and many removals", () => {
    expect(
      composeFormattingWarnings('<span class="a">1</span> <span class="b">2</span> <small>3</small> <small>4</small>', "markdown"),
    ).toEqual([
      { code: "unsupported_element", element: "small" },
      { code: "unsupported_attribute", element: "span", attribute: "class" },
    ]);
    const many = Array.from({ length: 50 }, (_, index) => `<x-tag${index}>t</x-tag${index}>`).join(" ");
    expect(composeFormattingWarnings(many, "markdown")).toHaveLength(MAX_COMPOSE_FORMATTING_WARNINGS);
    const warning = composeFormattingWarnings(`<${"x".repeat(200)}>t`, "markdown")[0];
    expect(warning?.code).toBe("unsupported_element");
    if (warning && "element" in warning) expect(warning.element).toHaveLength(64);
  });
});

describe("separate draft signatures", () => {
  test("places a signature before the attribution and quoted reply history", () => {
    const attribution = "On 1 Jan 2026, 10:00, Ada wrote:";
    const rendered = renderComposeContent({
      body: `Answer\n\n${attribution}\n> quoted line\n> second\n\n`,
      signature: "Regards **{{ actor.display_name }}**",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: false,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const html = rendered.data.html ?? "";
    expect(html).toContain('class="mail-signature"');
    expect(html.indexOf("Answer")).toBeLessThan(html.indexOf('class="mail-signature"'));
    expect(html.indexOf('class="mail-signature"')).toBeLessThan(html.indexOf(attribution));
    expect(html.indexOf("Regards <strong>Ada Lovelace</strong>")).toBeLessThan(html.indexOf(attribution));
    expect(html.indexOf(attribution)).toBeLessThan(html.indexOf("<blockquote"));
    expect(html).toMatch(/<blockquote[^>]*>\s*<p[^>]*>quoted line<br \/>second<\/p>\s*<\/blockquote>/);
  });

  test.each([
    ["Hello", "Hello", ""],
    ["Hello\n\n", "Hello", ""],
    ["Hello\n\n---------- Forwarded message ----------\nOld", "Hello", "---------- Forwarded message ----------\nOld"],
    ["Hello\n\n---------- Weitergeleitete Nachricht ----------\nAlt", "Hello", "---------- Weitergeleitete Nachricht ----------\nAlt"],
    ["Hello\n\nAda wrote:\n> Old\n> text", "Hello", "Ada wrote:\n> Old\n> text"],
    ["Hallo\n\nAm Montag schrieb Ada:\n> Alt", "Hallo", "Am Montag schrieb Ada:\n> Alt"],
    ["> Old\n\nMy answer", "> Old\n\nMy answer", ""],
    ["Hello\n\nAda wrote:\n> Old\n\n \n", "Hello", "Ada wrote:\n> Old\n\n \n"],
    ["\n\nAda wrote:\n> Old", "", "Ada wrote:\n> Old"],
    ["Hello\r\n\r\n---------- Forwarded message ----------\r\nOld", "Hello", "---------- Forwarded message ----------\r\nOld"],
    // A quote or a separator-like line that Mail did not write as history is the writer's own text.
    ["Hello\n\nNot attribution\n> Old", "Hello\n\nNot attribution\n> Old", ""],
    ["Here is what the docs say:\n\n> Quoted passage", "Here is what the docs say:\n\n> Quoted passage", ""],
    ["Here is what the docs say:\n> Quoted passage", "Here is what the docs say:\n> Quoted passage", ""],
    ["> Question\nAnswer\n\n> Open question", "> Question\nAnswer\n\n> Open question", ""],
    ["Agenda\n------ Part one ------\nText", "Agenda\n------ Part one ------\nText", ""],
    [
      "Example:\n```\n---------- Forwarded message ----------\n```\nAfter",
      "Example:\n```\n---------- Forwarded message ----------\n```\nAfter",
      "",
    ],
    ["Example:\n~~~~\nAda wrote:\n> Old\n~~~", "Example:\n~~~~\nAda wrote:\n> Old\n~~~", ""],
    ["Example:\n```md\nx\n```\n\nAda wrote:\n> Old", "Example:\n```md\nx\n```", "Ada wrote:\n> Old"],
  ])("splits quoted history in %j", (body, reply, history) => {
    expect(splitQuotedHistory(body)).toEqual({ reply, history });
  });

  test.each([
    "Ada wrote:\n> Original",
    "---------- Forwarded message ----------\nOriginal",
    "---------- Weitergeleitete Nachricht ----------\nOriginal",
  ])("renders the signature before %s", (history) => {
    const result = renderComposeContent({
      body: `Answer\n\n${history}`,
      signature: "Regards **{{ actor.display_name }}**",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: false,
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    const html = result.data.html ?? "";
    expect(html).toContain('class="mail-signature"');
    expect(html.indexOf("Answer")).toBeLessThan(html.indexOf('class="mail-signature"'));
    expect(html.indexOf("Ada Lovelace")).toBeLessThan(html.indexOf("Original"));
    expect(result.data.text.indexOf("Answer")).toBeLessThan(result.data.text.indexOf("Regards Ada Lovelace"));
    expect(result.data.text.indexOf("Regards Ada Lovelace")).toBeLessThan(result.data.text.indexOf("Original"));
  });

  test("plain signatures fill Liquid and follow bottom-posted text", () => {
    const params = { signature: "Regards {{ sender.email }}", format: "plain" as const, customCss: "", context, renderLiquid: false };
    expect(renderComposeContent({ ...params, body: "Answer\n\nAda wrote:\n> Original" })).toEqual({
      ok: true,
      data: {
        logoUsed: false,
        html: null,
        text: "Answer\n\nRegards support@example.test\n\nAda wrote:\n> Original",
        formattingWarnings: [],
      },
    });
    expect(renderComposeContent({ ...params, body: "> Original\n\nAnswer" })).toMatchObject({
      ok: true,
      data: { text: "> Original\n\nAnswer\n\nRegards support@example.test" },
    });
  });

  test("broken signatures return the signature failure", () => {
    expect(
      renderComposeContent({
        body: "Answer",
        signature: "{% if actor.email %}",
        format: "markdown",
        customCss: "",
        context,
        renderLiquid: false,
      }),
    ).toMatchObject({ ok: false, error: { composeRender: { reason: "signatureFailed" } } });
  });

  test("signature selectors are allowed and style only signature paragraphs", () => {
    for (const selector of [".mail-signature", ".mail-signature p", ".mail-content .mail-signature a"])
      expect(validateComposeCss(`${selector} { color: #52525b; }`).ok).toBeTrue();
    expect(validateComposeCss(".other p { color: #52525b; }")).toMatchObject({
      ok: false,
      error: { message: "Only .mail-content and .mail-signature class selectors are allowed" },
    });
    const result = renderComposeContent({
      body: "Answer\n\nAda wrote:\n> Original",
      signature: "Regards",
      format: "markdown",
      customCss: ".mail-signature p { color: #52525b; }",
      context,
      renderLiquid: true,
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.html).toMatch(/<div class="mail-signature"[^>]*><p[^>]*color:#52525b[^>]*>Regards<\/p>\s*<\/div>/);
    expect(result.data.html?.match(/<p[^>]*color:#52525b/g)).toHaveLength(1);
  });

  test("combined source and fragment limits include the signature", () => {
    expect(
      renderComposeContent({
        body: "x".repeat(3 * 1024 * 1024),
        signature: "Regards",
        format: "plain",
        customCss: "",
        context,
        renderLiquid: false,
      }),
    ).toMatchObject({ ok: false, error: { composeRender: { reason: "tooLarge" } } });
    expect(
      renderComposeContent({
        body: "x\n".repeat(4_990),
        signature: "y\n".repeat(20),
        format: "markdown",
        customCss: "",
        context,
        renderLiquid: false,
      }),
    ).toMatchObject({ ok: false, error: { composeRender: { reason: "tooManyLines" } } });
    expect(
      renderComposeContent({
        body: "<span>x</span>".repeat(600),
        signature: "<span>y</span>".repeat(400),
        format: "markdown",
        customCss: "",
        context,
        renderLiquid: false,
      }),
    ).toMatchObject({ ok: false, error: { composeRender: { reason: "tooComplex" } } });
  });

  test("the selected signature shares the Liquid budget with legacy segments", () => {
    // Each read advances a fake clock by 1 ms, so the budget runs out at the same read on a busy machine too.
    let clock = 0;
    let reads = 0;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    const slowContext: ComposeRenderContext = {
      ...context,
      actor: {
        ...context.actor,
        get display_name() {
          reads += 1;
          clock += 1;
          return "";
        },
      },
    };
    const segment = markComposeTemplateSegment("{% for i in (1..100) %}{{ actor.display_name }}{% endfor %}");
    const signature = "{% for i in (1..600) %}{{ actor.display_name }}{% endfor %}";
    try {
      const result = renderComposeContent({
        body: segment.repeat(6),
        signature,
        format: "markdown",
        customCss: "",
        context: slowContext,
        renderLiquid: true,
      });
      // The segments use 600 of the 1,000 ms, so the signature fails although it alone would need only 600.
      expect(result).toMatchObject({ ok: false, error: { composeRender: { reason: "signatureFailed" } } });
      expect(reads).toBeGreaterThan(600);
      expect(reads).toBeLessThan(1_200);
    } finally {
      now.mockRestore();
    }
  });

  test("null signature preserves rendering byte for byte", () => {
    for (const format of ["plain", "markdown"] as const) {
      const params = { body: "Hello  \n\n> Quote\n", format, customCss: "", context, renderLiquid: true };
      expect(renderComposeContent({ ...params, signature: null })).toEqual(renderComposeContent(params));
    }
  });

  test("moves only the first exact complete legacy signature and one separator", () => {
    const signatures = [{ id: "sig", body: "Regards {{ actor.display_name }}" }];
    const segment = markComposeTemplateSegment(signatures[0]!.body);
    expect(moveSignatureSegment(`Answer\n\n${segment}\n\nAda wrote:\n> Old`, signatures)).toEqual({
      body: "Answer\n\nAda wrote:\n> Old",
      signatureTemplateId: "sig",
    });
    expect(moveSignatureSegment(`Answer\n\n${segment}`, signatures)).toEqual({ body: "Answer", signatureTemplateId: "sig" });
    expect(moveSignatureSegment(`${segment}\n\n> Old`, signatures)).toEqual({ body: "> Old", signatureTemplateId: "sig" });
    expect(moveSignatureSegment(`${segment}\n\n${segment}`, signatures)).toEqual({ body: segment, signatureTemplateId: "sig" });
    expect(moveSignatureSegment(markComposeTemplateSegment("Different"), signatures)).toBeNull();
    expect(moveSignatureSegment("\u2063Regards {{ actor.display_name }}", signatures)).toBeNull();
    expect(moveSignatureSegment(`\u2064Answer\n\n${segment}\u2063`, signatures)).toEqual({
      body: "\u2064Answer\u2063",
      signatureTemplateId: "sig",
    });
  });

  test("removes every exact signature segment and its separator", () => {
    const source = "Regards {{ actor.display_name }}";
    const segment = markComposeTemplateSegment(source);
    expect(withoutSignatureSegments(`Answer\n\n${segment}\n\n${segment}\n\n> Old`, source)).toBe("Answer\n\n> Old");
  });

  test("keeps segments with a different source", () => {
    const source = "Regards {{ actor.display_name }}";
    const other = markComposeTemplateSegment(`${source} `);
    expect(withoutSignatureSegments(`Answer\n\n${other}\n\n${markComposeTemplateSegment(source)}`, source)).toBe(`Answer\n\n${other}`);
  });

  test("leaves a body without segment marks unchanged", () => {
    const body = "Regards {{ actor.display_name }}  \n\n";
    expect(withoutSignatureSegments(body, "Regards {{ actor.display_name }}")).toBe(body);
  });
});

describe("mailbox signature logos", () => {
  const logo = {
    src: "cid:logo.00000000-0000-4000-8000-000000000001@example.test",
    altText: 'Team "<>& $&',
    displayWidth: 234,
    byteLength: 68,
  };
  const render = (input: Partial<Parameters<typeof renderComposeContent>[0]> = {}) =>
    renderComposeContent({
      body: "Hello",
      format: "markdown",
      customCss: "",
      context,
      renderLiquid: true,
      signature: "{{ mailbox.logo }}",
      logo,
      ...input,
    });
  test("checks the plain-text size of repeated alt text before expanding it", () => {
    const signature = "{% for i in (1..100) %}{% for j in (1..100) %}{{ mailbox.logo }}{% endfor %}{% endfor %}";
    const wide = { ...logo, altText: "\u20ac".repeat(200) };
    expect(render({ format: "plain", signature, logo: wide })).toMatchObject({
      ok: false,
      error: { composeRender: { reason: "tooLarge" } },
    });
    expect(render({ format: "plain", signature: "{{ mailbox.logo }} {{ mailbox.logo }}", logo: wide })).toMatchObject({
      ok: true,
      data: { text: `Hello\n\n${wide.altText} ${wide.altText}` },
    });
  });
  test("inserts one trusted CID image after sanitizing and keeps literal alt text in plain text", () => {
    const result = render();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.logoUsed).toBe(true);
    expect(result.data.html?.match(/<img /g)).toHaveLength(1);
    expect(result.data.html).toContain(
      `<img src="${logo.src}" alt="Team &#34;&#60;&#62;&#38; $&#38;" width="234" style="display:block;border:0;height:auto;max-width:100%">`,
    );
    expect(result.data.text).toContain(logo.altText);
    expect(result.data.html).not.toContain("MAILLOGO");
    expect(result.data.text).not.toContain("MAILLOGO");
  });
  test("budgets repeated logos as data URLs before allocating images in both delivery modes", () => {
    const byteLength = 100 * 1024;
    for (const mode of ["cid", "data"] as const) {
      const src = mode === "cid" ? logo.src : `data:image/png;base64,${Buffer.alloc(byteLength).toString("base64")}`;
      let sourceReads = 0;
      const largeLogo = {
        ...logo,
        byteLength,
        get src() {
          sourceReads += 1;
          return src;
        },
      };
      expect(render({ signature: "{{ mailbox.logo }}".repeat(30), logo: largeLogo })).toMatchObject({
        ok: false,
        error: { composeRender: { reason: "tooLarge" } },
      });
      expect(sourceReads).toBe(0);
      const two = render({ signature: "{{ mailbox.logo }}".repeat(2), logo: largeLogo });
      expect(two).toMatchObject({ ok: true });
      if (two.ok) expect(two.data.html?.match(/<img /g)).toHaveLength(2);
    }
  });
  test("counts inserted images toward the HTML element budget", () => {
    expect(render({ signature: "{{ mailbox.logo }}".repeat(999) })).toMatchObject({
      ok: false,
      error: { composeRender: { reason: "tooComplex" } },
    });
  });
  test("accepts exact tags and whitespace control in selected and stored signatures", () => {
    for (const tag of [
      "{{ mailbox.logo }}",
      "{{mailbox.logo}}",
      "{{- mailbox.logo -}}",
      "{{- mailbox.logo }}",
      "{{ mailbox.logo -}}",
      "{{\nmailbox.logo\n}}",
    ]) {
      expect(validateComposeTemplateSource(tag)).toMatchObject({ ok: true });
      expect(render({ signature: tag })).toMatchObject({ ok: true, data: { logoUsed: true } });
      const segment = markComposeTemplateSegment(tag);
      expect(hasUnrenderedTemplateSyntax(segment)).toBe(false);
      const legacy = render({ signature: null, body: segment });
      expect(legacy).toMatchObject({ ok: true, data: { logoUsed: true } });
      if (legacy.ok) expect(legacy.data.html).toContain(`<img src="${logo.src}"`);
    }
    expect(renderComposeTemplateSource("left  {{- mailbox.logo -}}  right", context, "markdown")).toEqual({ ok: true, data: "leftright" });
  });
  test("rejects filters, conditions, assignments and bracket access to the logo", () => {
    for (const signature of [
      "{{ mailbox.logo | downcase }}",
      "{% if mailbox.logo %}x{% endif %}",
      "{% assign l = mailbox.logo %}{{ l }}",
      '{{ mailbox["logo"] }}',
    ]) {
      expect(validateComposeTemplateSource(signature)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('variable "mailbox.logo" is not available') },
      });
      expect(render({ signature })).toMatchObject({ ok: false });
      expect(renderComposeTemplateSource(signature, context, "markdown")).toMatchObject({ ok: false });
    }
  });
  test("rejects oversized unterminated Liquid output before scanning URL contexts", () => {
    const source = "{{".repeat(40_000);
    const start = performance.now();
    const result = validateComposeTemplateSource(source);
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });
  test("rejects any capture tag alongside an exact logo tag", () => {
    for (const capture of [
      "{% capture sig %}{{ mailbox.logo }}{% endcapture %}{{ sig | downcase }}",
      "{%- capture sig -%}{{- mailbox.logo -}}{%- endcapture -%}{{ sig | downcase }}",
      "{% liquid\n capture sig\n echo 'other text'\n endcapture\n%}{{ mailbox.logo }}",
      "{%- liquid\n\tcapture sig\n echo 'other text'\n endcapture\n-%}{{ mailbox.logo }}",
      "{% capture other %}Unrelated{% endcapture %}{{ mailbox.logo }}",
    ]) {
      expect(validateComposeTemplateSource(capture)).toMatchObject({
        ok: false,
        error: { message: "{{ mailbox.logo }} cannot be used together with capture" },
      });
      expect(render({ signature: capture })).toMatchObject({
        ok: false,
        error: { composeRender: { reason: "signatureFailed" } },
      });
    }
    expect(validateComposeTemplateSource("{% capture sig %}Regards{% endcapture %}{{ sig | downcase }}").ok).toBe(true);
    expect(validateComposeTemplateSource("{{ mailbox.logo }} capture {% assign capture = 'text' %}{{ capture }}").ok).toBe(true);
  });
  test("fails closed when a rendered logo marker is transformed or loses its prefix", () => {
    const randomPart = "ABCDEF01234546789ABCDEF012345678";
    const token = `MAILLOGO${randomPart}`;
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue("abcdef01-2345-4678-9abc-def012345678");
    try {
      for (const format of ["plain", "markdown"] as const) {
        for (const marker of [
          token.toLowerCase(),
          `MAILLOGO${randomPart.toLowerCase()}`,
          randomPart,
          `changed${randomPart.toLowerCase()}`,
        ]) {
          const result = render({
            format,
            signature: "{{ mailbox.logo }} {{ actor.display_name }}",
            context: { ...context, actor: { ...context.actor, display_name: marker } },
          });
          expect(result).toMatchObject({ ok: false, error: { composeRender: { reason: "signatureFailed" } } });
          expect(render({ format, signature: null, body: marker })).toMatchObject({
            ok: false,
            error: { composeRender: { reason: "signatureFailed" } },
          });
        }
        expect(render({ format, signature: "{{ mailbox.logo }} {{ mailbox.logo }}" })).toMatchObject({ ok: true });
        expect(render({ format, body: "MAILLOGO11111111222243338444555555555555" })).toMatchObject({ ok: true });
      }
    } finally {
      uuid.mockRestore();
    }
  });
  test("removes an unavailable logo and reports its formatting warning", () => {
    for (const format of ["plain", "markdown"] as const) {
      const result = render({ logo: null, format });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.data.logoUsed).toBe(true);
      expect(result.data.formattingWarnings).toEqual([{ code: "missing_mailbox_logo" }]);
      expect(result.data.html ?? "").not.toContain("<img");
      expect(result.data.html ?? "").not.toContain("MAILLOGO");
      expect(result.data.text).toBe("Hello");
    }
  });
  test("plain signatures use alt text and legacy signature segments use the same image", () => {
    const plain = render({ format: "plain" });
    expect(plain).toMatchObject({ ok: true, data: { html: null, text: `Hello\n\n${logo.altText}`, logoUsed: true } });
    const legacy = render({ signature: null, body: markComposeTemplateSegment("{{ mailbox.logo }}") });
    expect(legacy).toMatchObject({ ok: true, data: { logoUsed: true, text: logo.altText } });
    if (legacy.ok) expect(legacy.data.html).toContain(`<img src="${logo.src}"`);
  });
  test("snippets render the logo empty, even if the caller supplies a value", () => {
    const logoContext = { ...context, mailbox: { ...context.mailbox, logo: "unexpected" } };
    for (const format of ["plain", "markdown"] as const)
      expect(renderComposeTemplateSource("{{ mailbox.logo }}", logoContext, format)).toEqual({ ok: true, data: "" });
  });
  test("rejects logo output in link destinations, titles, references and HTML tags", () => {
    for (const signature of [
      "[x]({{ mailbox.logo }})",
      '[Contact](https://example.test "{{ mailbox.logo }}")',
      "[Contact]: {{ mailbox.logo }}",
      '<a href="{{ mailbox.logo }}">x</a>',
    ]) {
      expect(validateComposeTemplateSource(signature).ok).toBe(false);
      expect(render({ signature }).ok).toBe(false);
    }
  });
  test("keeps rejecting user images and remote CSS images alongside the trusted logo", () => {
    const body = '![remote](https://example.test/logo.png)\n\n<img src="https://example.test/raw.png">';
    const result = render({ body });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.html?.match(/<img /g)).toHaveLength(1);
    expect(result.data.html).not.toContain('src="http');
    expect(composeFormattingWarnings(body, "markdown")).toContainEqual({ code: "unsupported_element", element: "img" });
    for (const value of ['url("https://example.test/logo.png")', 'image-set("https://example.test/logo.png" 1x)']) {
      expect(validateComposeCss(`p { background: ${value}; }`).ok).toBe(false);
    }
  });
});

test("missing mailbox logo warnings have English and German reader text", async () => {
  const { describeComposeFormattingWarning } = await import("../compose-formatting-messages");
  expect(describeComposeFormattingWarning({ code: "missing_mailbox_logo" }, "en")).toContain("no logo is uploaded");
  expect(describeComposeFormattingWarning({ code: "missing_mailbox_logo" }, "de")).toContain("keines hochgeladen");
});
