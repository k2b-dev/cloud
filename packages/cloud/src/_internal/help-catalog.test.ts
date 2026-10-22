import { describe, expect, test } from "bun:test";
import { helpAgentMarkdown, helpResourceUri, parseHelpResourceUri, readHelpArticle, selectHelpMarkdown } from "./help-catalog";

describe("Help excerpts", () => {
  test("round-trips stable Help resource URIs", () => {
    const uri = helpResourceUri("inventory", "getting started");
    expect(uri).toBe("cloud://help/inventory/getting%20started");
    expect(parseHelpResourceUri(uri)).toEqual({ appId: "inventory", documentId: "getting started" });
    expect(parseHelpResourceUri("https://example.com/help")).toBeNull();
  });
});

test("exact headings select complete sections in short and long articles", () => {
  for (const filler of ["Short intro.", "Background. ".repeat(800)]) {
    const markdown = `${filler}\n\n## example.ui.select {icon="code"}\nSignature\n\n### Example\nExample code\n\n## example.ui.table {icon="table"}\nOther method`;
    const selected = selectHelpMarkdown(markdown, "example.ui.select");
    expect(selected?.markdown).toContain("### Example\nExample code");
    expect(selected?.markdown).not.toContain("example.ui.table");
    expect(selected?.markdown.length).toBeLessThan(7000);
  }
});

test("keeps long relevant excerpts bounded", () => {
  const selected = selectHelpMarkdown("Background. ".repeat(900) + "\n\n## Access\nEditors can update inventory.", "Access");
  expect(selected.markdown).toContain("Editors can update inventory");
  expect(selected.markdown.length).toBeLessThanOrEqual(7000);
  expect(selected.truncated).toBe(true);
});

const agentArticle = (markdown: string, locale = "en") => ({
  markdown,
  locale,
  appId: "mail",
  links: {
    "mail/mail-invitations": {
      appId: "mail",
      appName: "Mail",
      documentId: "mail-invitations",
      title: "Invitations",
      url: "/help/apps/mail/mail-invitations",
    },
  },
});

test("long German article excerpts score untitled callouts in the article locale", () => {
  const markdown = [
    "## Hintergrund",
    "Allgemeine Grundlagen. ".repeat(400),
    "## Sicherheit",
    ":::warning\nDieser Vorgang entfernt alle gespeicherten Entwürfe.\n:::",
    "## Weitere Informationen",
    "Zusätzliche Erläuterungen. ".repeat(400),
  ].join("\n\n");
  expect(markdown.length).toBeGreaterThan(7000);
  expect(markdown).not.toContain("Warnung");
  const document = {
    ...agentArticle(markdown, "de"),
    appName: "Mail",
    manifestHash: "current",
    documentId: "sicherheit",
    title: "Sicherheit",
    order: 10,
    kind: "reference" as const,
    related: [],
  };
  const result = readHelpArticle(document, "Warnung");
  expect(result.markdown).toContain("Dieser Vorgang entfernt alle gespeicherten Entwürfe.");
  expect(result.markdown.startsWith("## Sicherheit")).toBe(true);
  expect(result.markdown).not.toContain("Allgemeine Grundlagen.");
  expect(result.truncated).toBe(true);
});

test("agent text names both keyboard platforms in the document language", () => {
  expect(helpAgentMarkdown(agentArticle(":kbd[mod+k]"))).toBe("Ctrl+K (⌘K on Mac)");
  expect(helpAgentMarkdown(agentArticle(":kbd[mod+k]", "de-CH"))).toBe("Strg+K (⌘K auf dem Mac)");
  expect(helpAgentMarkdown(agentArticle(":kbd[mod+k]", "fr"))).toBe("Ctrl+K (⌘K on Mac)");
  // A key without a platform modifier reads by its name.
  expect(helpAgentMarkdown(agentArticle(":kbd[esc]"))).toBe("Escape");
  expect(helpAgentMarkdown(agentArticle(":kbd[enter]", "de"))).toBe("Eingabetaste");
});

test("agent text keeps emphasis, unfolds details and resolves visible Help references", () => {
  expect(helpAgentMarkdown(agentArticle('**Hide**{icon="eye-off"}'))).toBe("**Hide**");
  expect(helpAgentMarkdown(agentArticle('## Hide {icon="eye-off"}'))).toBe("## Hide");
  expect(helpAgentMarkdown(agentArticle(":::details Why?\nFull details.\n\n:::steps\n1. Press :kbd[esc].\n:::\n:::"))).toBe(
    "**Why?**\n\nFull details.\n\n:::steps\n1. Press Escape.\n:::\n",
  );
  expect(helpAgentMarkdown(agentArticle("[text](help:mail/mail-invitations#reply)"))).toBe(
    "[text](/help/apps/mail/mail-invitations#reply)",
  );
  expect(helpAgentMarkdown(agentArticle("[text](help:mail-invitations#reply)"))).toBe("[text](/help/apps/mail/mail-invitations#reply)");
  expect(helpAgentMarkdown(agentArticle("[text](help:hidden/private)"))).toBe("text");
});

