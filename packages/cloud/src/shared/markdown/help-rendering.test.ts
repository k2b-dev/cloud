import { describe, expect, test } from "bun:test";
import { helpAgentMarkdown } from "../../_internal/help-catalog";
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
  expect(renderHelpMarkdown('**Open `Settings`**{icon="settings"}')).toContain(">Settings</code>");
});

test("a label icon applies only to the immediately preceding strong span", () => {
  const markdown = '**a** **b**{icon="eye-off"}';
  const html = renderHelpMarkdown(markdown);
  expect(html).toContain('<strong>a</strong> <span class="k2b-label-chip"><i class="ti ti-eye-off" aria-hidden="true"></i>b</span>');
  expect(html.match(/class="k2b-label-chip"/g)).toHaveLength(1);
  expect(helpAgentMarkdown({ markdown, locale: "en", appId: "a", links: {} })).toBe("**a** **b**");
});

test("details start closed, contain guided blocks and keep their full searchable text", () => {
  const source =
    ":::details Why *share*?\nHidden but [searchable][r].\n\n:::steps\n1. Choose **Share**.\n:::\n:::\n\n[r]: https://example.com";
  const html = renderHelpMarkdown(source);
  expect(html).toContain('<details class="k2b-disclosure help-details" data-surface="plain"><summary><span>Why <em>share</em>?</span>');
  expect(html).not.toContain(" open");
  expect(html).toContain('<ol class="k2b-steps">');
  // The body belongs to the document: a link definition below the block still applies.
  expect(html).toContain('href="https://example.com"');
  expect(html).not.toContain(":::");
  expect(markdownToPlainText(source)).toContain("Hidden but searchable.");
  expect(markdownToPlainText(source)).toContain("Choose Share.");
  expect(renderHelpMarkdown(":::details\nText\n:::")).toContain(":::details");
});

test("details end at their own closing line, never inside code, and an unclosed block stays text", () => {
  const fenced = renderHelpMarkdown(":::details Example\n```md\n``` not a closing fence\n:::\n```\nAfter.\n:::");
  expect(fenced).toContain("``` not a closing fence\n:::</code>");
  expect(fenced).toContain("<p>After.</p>\n</div></details>");
  const unclosed = renderHelpMarkdown(":::details Open\n".repeat(400));
  expect(unclosed).not.toContain("<details");
  expect(unclosed).toContain(":::details Open");
});

test("a later details opener closes independently while the earlier opener stays text", () => {
  const html = renderHelpMarkdown(":::details A\n\n:::details B\nBody\n:::");
  expect(html).toContain("<p>:::details A</p>");
  expect(html.match(/<details /g)).toHaveLength(1);
  expect(html).toContain("<summary><span>B</span>");
  expect(html).toContain("<p>Body</p>");
  const fenced = renderHelpMarkdown(":::details A\n```md\n:::details B\n```\n:::");
  expect(fenced.match(/<details /g)).toHaveLength(1);
  expect(fenced).toContain("<summary><span>A</span>");
  expect(fenced).toContain(":::details B</code>");
});

for (const [kind, block] of [
  ["details", ":::details Title\nBody\n:::"],
  ["steps", ":::steps\n1. A\n:::"],
  ["reference", ":::reference\nBody\n:::"],
  ["compare", ":::compare\nBody\n:::"],
] as const) {
  test(`${kind} after a text line stays paragraph text`, () => {
    const html = renderHelpMarkdown(`X\n${block}`);
    expect(html).toStartWith("<p>X<br />:::");
    expect(html).not.toContain("<details");
    expect(html).not.toContain(`<div class="help-${kind}">`);
  });
  test(`${kind} after a blank line renders a block`, () => {
    const html = renderHelpMarkdown(`X\n\n${block}`);
    expect(html).toStartWith("<p>X</p>");
    expect(html).toContain(kind === "details" ? "<details " : `<div class="help-${kind}">`);
    expect(html).not.toContain(" open");
  });
}

for (const [name, source] of [
  ["indented backticks inside a fence", ":::details Example\n```md\n    ```\n:::\n```\nAfter.\n:::"],
  ["an unclosed quote fence", ":::details Title\n> ```\n> code\n\nAfter.\n:::"],
  ["an unclosed list fence", ":::details Title\n- ```\n  code\n\nAfter.\n:::"],
] as const) {
  test(`details keep ${name} and following prose in their body`, () => {
    const html = renderHelpMarkdown(source);
    expect(html.match(/<details /g)).toHaveLength(1);
    expect(html).toContain("<p>After.</p>\n</div></details>");
    if (name === "indented backticks inside a fence") expect(html).toContain("    ```\n:::</code>");
  });
}

