import { describe, expect, test } from "bun:test";
import { pagesMessages } from "./pages-messages";

describe("Contacts pages message catalog", () => {
  test("ships a complete German catalog", () => {
    expect(pagesMessages.check()).toEqual([]);
  });

  test("keeps the base locale as the default", () => {
    const { locale, t } = pagesMessages.resolve();
    expect(locale).toBe("en");
    expect(t.askAdminDescription).toBe("Ask a book administrator to grant you access.");
    expect(t.filterBookPlaceholder({ name: "Suppliers" })).toBe("Filter Suppliers...");
    expect(t.accessEntryCount({ count: 1 })).toBe("1 access entry");
    expect(t.accessEntryCount({ count: 3 })).toBe("3 access entries");
  });

  test("resolves German page strings", () => {
    const { locale, t } = pagesMessages.resolve(["de"]);
    expect(locale).toBe("de");
    expect(t.askAdminDescription).toBe("Wende dich an eine Person, die dieses Kontaktbuch verwaltet.");
    expect(t.bookNotFoundTitle).toBe("Kontaktbuch nicht gefunden");
    expect(t.allContactsTitle).toBe("Alle Kontakte");
    expect(t.filterBookPlaceholder({ name: "Lieferanten" })).toBe("Lieferanten filtern...");
    expect(t.booksCount({ count: 2, total: 5 })).toBe("2 von 5 Kontaktbüchern");
    expect(t.emptyFiltered({ search: "Team" })).toBe("Keine Kontaktbücher passen zu „Team“.");
    expect(t.accessEntryCount({ count: 1 })).toBe("1 Zugriffseintrag");
    expect(t.accessEntryCount({ count: 3 })).toBe("3 Zugriffseinträge");
  });

  test("falls back from de-CH to de", () => {
    const { locale, t } = pagesMessages.resolve(["de-CH"]);
    expect(locale).toBe("de");
    expect(t.bookUnavailableTitle).toBe("Kontaktbuch nicht verfügbar");
  });
});