test("agent text escapes Markdown punctuation in key names", () => {
  expect(helpAgentMarkdown(agentArticle("| Key | Action |\n| --- | --- |\n| :kbd[mod+\\|] | Split |"))).toBe(
    "| Key | Action |\n| --- | --- |\n| Ctrl+\\| (⌘\\| on Mac) | Split |",
  );
  expect(helpAgentMarkdown(agentArticle("Press :kbd[mod+`] now."))).toBe("Press Ctrl+\\` (⌘\\` on Mac) now.");
  expect(helpAgentMarkdown(agentArticle("Press :kbd[mod+k] or :kbd[shift+/]."))).toBe("Press Ctrl+K (⌘K on Mac) or Shift+/ (⇧/ on Mac).");
});

test("agent text excludes unresolved link titles containing label delimiters", () => {
  expect(helpAgentMarkdown(agentArticle('[Read](help:hidden/private "text ](here")'))).toBe("Read");
});

test("agent text excludes resolved link titles containing label delimiters", () => {
  expect(helpAgentMarkdown(agentArticle('[Read](help:mail-invitations "text ](here")'))).toBe("[Read](/help/apps/mail/mail-invitations)");
});

test("agent text preserves nested brackets and code spans in Help link labels", () => {
  for (const label of ["a [b] c", "a `]` c", "a `` `x` ] `` c", "a \\] c", "a \\``]` c"]) {
    expect(helpAgentMarkdown(agentArticle(`[${label}](help:mail-invitations)`))).toBe(`[${label}](/help/apps/mail/mail-invitations)`);
  }
});

test("agent rewriting preserves code and unrelated source formatting", () => {
  const source =
    '` :kbd[mod+k] **Hide**{icon="eye-off"} [x](help:hidden/private) `\n\n```md\n:::details Code\n:kbd[mod+k]\n**Hide**{icon="eye-off"}\n[x](help:hidden/private)\n:::\n```\n';
  expect(helpAgentMarkdown(agentArticle(source))).toBe(source);
  expect(helpAgentMarkdown(agentArticle(":::reference\n- Use :kbd[mod+k].\n:::"))).toBe(":::reference\n- Use Ctrl+K (⌘K on Mac).\n:::");
});

test("the read limit applies after expanding shortcuts into agent text", () => {
  const document = {
    ...agentArticle(":kbd[mod+k] ".repeat(580)),
    appName: "Mail",
    manifestHash: "current",
    documentId: "shortcuts",
    title: "Shortcuts",
    order: 10,
    kind: "reference" as const,
    related: [],
  };
  expect(document.markdown.length).toBeLessThan(7000);
  const result = readHelpArticle(document);
  expect(result.markdown).toContain("Ctrl+K (⌘K on Mac)");
  expect(result.markdown.length).toBeLessThanOrEqual(7000);
  expect(result.truncated).toBe(true);
});

test("details preserve the paragraph break and subsequent Help links and shortcuts", () => {
  const source = ":::details Why?\nBody.\n:::\n\n[private](help:hidden/private) :kbd[esc]";
  expect(helpAgentMarkdown(agentArticle(source))).toBe("**Why?**\n\nBody.\n\nprivate Escape");
});

test("agent text converts quoted and indented prose while preserving code in those containers", () => {
  expect(helpAgentMarkdown(agentArticle("> [text](help:hidden/private)\n> :kbd[mod+k]"))).toBe("> text\n> Ctrl+K (⌘K on Mac)");
  expect(helpAgentMarkdown(agentArticle("1. Read\n\n   [text](help:hidden/private)\n   :kbd[mod+k]"))).toBe(
    "1. Read\n\n   text\n   Ctrl+K (⌘K on Mac)",
  );
  const quoted = "> ```md\n> [text](help:hidden/private)\n> ```\n>\n> [text](help:hidden/private)";
  expect(helpAgentMarkdown(agentArticle(quoted))).toBe("> ```md\n> [text](help:hidden/private)\n> ```\n>\n> text");
});

test("agent conversion preserves CRLF source and code", () => {
  const source =
    '## Keys {icon="keyboard"}\r\n\r\nPress :kbd[mod+k].\r\n[private](help:hidden/private)\r\n\r\n```md\r\n:kbd[mod+k]\r\n```\r\n';
  expect(helpAgentMarkdown(agentArticle(source))).toBe(
    "## Keys\r\n\r\nPress Ctrl+K (⌘K on Mac).\r\nprivate\r\n\r\n```md\r\n:kbd[mod+k]\r\n```\r\n",
  );
});

test("agent table rewriting preserves escaped pipes in code and converts the following shortcut", () => {
  const source = "| A | B |\n|---|---|\n| `a\\| :kbd[esc]` | :kbd[esc] |";
  expect(helpAgentMarkdown(agentArticle(source))).toBe("| A | B |\n|---|---|\n| `a\\| :kbd[esc]` | Escape |");
});

test("agent rewriting converts tab-indented list continuations", () => {
  expect(helpAgentMarkdown(agentArticle("- [x](help:hidden/private)\n\t[y](help:hidden/private)"))).toBe("- x\n\ty");
});

test("agent rewriting leaves the rest of a container unchanged after an unlocatable child", () => {
  const source = "first\r:::details Title\nBody\n:::\n\n:kbd[esc]";
  expect(helpAgentMarkdown(agentArticle(source))).toBe(source);
});
