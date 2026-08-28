import { describe, expect, test } from "bun:test";
import { bookMessages } from "./book-messages";

describe("contact book message catalog", () => {
  test("ships a complete German catalog", () => {
    expect(bookMessages.check()).toEqual([]);
  });

  test("resolves representative German messages", () => {
    const { t } = bookMessages.resolve(["de"]);
    expect(t.settingsTitle).toBe("Kontaktbuch-Einstellungen");
    expect(t.tabDanger).toBe("Gefahrenbereich");
    expect(t.deleteBookGroupDescription).toBe("Diese Aktion kann nicht rückgängig gemacht werden.");
    // Confirm dialog body: action + object with the concrete consequence.
    expect(t.deleteTagConfirm({ name: "Lieferant" })).toBe(
      "„Lieferant“ löschen? Der Tag wird aus allen Kontakten in diesem Kontaktbuch entfernt.",
    );
    expect(t.deleteBookConfirm({ name: "Vertrieb" })).toBe("Kontaktbuch „Vertrieb“ und alle enthaltenen Kontakte endgültig löschen?");
    // Interpolated messages with plural handling.
    expect(t.importPartialFailure({ created: 3, failed: 2, first: "Max Mustermann" })).toBe(
      "3 Kontakte importiert; 2 konnten nicht importiert werden: Max Mustermann",
    );
    expect(t.previewSummary({ filename: "team.vcf", count: 1 })).toBe("team.vcf · 1 Kontakt gefunden");
    expect(t.previewSummary({ filename: "team.vcf", count: 4 })).toBe("team.vcf · 4 Kontakte gefunden");
    expect(t.importCount({ count: 1 })).toBe("1 Kontakt importieren");
    expect(t.openSettingsFor({ name: "Vertrieb" })).toBe("Einstellungen für Vertrieb öffnen");
  });

  test("keeps the English base intact and falls back regionally", () => {
    const en = bookMessages.resolve(["en"]).t;
    expect(en.deleteTagConfirm({ name: "Supplier" })).toBe('Delete "Supplier"? It will be removed from all contacts in this book.');
    expect(en.importPartialFailure({ created: 3, failed: 2, first: "Jane" })).toBe("Imported 3, 2 failed: Jane");
    // Regional German resolves to the German catalog.
    expect(bookMessages.resolve(["de-CH"]).t.settingsTitle).toBe("Kontaktbuch-Einstellungen");
  });
});
