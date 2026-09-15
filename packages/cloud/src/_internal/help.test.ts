import { describe, expect, test } from "bun:test";
import { defineHelp, type HelpDefinition } from "../server/help";
import { compileHelp, HELP_DOCUMENT_MAX_BYTES } from "./help";

const article = (id: string, title: string, order: number, body = "Read this article.") => `---
id: ${id}
title: ${title}
order: ${order}
---

# ${title}

${body}`;

describe("Help registration compiler", () => {
  test("validates, sorts, and freezes one app-owned declaration", () => {
    const definition = defineHelp({
      documents: [article("second", "Second", 20), article("first", "First", 10)],
    });

    expect(definition.documents.map((document) => document.id)).toEqual(["first", "second"]);
    expect(Object.isFrozen(definition.documents)).toBe(true);
    expect(Object.isFrozen(definition.documents[0])).toBe(true);
    expect(definition.getMarkdown("first")).toContain("# First");
    expect(() => defineHelp({ documents: [article("same", "First", 10), article("same", "Second", 20)] })).toThrow(
      'Duplicate help document id "same"',
    );
  });

  test("derives stable app and Core routes from one declaration", () => {
    const definition = defineHelp({ documents: [article("getting-started", "Getting started", 10)] });
    const first = compileHelp({
      appId: "inventory",
      basePath: "/app/inventory/",
      definition,
    });
    const second = compileHelp({
      appId: "inventory",
      basePath: "/app/inventory",
      definition,
    });

    expect(first.summary).toEqual(second.summary);
    expect(first.corpus.documents[0]?.searchText).toContain("Read this article");
    expect(first.summary).toMatchObject({
      pageBase: "/app/inventory/help",
    });
  });

  test("compiles one bounded multilingual corpus with partial ancestor fallback", () => {
    const definition = defineHelp({
      baseLocale: "en",
      documents: {
        en: [article("start", "Start", 10), article("details", "Details", 20)],
        de: [article("start", "Starten", 10, "Deutscher Inhalt").replace("order: 10\n", "")],
        "de-CH": [article("details", "Details CH", 20, "Schweizer Inhalt")],
      },
    });
    const compiled = compileHelp({ appId: "inventory", definition });

    expect(compiled.corpus.baseLocale).toBe("en");
    expect(Object.keys(compiled.corpus.documentsByLocale ?? {})).toEqual(["de", "de-CH"]);
    expect(definition.getMarkdown("start", "de-CH")).toContain("Deutscher Inhalt");
    expect(compiled.corpus.documents).toHaveLength(2);
  });

  test("rejects oversized articles but accepts large complete corpora", () => {
    expect(() =>
      compileHelp({
        appId: "inventory",
        definition: defineHelp({ documents: [article("large", "Large", 10, "x".repeat(HELP_DOCUMENT_MAX_BYTES + 1))] }),
      }),
    ).toThrow(`${HELP_DOCUMENT_MAX_BYTES}-byte limit`);

    const oversized: HelpDefinition = {
      documents: Array.from({ length: 5 }, (_, index) => ({
        id: `article-${index}`,
        title: `Article ${index}`,
        order: index,
        markdown: "x".repeat(120 * 1024),
        html: "",
        searchText: "",
      })),
      getMarkdown: () => undefined,
    };
    expect(() =>
      compileHelp({
        appId: "inventory",
        definition: oversized,
      }),
    ).not.toThrow();
  });

  test("keeps search text and a constant-sized reference for large multilingual corpora", () => {
    const body = "Searchable help content. ".repeat(2_800);
    const compiled = compileHelp({
      appId: "inventory",
      definition: defineHelp({
        baseLocale: "en",
        documents: {
          en: [article("large-a", "Large A", 10, body), article("large-b", "Large B", 20, body)],
          de: [article("large-a", "Gross A", 10, body), article("large-b", "Gross B", 20, body)],
        },
      }),
    });

    expect(Object.keys(compiled.summary).sort()).toEqual(["baseLocale", "manifestHash", "pageBase"]);
    expect(Buffer.byteLength(JSON.stringify(compiled.corpus))).toBeGreaterThan(512 * 1024);
    expect(compiled.corpus.documents[0]?.searchText).toBeTruthy();
    expect(compiled.corpus.documentsByLocale?.de?.[0]?.searchText).toBeTruthy();
  });
});
