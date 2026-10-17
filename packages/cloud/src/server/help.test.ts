import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { compileHelp } from "../_internal/help";
import { helpAgentMarkdown } from "../_internal/help-catalog";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { defineHelp, defineHelpCollection } from "./help";

const source = `---
id: getting-started
title: Getting started
icon: ti ti-rocket
description: First steps
order: 10
---

# Welcome

[Open the app](/app/example)

\`\`\`script
throw new Error("documentation must not execute");
\`\`\`
`;

const signedIn = { headers: { Accept: "application/json", Cookie: "session_token=test" } };

describe("defineHelpCollection", () => {
  let authenticate: ReturnType<typeof spyOn<typeof session, "authenticateRequest">>;
  beforeAll(() => {
    const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "guest", effective_admin: false });
    authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
  });
  afterAll(() => authenticate.mockRestore());

  test("answers only signed-in people", async () => {
    const collection = defineHelpCollection({ basePath: "/help", sources: [source] });
    for (const path of ["/search?q=documentation", "/getting-started", "/missing"]) {
      expect((await collection.router.request(path, { headers: { Accept: "application/json" } })).status).toBe(401);
    }
  });

  test("keeps the manifest metadata-only and searches content on the server", async () => {
    const collection = defineHelpCollection({ basePath: "/api/example/help", sources: [source] });
    expect(collection.manifest).toEqual([
      expect.objectContaining({
        id: "getting-started",
        title: "Getting started",
        order: 10,
        searchUrl: "/api/example/help/search",
        url: "/api/example/help/getting-started",
      }),
    ]);
    expect(collection.manifest[0]).not.toHaveProperty("searchText");

    const searchResponse = await collection.router.request("/search?q=documentation", signedIn);
    expect(searchResponse.status).toBe(200);
    expect(await searchResponse.json()).toEqual({ ids: ["getting-started"], locale: "en" });

    const response = await collection.router.request("/getting-started", signedIn);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.markdown).toContain("documentation must not execute");
    expect(payload.html).not.toContain("data-script-source");
    expect(payload.html).toContain('href="/app/example"');
    expect(payload.html).not.toContain('target="_blank"');
  });

  test("rejects duplicate ids at startup", () => {
    expect(() => defineHelpCollection({ basePath: "/help", sources: [source, source] })).toThrow("Duplicate help document id");
  });

  test("returns a clear 404 for unknown documents", async () => {
    const collection = defineHelpCollection({ basePath: "/help", sources: [source] });
    expect((await collection.router.request("/missing", signedIn)).status).toBe(404);
  });
});

const helpSource = (id: string, metadata = "", body = "## Plain heading\nRead this.") =>
  `---\nid: ${id}\ntitle: ${id}\n${metadata}---\n${body}`;