test("details keep container fences and following prose in their body", () => {
  for (const prefix of ["- ", "+ ", "* ", "1. ", "1) ", "> ", "> - "]) {
    const continuation = prefix.replace(/[^>]/g, " ");
    for (const fence of ["```", "~~~"]) {
      const html = renderHelpMarkdown(
        `:::details Example\n${prefix}${fence}md\n${continuation}:::\n${continuation}${fence}\n\nAfter.\n:::`,
      );
      expect(html.match(/<details /g)).toHaveLength(1);
      expect(html).toContain(":::</code>");
      expect(html).toContain("<p>After.</p>\n</div></details>");
    }
  }
  const html = renderHelpMarkdown(":::details Example\n- ```md\n  :::\n  ```\nAfter.\n:::");
  expect(html.match(/<details /g)).toHaveLength(1);
  expect(html).toContain("After.");
  expect(html.indexOf("After.")).toBeLessThan(html.indexOf("</details>"));
});

// Count regex search spans and copied array elements so machine load cannot change the bound.
const countHelpWork = (run: () => unknown): number => {
  const exec = RegExp.prototype.exec;
  const concat = Array.prototype.concat;
  let work = 0;
  // Existing non-Help start hooks rescan suffixes; count their calls, without charging their search spans.
  const contentStarts = new Set([/^```math/m, /\$\$/, /(?<!\$)\$(?!\$)/, /==(?!=)/, /(?<!~)~(?!~)/, /\^/].map((pattern) => pattern.source));
  try {
    RegExp.prototype.exec = function (source) {
      const start = this.global || this.sticky ? this.lastIndex : 0;
      const match = exec.call(this, source);
      work +=
        !contentStarts.has(this.source) && (!this.source.startsWith("^") || this.multiline || start > 0)
          ? Math.max(1, (match ? match.index + match[0].length : source.length) - start)
          : 1;
      return match;
    };
    Array.prototype.concat = function (...items) {
      work += this.length;
      return concat.apply(this, items);
    };
    run();
  } finally {
    RegExp.prototype.exec = exec;
    Array.prototype.concat = concat;
  }
  return work;
};
test("work counter charges regex search spans and keeps anchored calls constant", () => {
  expect(countHelpWork(() => /needle/.exec("xxxxneedle"))).toBe(10);
  expect(countHelpWork(() => /missing/.exec("xxxxneedle"))).toBe(10);
  expect(countHelpWork(() => /^needle/.exec("xxxxneedle"))).toBe(1);
  expect(countHelpWork(() => /^needle/m.exec("xxxx\nneedle"))).toBe(11);
  const global = /needle/g;
  global.lastIndex = 4;
  expect(countHelpWork(() => global.exec("xxxxneedle"))).toBe(6);
  const sticky = /^needle/y;
  sticky.lastIndex = 4;
  expect(countHelpWork(() => sticky.exec("xxxxneedle"))).toBe(6);
});

for (const [name, size, build] of [
  ["consecutive unclosed details", 1500, (size: number) => Array.from({ length: size }, (_, index) => `:::details Q${index}\n`).join("")],
  [
    "blank-separated unclosed details",
    500,
    (size: number) => Array.from({ length: size }, (_, index) => `:::details Q${index}\n\n`).join(""),
  ],
  ["adjacent guided blocks", 100, (size: number) => "Intro\n:::reference\nBody\n:::\n".repeat(size)],
  ["adjacent details blocks", 100, (size: number) => "Intro\n:::details Q\nBody\n:::\n".repeat(size)],
  ["ordinary paragraphs", 300, (size: number) => "Ordinary paragraph.\n\n".repeat(size)],
  ["ordinary strong runs", 6000, (size: number) => "**a** ".repeat(size)],
  // A trailing icon exposes repeated lexing of preceding spans, even when the final output is unchanged.
  ["strong runs before a label", 150, (size: number) => `${"**a** ".repeat(size)}**b**{icon="eye-off"}`],
] as const) {
  for (const [operation, run] of [
    ["render", (markdown: string) => renderHelpMarkdown(markdown)],
    ["convert", (markdown: string) => helpAgentMarkdown({ markdown, locale: "en", appId: "a", links: {} })],
  ] as const) {
    test(`${name} ${operation} with linear work`, () => {
      const small = build(size);
      const large = build(size * 2);
      let output = "";
      const smallWork = countHelpWork(() => run(small));
      const largeWork = countHelpWork(() => {
        output = run(large);
      });
      expect(largeWork).toBeLessThanOrEqual(smallWork * 2.5);
      expect(output).not.toContain("<details");
      if (operation === "convert") expect(output).toBe(large.replaceAll('{icon="eye-off"}', ""));
    });
  }
}

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

test("a non-breaking space does not close a code fence inside details", () => {
  const html = renderHelpMarkdown(":::details Example\n```md\n```\u00a0\n:::\n```\nAfter.\n:::");
  expect(html.match(/<details /g)).toHaveLength(1);
  expect(html).toContain("```\u00a0\n:::</code>");
  expect(html).toContain("<p>After.</p>\n</div></details>");
});

test("unknown directives inside details remain literal body text", () => {
  const html = renderHelpMarkdown(":::details Title\n:::timeline\nText\n:::");
  expect(html.match(/<details /g)).toHaveLength(1);
  expect(html).toContain(":::timeline");
  expect(html).toContain("Text");
});
