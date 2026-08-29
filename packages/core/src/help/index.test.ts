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
    ]);

    expect(coreHelp.getMarkdown("core-start")).toContain("Core owns platform-level pages and services");
    expect(coreHelp.getMarkdown("core-security")).toContain("The available sign-in methods depend");
    expect(coreHelp.getMarkdown("core-notifications")).toContain("Notifications keep account and app events");
    expect(coreHelp.getMarkdown("core-admin")).toContain("Core admin pages configure platform services");
  });

  test("serves every article in German with regional fallback", () => {
    expect(coreHelp.documentsByLocale?.de?.map((document) => document.id)).toEqual(
      coreHelp.documentsByLocale?.en?.map((document) => document.id),
    );
    expect(coreHelp.getMarkdown("core-profile", "de-CH")).toBe(coreHelp.getMarkdown("core-profile", "de"));
    expect(coreHelp.getMarkdown("core-start", "de-CH")).toContain("Core besitzt die plattformweiten Seiten");
    expect(coreHelp.getMarkdown("core-profile", "de-CH")).toContain("Der Kontobereich bündelt lokale Cloud-Daten");
    expect(coreHelp.getMarkdown("core-security", "de-CH")).toContain("API-Schlüssel wie Passwörter");
    expect(coreHelp.getMarkdown("core-notifications", "de-CH")).toContain("Zustellverlauf prüfen");
    expect(coreHelp.getMarkdown("core-admin", "de-CH")).toContain("Die Core-Administrationsseiten konfigurieren Plattformdienste");
    expect(coreHelp.getMarkdown("core-start", "fr")).toBe(coreHelp.getMarkdown("core-start"));
  });
});