describe("Help author contract", () => {
  test("rejects details without a title or closing line in every locale, outside code", () => {
    for (const body of [
      ":::details Title\nBody",
      "first\r:::details Title\nBody\n:::",
      ":::details\nBody\n:::",
      "   :::details Title\nBody",
      ":::details X\n".repeat(40),
      ":::details Outer\n:::details Inner\nBody\n:::\n:::",
    ]) {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
        'Help document "start" has a :::details block without a blank line before it, a title, or a closing ::: in locale "en"',
      );
      expect(() => defineHelp({ baseLocale: "en", documents: { en: [helpSource("start")], de: [helpSource("start", "", body)] } })).toThrow(
        'Help document "start" has a :::details block without a blank line before it, a title, or a closing ::: in locale "de"',
      );
    }
    expect(() =>
      defineHelp({
        documents: [
          helpSource(
            "start",
            "",
            "```md\n:::details\n```\n\n    :::details\n\n`:::details`\n\n`example\n:::details\nexample`\n\n:kbd[esc]:::details literal\n\n**Bold**:::details literal",
          ),
        ],
      }),
    ).not.toThrow();
  });
  test("rejects Help autolinks, images and HTML attributes before they reach agents", () => {
    for (const body of [
      "<help:hidden/private>",
      "![x](help:hidden/private)",
      '<a href="help:hidden/private">x</a>',
      '<div data-target="help:hidden/private">x</div>',
      '<div data-target="  HELP:hidden/private">x</div>',
      "<div>\n[private]( <help:hidden/private>)\n</div>",
      "<div>\n[r]: <HELP:hidden/private>\n</div>",
      ":::note [private]( <help:hidden/private>)\nBody\n:::",
      ":::note <HELP:hidden/private>\nBody\n:::",
      "Read <a href='help:hidden/private'>x</a>.",
      "<a href=help:hidden/private>x</a>",
      "<div>\n[private](help:hidden/private)\n</div>",
      ":::note [private](help:hidden/private)\nBody\n:::",
    ]) {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
        'Help document "start" has a help: link that agents cannot read in locale "en"; write it inline as [text](help:id)',
      );
    }
    expect(() => defineHelp({ documents: [helpSource("start", "", '`<a href="help:hidden/private">x</a>`')] })).not.toThrow();
    expect(() =>
      defineHelp({
        documents: [
          helpSource(
            "start",
            "",
            "`[private](help:hidden/private)`\n\n```md\n<div>\n[private](help:hidden/private)\n</div>\n\n:::note [private](help:hidden/private)\nBody\n:::\n```",
          ),
        ],
      }),
    ).not.toThrow();
  });
  for (const [kind, body] of [
    ["details", "X\n:::details Title\nBody\n:::"],
    ["steps", "Intro\n:::steps\n1. A\n:::"],
    ["reference", "Intro\n:::reference\nBody\n:::"],
    ["compare", "Intro\n:::compare\nBody\n:::"],
  ] as const) {
    test(`rejects ${kind} directly after a text line`, () => {
      const missing = kind === "details" ? "a blank line before it, a title, or a closing :::" : "a blank line before it or a closing :::";
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
        `Help document "start" has a :::${kind} block without ${missing} in locale "en"`,
      );
    });
  }
  for (const [name, body] of [
    ["indented backticks inside a fence", ":::details Example\n```md\n    ```\n:::\n```\nAfter.\n:::"],
    ["an unclosed quote fence", ":::details Title\n> ```\n> code\n\nAfter.\n:::"],
    ["an unclosed list fence", ":::details Title\n- ```\n  code\n\nAfter.\n:::"],
    ["a tab-indented list fence", ":::details Q\n1. ~~~\n\tcode\n\t~~~\n\nAfter\n:::"],
    ["indented code resembling a fence", ":::details Example\n\n    ~~~js\n\nAfter.\n:::"],
  ] as const) {
    test(`accepts details with ${name}`, () => {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).not.toThrow();
    });
  }
  for (const target of ['"HELP:hidden/private"', '"help:hidden/private"', "'help:hidden/private'"]) {
    test(`rejects HTML Help target ${target} in a callout title`, () => {
      expect(() => defineHelp({ documents: [helpSource("start", "", `:::note <a href=${target}>Read more</a>\nBody\n:::`)] })).toThrow(
        'Help document "start" has a help: link that agents cannot read in locale "en"; write it inline as [text](help:id)',
      );
    });
  }
  test("rejects details nested through Markdown containers", () => {
    for (const body of [
      ":::details Outer\n> :::details Inner\n> Body\n> :::\n:::",
      ":::details Outer\n- :::details Inner\n  Body\n  :::\n:::",
    ]) {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
        'Help document "start" has a :::details block without a blank line before it, a title, or a closing ::: in locale "en"',
      );
    }
  });
  test("accepts literal details in container fences inside details", () => {
    for (const body of [
      ":::details Example\n- ```md\n  :::details Literal\n  ```\nAfter.\n:::",
      ":::details Example\n> ```md\n> :::details Literal\n> ```\nAfter.\n:::",
    ]) {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).not.toThrow();
    }
  });
  test("accepts help: prose and HTTPS paths in HTML and callout titles", () => {
    for (const body of [
      '<a href="https://example.com/help:overview">Support</a>',
      "<div>For help:contact support</div>",
      "<div>https://example.com/help:overview</div>",
      ":::note For help:contact support\nBody\n:::",
      ":::note https://example.com/help:overview\nBody\n:::",
      "<div>mode=help:desk</div>",
      ":::note mode=help:desk\nBody\n:::",
      ":::reference-data\nText",
      ":::details Example\n:::reference-data\nText\n:::",
      ":::details Example\n:::details-data\nText\n:::",
      `<div>${"a".repeat(20_000)}</div>`,
    ]) {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).not.toThrow();
    }
  });
  test("rejects non-lowercase Help schemes in links, images and definitions", () => {
    for (const scheme of ["HELP:", "Help:", "hElP:"]) {
      for (const body of [
        `[Private](${scheme}hidden/private)`,
        `![Private](${scheme}hidden/private)`,
        `[Private][r]\n\n[r]: ${scheme}hidden/private`,
        `[r]: ${scheme}hidden/private`,
      ]) {
        expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
          'Help document "start" has a help: link that agents cannot read in locale "en"',
        );
      }
    }
  });
  test("search text uses the article locale for key names", () => {
    const definition = defineHelp({
      baseLocale: "de",
      documents: { de: [helpSource("keys", "", ":kbd[enter] :kbd[mod+k]")] },
    });
    expect(definition.documents[0]?.searchText).toContain("Eingabetaste");
    expect(definition.documents[0]?.searchText).toContain("Steuerung K");
    expect(definition.documents[0]?.searchText).not.toContain("Control");
  });
  test("escaped pipes in table Help links start and convert", () => {
    const body = "| a |\n| --- |\n| [x\\|y](help:hidden/private) |";
    const definition = defineHelp({ documents: [helpSource("start", "", body)] });
    expect(helpAgentMarkdown({ markdown: definition.getMarkdown("start") ?? "", locale: "en", appId: "example", links: {} })).toBe(
      "| a |\n| --- |\n| x\\|y |",
    );
  });
  test("tab-indented list continuations start and convert both Help links", () => {
    const body = "- [x](help:a)\n\t[y](help:a)";
    const definition = defineHelp({ documents: [helpSource("a", "", body)] });
    expect(helpAgentMarkdown({ markdown: definition.getMarkdown("a") ?? "", locale: "en", appId: "example", links: {} })).toBe("- x\n\ty");
  });
  for (const [name, body] of [
    ["keyboard shortcut", "first\r:kbd[esc]"],
    ["label", 'first\r**Label**{icon="eye"}'],
  ]) {
    test(`rejects an unconverted ${name} in agent text in every locale`, () => {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
        'Help document "start" has Help syntax that agents cannot read in locale "en"',
      );
      expect(() => defineHelp({ baseLocale: "en", documents: { en: [helpSource("start")], de: [helpSource("start", "", body)] } })).toThrow(
        'Help document "start" has Help syntax that agents cannot read in locale "de"',
      );
    });
  }
  test("old frontmatter defines and compiles with defaults and optional H2 icons", () => {
    const definition = defineHelp({ documents: [source] });
    expect(definition.documents[0]).toMatchObject({ kind: "task", related: [] });
    expect(compileHelp({ appId: "example", definition }).corpus.documents[0]).toMatchObject({
      kind: "task",
      related: [],
      icon: "ti ti-rocket",
      description: "First steps",
      order: 10,
    });
    expect(defineHelp({ documents: [helpSource("plain")] }).documents[0]?.html).toContain('class="help-section-title">Plain heading</h2>');
  });
  test("rejects missing or self next and missing same-app related or inline targets", () => {
    for (const [metadata, body, field] of [
      ["next: missing\n", "Body", "next"],
      ["related: [missing]\n", "Body", "related"],
      ["", "[Read](help:missing#section)", "help:"],
    ])
      expect(() => defineHelp({ documents: [helpSource("start", metadata, body)] })).toThrow(
        `Help locale "en" document "start" has unknown ${field} reference "missing`,
      );
    expect(() => defineHelp({ documents: [helpSource("start", "next: start\n")] })).toThrow("must not reference itself in next");
    expect(() => defineHelp({ documents: [helpSource("start", "related: [start, start]\n")] })).toThrow("Duplicate related");
  });
  test("needs accepts only one glossary level", () => {
    for (const needs of ["admin", "[manage]"])
      expect(() => defineHelp({ documents: [helpSource("start", `needs: ${needs}\n`)] })).toThrow();
    expect(defineHelp({ documents: [helpSource("start", "needs: manage\n")] }).documents[0]?.needs).toBe("manage");
  });
  test("translations inherit metadata and may repeat only equal values in the same order", () => {
    const base = helpSource(
      "start",
      "icon: ti ti-eye\norder: 10\nkind: start\nneeds: view\nnext: finish\nrelated: [finish, other/intro]\n",
    );
    const definition = defineHelp({ baseLocale: "en", documents: { en: [base, helpSource("finish")], de: [helpSource("start")] } });
    expect(definition.documentsByLocale?.de?.[0]).toMatchObject({
      kind: "start",
      needs: "view",
      next: "finish",
      related: ["finish", "other/intro"],
      icon: "ti ti-eye",
      order: 10,
    });
    for (const [field, value] of [
      ["kind", "reference"],
      ["needs", "edit"],
      ["next", "start"],
      ["related", "[other/intro, finish]"],
    ]) {
      expect(() =>
        defineHelp({
          baseLocale: "en",
          documents: { en: [base, helpSource("finish")], de: [helpSource("start", `${field}: ${value}\n`)] },
        }),
      ).toThrow(`Help locale "de" must preserve ${field} for document "start"`);
    }
    expect(() => defineHelp({ baseLocale: "en", documents: { en: [base, helpSource("finish")], de: [base] } })).not.toThrow();
  });
  test("validates links and shortcuts in every locale, while ignoring code examples", () => {
    expect(() => defineHelp({ documents: [helpSource("start", "", ":kbd[]")] })).toThrow(
      'Help document "start" has an invalid key shortcut ""',
    );
    expect(() =>
      defineHelp({ baseLocale: "en", documents: { en: [helpSource("start")], de: [helpSource("start", "", "[Read](help:missing)")] } }),
    ).toThrow('Help locale "de" document "start"');
    expect(() =>
      defineHelp({ documents: [helpSource("start", "", "`:kbd[]` `[Read](help:missing)`\n\n```md\n:kbd[]\n[Read](help:missing)\n```")] }),
    ).not.toThrow();
    expect(() => defineHelp({ documents: [helpSource("start", "", ":::details Keys\n:kbd[]\n:::")] })).toThrow("invalid key shortcut");
    expect(() => defineHelp({ documents: [helpSource("start", "", ":::details Why?\n:::warning Careful\nText.\n:::\n:::")] })).toThrow(
      "has a callout inside details",
    );
    // Agents never receive a help: target that their text form could not convert.
    for (const body of ["[Read][r]\n\n[r]: help:hidden/private"])
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow("has a help: link that agents cannot read");
    // A malformed target is an author error, not a link that quietly turns into text.
    expect(() => defineHelp({ documents: [helpSource("start", "", "[Read](help:Start_Page)")] })).toThrow(
      'unknown help: reference "Start_Page"',
    );
    expect(() => defineHelp({ documents: [helpSource("start", "", ":::details Why?\nBody.\n:::\n\n[Read](help:missing)")] })).toThrow(
      "unknown help: reference",
    );
  });
});
