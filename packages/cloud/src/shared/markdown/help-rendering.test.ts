import { describe, expect, test } from "bun:test";
import { markdownToPlainText, renderHelpMarkdown, renderMarkdown } from ".";

describe("renderHelpMarkdown", () => {
  test("highlights JavaScript while keeping help examples inert", () => {
    const html = renderHelpMarkdown('```script\nconst message = "hello";\n```');

    expect(html).toContain('<span class="hl-keyword">const</span>');
    expect(html).toContain('<span class="hl-string">"hello"</span>');
    expect(html).not.toContain("data-script-source");
  });

  test("supports documentation languages through the shared highlighter", () => {
    const html = renderHelpMarkdown("```gql\nquery Item($id: ID!) { item(id: $id) { id } }\n```\n\n```yaml\nenabled: true\n```");

    expect(html).toContain('<span class="hl-keyword">query</span>');
    expect(html).toContain('<span class="hl-variable">$id</span>');
    expect(html).toContain('<span class="hl-keyword">true</span>');
  });

  test("renders guided sections with stable ids without heading icons", () => {
    const html = renderHelpMarkdown('## Start here {icon="route"}\n\nText\n\n## Start here {icon="route"}');

    expect(html).toContain('id="start-here"');
    expect(html).toContain('id="start-here-2"');
    expect(html).not.toContain("data-help-icon");
    expect(html).not.toContain("help-section-icon");
    expect(html).not.toContain("ti-point");
    expect(html).not.toContain("{icon=");
  });

  test("preserves inline Markdown in guided section titles", () => {
    const html = renderHelpMarkdown('## Branch with `switch` {icon="point"}');

    expect(html).toContain(">Branch with <code");
    expect(html).toContain(">switch</code></h2>");
    expect(html).not.toContain("{icon=");
  });

  test("distinguishes standalone labels from emphasized terms in body copy", () => {
    const html = renderHelpMarkdown(["**Find exact records**", "", "A **base** contains tables and resources."].join("\n"));

    expect(html).toContain('<p class="help-eyebrow"><strong>Find exact records</strong></p>');
    expect(html).toContain("<p>A <strong>base</strong> contains tables and resources.</p>");
    expect(html.match(/class="help-eyebrow"/g)).toHaveLength(1);
  });

  test("renders explicit guided blocks without changing ordinary lists", () => {
    const html = renderHelpMarkdown(
      [
        ":::steps",
        "1. **Choose:** Pick one.",
        "2. **Finish:** Save it.",
        ":::",
        "",
        ":::reference",
        "- **Name:** Human-readable label.",
        "- **ID:** Stable identifier.",
        ":::",
        "",
        ":::compare",
        "- **Markdown:** Rich output.",
        "- **Plain text:** Simple output.",
        ":::",
        "",
        "1. An ordinary ordered list.",
      ].join("\n"),
    );

    expect(html).toContain('class="help-steps"');
    expect(html).toContain('class="help-reference"');
    expect(html).toContain('class="help-compare"');
    expect(html.match(/class="help-steps"/g)).toHaveLength(1);
    expect(html).toContain("An ordinary ordered list.");
  });

  test("does not interpret guided syntax inside fenced examples", () => {
    const html = renderHelpMarkdown(
      ["```md", '## Example {icon="route"}', "", ":::steps", "1. A documented step.", ":::", "```"].join("\n"),
    );

    expect(html).toContain("## Example");
    expect(html).toContain('{icon="route"}');
    expect(html).toContain(":::steps");
    expect(html).not.toContain('class="help-steps"');
    expect(html).not.toContain('class="help-section-title"');
  });

  test("keeps unsupported directives as ordinary help content", () => {
    const html = renderHelpMarkdown([":::timeline", "- A dated event", ":::"].join("\n"));

    expect(html).not.toContain('class="help-timeline"');
    expect(html).toContain("timeline");
    expect(html).toContain("A dated event");
  });
});

