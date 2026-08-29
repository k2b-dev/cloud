import { describe, expect, test } from "bun:test";
import "./ssr-test-plugin";
import { detailMessages } from "./detail-messages";
import { resultsMessages } from "./results-messages";

const { bookUnavailableMessages } = await import("./ContactBookUnavailable.tsx");
const { liveEventsMessages } = await import("./ContactsLiveEvents.island.tsx");
const { sidebarMessages } = await import("./ContactsSidebar.tsx");
const { spotlightMessages } = await import("./ContactsSpotlightButton.island.tsx");

describe("Contacts results i18n", () => {
  test("German is complete for every catalog", () => {
    const catalogs = { resultsMessages, detailMessages, sidebarMessages, spotlightMessages, liveEventsMessages, bookUnavailableMessages };
    for (const [name, catalog] of Object.entries(catalogs)) {
      const report = catalog.check().find((entry) => entry.locale === "de");
      expect({ name, missing: report?.missing ?? [], extra: report?.extra ?? [] }).toEqual({ name, missing: [], extra: [] });
    }
  });

  test("resolves representative German messages", () => {
    const { t } = resultsMessages.resolve(["de"]);
    expect(t.loadingContacts).toBe("Kontakte werden geladen…");
    expect(t.noContactsYet).toBe("Noch keine Kontakte");
    expect(t.clearSearch).toBe("Suche zurücksetzen");
    expect(t.resultCount({ total: 1, search: "Ada" })).toBe("1 Ergebnis für „Ada“");
    expect(t.resultCount({ total: 2, search: "Ada" })).toBe("2 Ergebnisse für „Ada“");
    expect(t.contactCount({ total: 1 })).toBe("1 Kontakt");
    expect(t.contactCount({ total: 2 })).toBe("2 Kontakte");
    expect(t.moveContactsTitle({ count: 1 })).toBe("1 Kontakt verschieben");
    expect(t.moveContactsTitle({ count: 3 })).toBe("3 Kontakte verschieben");
    expect(t.tagsAddedToContacts({ count: 1 })).toBe("Tags zu 1 Kontakt hinzugefügt");
    expect(t.tagsAddedToContacts({ count: 3 })).toBe("Tags zu 3 Kontakten hinzugefügt");
    expect(t.deleteContactsConfirm({ count: 1 })).toBe(
      "1 ausgewählten Kontakt endgültig löschen? Kommentare und Kontaktdaten werden ebenfalls gelöscht.",
    );
    expect(t.deleteContactsConfirm({ count: 2 })).toBe(
      "2 ausgewählte Kontakte endgültig löschen? Kommentare und Kontaktdaten werden ebenfalls gelöscht.",
    );
    expect(t.selectContact({ name: "Ada Lovelace" })).toBe("Ada Lovelace auswählen");
    expect(t.openContact({ name: "Ada Lovelace" })).toBe("Ada Lovelace öffnen");
    expect(t.callContact({ name: "Ada Lovelace" })).toBe("Ada Lovelace anrufen");
    expect(detailMessages.resolve(["de"]).t.contactUpdated).toBe("Kontakt aktualisiert");
  });

  test("keeps the English base wording", () => {
    const { t } = resultsMessages.resolve(["en"]);
    expect(t.resultCount({ total: 1, search: "Ada" })).toBe("1 result for “Ada”");
    expect(t.resultCount({ total: 2, search: "Ada" })).toBe("2 results for “Ada”");
    expect(t.contactCount({ total: 1 })).toBe("1 contact");
    expect(t.selectContact({ name: "Ada Lovelace" })).toBe("Select Ada Lovelace");
  });

  test("de-CH resolves to German", () => {
    const { locale, t } = resultsMessages.resolve(["de-CH"]);
    expect(locale).toBe("de");
    expect(t.contactCount({ total: 2 })).toBe("2 Kontakte");
    expect(sidebarMessages.resolve(["de-CH"]).t.allContacts).toBe("Alle Kontakte");
    expect(detailMessages.resolve(["de-CH"]).t.pickParentContact).toBe("Übergeordneten Kontakt auswählen");
  });
});
