import { describe, expect, test } from "bun:test";
import { contactsHelp } from ".";

describe("contactsHelp", () => {
  test("serves the existing Contacts help topics as Markdown", async () => {
    expect(contactsHelp.documents.map((document) => document.id)).toEqual([
      "contacts-start",
      "contacts-work",
      "contacts-hierarchy",
      "contacts-books-sharing",
    ]);
    expect(contactsHelp.getMarkdown("contacts-start")).toContain("Contacts keeps address books");
    expect(contactsHelp.getMarkdown("contacts-work")).toContain("The Contacts overview is a working view");
    expect(contactsHelp.getMarkdown("contacts-hierarchy")).toContain("Contact hierarchy links records");
    expect(contactsHelp.getMarkdown("contacts-books-sharing")).toContain("Contact book settings control metadata");
  });

  test("translates every article to German with matching icon and order", () => {
    const english = contactsHelp.documentsByLocale?.en ?? [];
    const german = contactsHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(contactsHelp.getMarkdown("contacts-start", "de")).toContain("Kontakte verwaltet Kontaktbücher");
    expect(contactsHelp.getMarkdown("contacts-work", "de")).toContain("Die Kontakte-Übersicht ist eine gemeinsame Arbeitsansicht");
    expect(contactsHelp.getMarkdown("contacts-hierarchy", "de")).toContain(
      "Die Kontakthierarchie verknüpft Kontakte im selben Kontaktbuch",
    );
    expect(contactsHelp.getMarkdown("contacts-books-sharing", "de")).toContain("Die Kontaktbuch-Einstellungen steuern Name");
  });

  test("resolves regional and unknown locales through the fallback chain", () => {
    expect(contactsHelp.getMarkdown("contacts-start", "de-CH")).toBe(contactsHelp.getMarkdown("contacts-start", "de")!);
    expect(contactsHelp.getMarkdown("contacts-start", "de-CH")).toContain("Kontakte verwaltet Kontaktbücher");
    expect(contactsHelp.getMarkdown("contacts-start", "fr")).toBe(contactsHelp.getMarkdown("contacts-start")!);
    expect(contactsHelp.getMarkdown("contacts-start", "fr")).toContain("Contacts keeps address books");
  });
});
