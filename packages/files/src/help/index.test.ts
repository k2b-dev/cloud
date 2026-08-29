import { describe, expect, test } from "bun:test";
import { filesHelp } from ".";

describe("filesHelp", () => {
  test("serves the existing Files help topics as English Markdown", () => {
    expect(filesHelp.documents.map((document) => document.id)).toEqual(["files-start", "files-work", "files-troubleshooting"]);
    expect(filesHelp.getMarkdown("files-start")).toContain("Files browses the home and group file bases");
    expect(filesHelp.getMarkdown("files-work")).toContain("Most file work happens from the toolbar");
    expect(filesHelp.getMarkdown("files-troubleshooting")).toContain("A home or group base is missing");
  });

  test("translates every article to German with matching metadata", () => {
    const english = filesHelp.documentsByLocale?.en ?? [];
    const german = filesHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(filesHelp.getMarkdown("files-start", "de")).toContain("Files zeigt die persönlichen und gemeinsam genutzten Dateiablagen");
    expect(filesHelp.getMarkdown("files-work", "de")).toContain("Die meisten Dateiaktionen findest du");
    expect(filesHelp.getMarkdown("files-troubleshooting", "de")).toContain("Eine persönliche Ablage oder Gruppenablage fehlt");
  });

  test("resolves regional and unknown locales through the fallback chain", () => {
    expect(filesHelp.getMarkdown("files-start", "de-CH")).toBe(filesHelp.getMarkdown("files-start", "de")!);
    expect(filesHelp.getMarkdown("files-start", "de-CH")).toContain("Files zeigt die persönlichen und gemeinsam genutzten Dateiablagen");
    expect(filesHelp.getMarkdown("files-start", "fr")).toBe(filesHelp.getMarkdown("files-start")!);
    expect(filesHelp.getMarkdown("files-start", "fr")).toContain("Files browses the home and group file bases");
  });
});
