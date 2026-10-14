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
    for (const body of [":::details Title\nBody", ":::details\nBody\n:::", "   :::details Title\nBody", ":::details X\n".repeat(40)]) {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
        'Help document "start" has a :::details block without a title or closing ::: in locale "en"',
      );
      expect(() => defineHelp({ baseLocale: "en", documents: { en: [helpSource("start")], de: [helpSource("start", "", body)] } })).toThrow(
        'Help document "start" has a :::details block without a title or closing ::: in locale "de"',
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
      "Read <a href='help:hidden/private'>x</a>.",
      "<a href=help:hidden/private>x</a>",
    ]) {
      expect(() => defineHelp({ documents: [helpSource("start", "", body)] })).toThrow(
        'Help document "start" has a help: link that agents cannot read in locale "en"; write it inline as [text](help:id)',
      );
    }
    expect(() => defineHelp({ documents: [helpSource("start", "", '`<a href="help:hidden/private">x</a>`')] })).not.toThrow();
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
    ["details", "first\r:::details Title\nBody\n:::"],
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
