import { describe, expect, test } from "bun:test";
import { spacesHelp } from ".";

describe("spacesHelp", () => {
  test("owns the existing Spaces help topics as English Markdown", () => {
    expect(spacesHelp.documents.map((document) => document.id)).toEqual([
      "spaces-start",
      "spaces-views",
      "spaces-workflow",
      "spaces-sharing",
      "spaces-troubleshooting",
    ]);

    expect(spacesHelp.getMarkdown("spaces-start")).toContain("Spaces is for shared work");
    expect(spacesHelp.getMarkdown("spaces-troubleshooting")).toContain("A space is missing from the overview");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Estimated duration:**");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Blocked by:**");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Blocks:**");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Related tasks:**");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Attachments:**");
    expect(spacesHelp.getMarkdown("spaces-troubleshooting")).toContain("A task cannot be completed");
  });

  test("translates every article to German with matching icon and order", () => {
    const english = spacesHelp.documentsByLocale?.en ?? [];
    const german = spacesHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(spacesHelp.getMarkdown("spaces-start", "de")).toContain("Spaces bündelt gemeinsame Arbeit");
    expect(spacesHelp.getMarkdown("spaces-views", "de")).toContain("Ansichten stellen dieselben Einträge");
    expect(spacesHelp.getMarkdown("spaces-workflow", "de")).toContain("**Geschätzte Dauer:**");
    expect(spacesHelp.getMarkdown("spaces-sharing", "de")).toContain("Berechtigungen sollten zu den Personen passen");
    expect(spacesHelp.getMarkdown("spaces-troubleshooting", "de")).toContain("Eine Aufgabe kann nicht abgeschlossen werden");
  });

  test("resolves regional and unknown locales through the fallback chain", () => {
    expect(spacesHelp.getMarkdown("spaces-start", "de-CH")).toBe(spacesHelp.getMarkdown("spaces-start", "de")!);
    expect(spacesHelp.getMarkdown("spaces-start", "de-CH")).toContain("Spaces bündelt gemeinsame Arbeit");
    expect(spacesHelp.getMarkdown("spaces-start", "fr")).toBe(spacesHelp.getMarkdown("spaces-start")!);
    expect(spacesHelp.getMarkdown("spaces-start", "fr")).toContain("Spaces is for shared work");
  });
});
