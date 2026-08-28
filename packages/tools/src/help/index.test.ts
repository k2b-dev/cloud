import { describe, expect, test } from "bun:test";
import { toolsHelp } from ".";

describe("toolsHelp", () => {
  test("owns the existing Tools help as Markdown", () => {
    expect(toolsHelp.documents.map((document) => document.id)).toEqual([
      "tools-start",
      "tools-choose",
      "tools-document-markdown",
      "tools-markdown-pdf",
      "tools-image-converter",
      "tools-safety",
    ]);

    expect(toolsHelp.getMarkdown("tools-start")).toContain("Tools is a workspace for small generators");
    expect(toolsHelp.getMarkdown("tools-start")).toContain("The tester redacts sensitive headers");
    expect(toolsHelp.getMarkdown("tools-choose")).toContain("The Tools overview groups utilities");
    expect(toolsHelp.getMarkdown("tools-document-markdown")).toContain("does not perform OCR");
    expect(toolsHelp.getMarkdown("tools-document-markdown")).toContain("does not persist either the upload or the Markdown result");
    expect(toolsHelp.getMarkdown("tools-document-markdown")).toContain("no dedicated `cld tools` command");
    expect(toolsHelp.getMarkdown("tools-markdown-pdf")).toContain("Custom CSS replaces a preset");
    expect(toolsHelp.getMarkdown("tools-markdown-pdf")).toContain("Markdown images appear as links");
    expect(toolsHelp.getMarkdown("tools-markdown-pdf")).toContain("does not persist the input or PDF");
    expect(toolsHelp.getMarkdown("tools-markdown-pdf")).toContain("no dedicated `cld tools` command");
    expect(toolsHelp.getMarkdown("tools-image-converter")).toContain("does not upload or persist them");
    expect(toolsHelp.getMarkdown("tools-image-converter")).toContain("Multiple files download together");
    expect(toolsHelp.getMarkdown("tools-safety")).toContain("Generators, encoders, color conversion");
  });

  test("translates every article to German with matching icon and order", () => {
    const english = toolsHelp.documentsByLocale?.en ?? [];
    const german = toolsHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(toolsHelp.getMarkdown("tools-start", "de")).toContain("Tools ist ein Arbeitsbereich");
    expect(toolsHelp.getMarkdown("tools-choose", "de")).toContain("Die Tools-Übersicht gruppiert die Werkzeuge");
    expect(toolsHelp.getMarkdown("tools-document-markdown", "de")).toContain("führt keine OCR aus");
    expect(toolsHelp.getMarkdown("tools-markdown-pdf", "de")).toContain("kein eigenes `cld tools`-Kommando");
    expect(toolsHelp.getMarkdown("tools-image-converter", "de")).toContain("ohne sie hochzuladen");
    expect(toolsHelp.getMarkdown("tools-safety", "de")).toContain("Ein Hash ist keine Verschlüsselung");
  });

  test("resolves regional and unknown locales through the fallback chain", () => {
    expect(toolsHelp.getMarkdown("tools-start", "de-CH")).toBe(toolsHelp.getMarkdown("tools-start", "de")!);
    expect(toolsHelp.getMarkdown("tools-start", "de-CH")).toContain("Tools ist ein Arbeitsbereich");
    expect(toolsHelp.getMarkdown("tools-start", "fr")).toBe(toolsHelp.getMarkdown("tools-start")!);
    expect(toolsHelp.getMarkdown("tools-start", "fr")).toContain("Tools is a workspace for small generators");
  });
});