test("key caps use the shared Kbd markup, reader platform and locale without leaking between calls", () => {
  expect(renderHelpMarkdown(":kbd[mod+k]")).toBe(
    '<p><kbd class="k2b-kbd"><span class="k2b-sr-only">Control K</span><span class="k2b-kbd__keys" aria-hidden="true"><kbd class="k2b-kbd__key">Ctrl</kbd><kbd class="k2b-kbd__key">K</kbd></span></kbd></p>\n',
  );
  expect(renderHelpMarkdown(":kbd[mod+k]", { platform: "apple" })).toContain('<kbd class="k2b-kbd__key">⌘</kbd>');
  const german = renderHelpMarkdown(":kbd[mod+k]", { locale: "de" });
  expect(german).toContain('class="k2b-sr-only">Steuerung K</span>');
  expect(german).toContain('class="k2b-kbd__key">Strg</kbd>');
  expect(renderHelpMarkdown(":kbd[mod+k]")).toContain(">Ctrl</kbd>");
  expect(renderMarkdown(":kbd[mod+k]")).toContain(":kbd[mod+k]");
  expect(renderHelpMarkdown("`:kbd[mod+k]`")).not.toContain('class="k2b-kbd"');
});

test("labels and menu paths use chips while preserving inline Markdown", () => {
  expect(renderHelpMarkdown('**Hide**{icon="eye-off"}')).toContain(
    '<span class="k2b-label-chip"><i class="ti ti-eye-off" aria-hidden="true"></i>Hide</span>',
  );
  const path = renderHelpMarkdown('**Space *settings* → Sharing**{icon="settings"}');
  expect(path).toContain('<span class="help-menu-path">');
  expect(path).toContain("Space <em>settings</em>");
  expect(path.match(/class="k2b-label-chip"/g)).toHaveLength(2);
  expect(path.match(/ti-settings/g)).toHaveLength(1);
  expect(path).toContain('<span class="help-menu-path-separator" aria-hidden="true">›</span><span class="k2b-sr-only">→</span>');
  expect(renderHelpMarkdown("**Settings → Sharing**")).toContain("help-menu-path");
  expect(renderHelpMarkdown("**View**")).toContain("<strong>View</strong>");
});

test("details start closed, contain guided blocks and keep their full searchable text", () => {
  const source =
    ":::details Why *share*?\nHidden but searchable.\n\n:::steps\n1. Choose **Share**.\n:::\n\n:::warning Risk\nRead carefully.\n:::\n:::";
  const html = renderHelpMarkdown(source);
  expect(html).toContain('<details class="k2b-disclosure help-details" data-surface="plain"><summary><span>Why <em>share</em>?</span>');
  expect(html).not.toContain(" open");
  expect(html).toContain('<ol class="k2b-steps">');
  expect(html).toContain("Read carefully.");
  expect(html).not.toContain(":::");
  expect(markdownToPlainText(source)).toContain("Hidden but searchable.");
  expect(markdownToPlainText(source)).toContain("Choose Share.");
  expect(renderHelpMarkdown(":::details\nText\n:::")).toContain(":::details");
});

test("Help references use normal internal links only when resolved", () => {
  const target = {
    appId: "mail",
    appName: "Mail",
    documentId: "mail-invitations",
    title: "Invitations",
    url: "/help/apps/mail/mail-invitations",
  };
  const source = "[Reply](help:mail/mail-invitations#reply)";
  const html = renderHelpMarkdown(source, {
    links: (ref) => {
      expect(ref).toMatchObject({ appId: "mail", documentId: "mail-invitations" });
      return target;
    },
  });
  expect(html).toContain('href="/help/apps/mail/mail-invitations#reply"');
  expect(html).not.toContain('target="_blank"');
  for (const options of [{}, { links: () => undefined }]) {
    const hidden = renderHelpMarkdown(source, options);
    expect(hidden).toBe("<p>Reply</p>\n");
    expect(hidden).not.toContain("mail-invitations");
    expect(hidden).not.toContain("href");
  }
  expect(
    renderHelpMarkdown("[Reply](help:mail-invitations)", {
      links: (ref) => {
        expect(ref.appId).toBeUndefined();
        return target;
      },
    }),
  ).toContain('href="/help/apps/mail/mail-invitations"');
});

test("native disclosure markup is allowed only by the Help profile", () => {
  const source = '<details open data-surface="plain"><summary>Question</summary>Answer</details>';
  expect(renderMarkdown(source)).not.toContain("<details");
  expect(renderHelpMarkdown(source)).toContain('<details data-surface="plain">');
  expect(renderHelpMarkdown(source)).not.toContain(" open");
});
