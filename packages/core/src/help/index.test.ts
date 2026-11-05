import { describe, expect, test } from "bun:test";
import { coreHelp } from ".";

describe("coreHelp", () => {
  test("owns the existing Core help topics as Markdown", () => {
    expect(coreHelp.documents.map((document) => document.id)).toEqual([
      "core-start",
      "core-profile",
      "core-security",
      "core-notifications",
      "core-admin",
      "core-ai-decisions",
    ]);

    expect(coreHelp.getMarkdown("core-start")).toContain("Core provides the platform pages and shared services");
    expect(coreHelp.getMarkdown("core-security")).toContain("Your sign-in methods depend");
    expect(coreHelp.getMarkdown("core-notifications")).toContain("Notifications collects account and app events");
    expect(coreHelp.getMarkdown("core-admin")).toContain("The Core administration pages configure platform services");
  });

  test("decision help explains caller allowance and category before urgency in both locales", () => {
    expect(coreHelp.getMarkdown("core-ai-decisions")).toContain("Never ask urgency alone");
    expect(coreHelp.getMarkdown("core-ai-decisions")).toContain("service account");
    expect(coreHelp.getMarkdown("core-ai-decisions", "de")).toContain("nie allein");
    expect(coreHelp.getMarkdown("core-ai-decisions", "de")).toContain("Dienstkontos");
  });

  test("serves every article in German with regional fallback", () => {
    expect(coreHelp.documentsByLocale?.de?.map((document) => document.id)).toEqual(
      coreHelp.documentsByLocale?.en?.map((document) => document.id),
    );
    expect(coreHelp.getMarkdown("core-profile", "de-CH")).toBe(coreHelp.getMarkdown("core-profile", "de"));
    expect(coreHelp.getMarkdown("core-start", "de-CH")).toContain("Core stellt die Seiten und Dienste der ganzen Plattform bereit");
    expect(coreHelp.getMarkdown("core-profile", "de-CH")).toContain("Der Kontobereich bündelt lokale Cloud-Daten");
    expect(coreHelp.getMarkdown("core-security", "de-CH")).toContain("API Keys wie Passwörter");
    expect(coreHelp.getMarkdown("core-notifications", "de-CH")).toContain("Zustellverlauf prüfen");
    expect(coreHelp.getMarkdown("core-admin", "de-CH")).toContain("Die Core-Administrationsseiten konfigurieren Plattformdienste");
    expect(coreHelp.getMarkdown("core-admin", "de-CH")).toContain("**Tokens für Host-Betrieb**");
    expect(coreHelp.getMarkdown("core-admin", "de-CH")).not.toContain("App-Zugang");
    expect(coreHelp.getMarkdown("core-start", "fr")).toBe(coreHelp.getMarkdown("core-start"));
  });
});
