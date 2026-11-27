import { describe, expect, test } from "bun:test";
import { preview } from "./templates";

// The start's tiles show a template as the base will hold it: its main table with real columns and its first sample
// records, linked records by name, choices by their label, dates and numbers as the page's language writes them.
const NOW = new Date("2026-11-27T12:00:00.000Z");

describe("a template's preview", () => {
  test("names the main table's sample records, linked records by name", () => {
    expect(preview("finance", "de", NOW)).toEqual({
      tables: 5,
      table: "Transaktionen",
      columns: ["Datum", "Zahlungspartner", "Konto"],
      rows: [
        ["01.04.", "Arbeitgeber GmbH", "Hauptkonto"],
        ["02.04.", "Vermieter", "Hauptkonto"],
        ["05.04.", "Markt vor Ort", "Visa"],
      ],
    });
  });

  test("shows choices by their label and a date of the current month on the day it is read", () => {
    const billing = preview("billing", "de", NOW);
    expect(billing?.columns).toEqual(["Dokumentart", "Geschäftspartner", "Belegdatum"]);
    expect(billing?.rows[0]?.[0]).toBe("Rechnung");
    expect(billing?.rows[0]?.[2]).toBe("15.11.");
  });

  test("leaves out ids, files and computed values, and knows no template it does not have", () => {
    const inventory = preview("inventory", "de", NOW);
    expect(inventory?.columns).toEqual(["Name", "Kategorie", "Lagerort"]);
    expect(preview("missing", "de", NOW)).toBeNull();
  });
});
