import type { PublicField, PublicGridRecord } from "../../../api/public-dto";

export const field = (overrides: Partial<PublicField> & Pick<PublicField, "id" | "name" | "type">): PublicField => ({
  tableId: "table",
  description: null,
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

// The demo table where narrow dates and amounts broke beside the panel, with two more text columns so that
// its columns are narrow at 1920 px as well.
export const fields = [
  field({ id: "text", name: "Auftrag", type: "text", position: 0 }),
  field({ id: "status", name: "Status", type: "text", position: 1 }),
  field({ id: "customer", name: "Kunde", type: "text", position: 2 }),
  field({ id: "number", name: "Betrag", type: "number", position: 3, config: { decimalPlaces: 2, unit: "EUR", unitPosition: "suffix" } }),
  field({ id: "date", name: "Fällig", type: "date", position: 4 }),
  field({ id: "owner", name: "Zuständig", type: "text", position: 5 }),
  field({ id: "category", name: "Kategorie", type: "text", position: 6 }),
  field({ id: "place", name: "Ort", type: "text", position: 7 }),
  field({ id: "contact", name: "Ansprechpartner", type: "text", position: 8 }),
  field({ id: "lead", name: "Projektleitung", type: "text", position: 9 }),
  field({ id: "notes", name: "Notizen", type: "longtext", position: 10 }),
];

export const records: PublicGridRecord[] = Array.from({ length: 10 }, (_, index) => ({
  id: `record-${index}`,
  tableId: "table",
  data: {
    text: "Website-Relaunch",
    status: "In Arbeit",
    customer: "Bäckerei Sonnenkorn",
    number: "12400.00",
    date: "2026-11-14",
    owner: "Team Web",
    category: "Web",
    place: "Freiburg",
    contact: "Maria Sonnenkorn",
    lead: "Alex Beispiel",
    notes: "Abstimmung mit Bäckerei Sonnenkorn läuft. Entwürfe gehen diese Woche raus.",
  },
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));
