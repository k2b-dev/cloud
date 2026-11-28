import { describe, expect, test } from "bun:test";
import { preview } from "./templates";

// The start's cards show the small table a template brings for them: three short columns and three rows that a card
// shows whole, amounts at the end and as the page's language writes them.
const START = ["finance", "inventory", "billing"] as const;

describe("a template's preview", () => {
  test("Private Finanzen: date, amount and category of three bookings", () => {
    expect(preview("finance", "de")).toEqual({
      tables: 5,
      columns: [{ name: "Datum" }, { name: "Betrag", align: "end" }, { name: "Kategorie" }],
      rows: [
        ["01.04.", "3.200,00", "Gehalt"],
        ["02.04.", "980,00", "Miete"],
        ["18.04.", "28,90", "Bücher"],
      ],
    });
  });

  test("Rechnungswesen: number, amount and customer of three invoices", () => {
    expect(preview("billing", "de")).toMatchObject({
      columns: [{ name: "Nr." }, { name: "Betrag", align: "end" }, { name: "Kunde" }],
      rows: [
        ["RE-0001", "1.190,00", "Nordlicht"],
        ["RE-0002", "476,00", "Weber"],
        ["RE-0003", "89,25", "Atelier K"],
      ],
    });
    expect(preview("billing", "en")?.columns.map((column) => column.name)).toEqual(["No.", "Amount", "Customer"]);
  });

  test("every start template brings three columns and three rows of short words, in English and German", () => {
    for (const locale of ["de", "en"])
      for (const id of START) {
        const shown = preview(id, locale);
        expect(shown?.columns).toHaveLength(3);
        expect(shown?.rows).toHaveLength(3);
        // the phone shows two columns: an amount stands second so it stays in view
        for (const [index, column] of (shown?.columns ?? []).entries())
          if (column.align === "end") expect({ id, amountColumn: index }).toEqual({ id, amountColumn: 1 });
        // a card's column holds about ten characters; a longer word would end in "…"
        for (const text of [...(shown?.columns.map((column) => column.name) ?? []), ...(shown?.rows.flat() ?? [])])
          expect({ id, locale, text, fits: text.length <= 10 }).toMatchObject({ fits: true });
      }
    expect(preview("missing", "de")).toBeNull();
  });
});
