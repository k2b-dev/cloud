// Studio app cases for scripts/eval-code-mode.ts: one fresh chat per German user request.

export type StudioEvalCase = { name: string; request: string; files?: { path: string; mediaType: string; bytes: () => Uint8Array }[] };

/** Upper bound for one case: model turns, checks and presentation. */
export const STUDIO_EVAL_CASE_MS = 25 * 60_000;
const SHOW = "Zeig mir die App hier im Chat.";
export const STUDIO_EVAL_CASES: StudioEvalCase[] = [
  {
    name: "todo",
    request: `Ich brauche eine einfache Todo-Liste als App. Meine Aufgaben sollen gespeichert bleiben, ich will sie abhaken, löschen und nach offen und erledigt filtern können. ${SHOW}`,
  },
  {
    name: "csv-dashboard",
    request: `Hier ist unser Bestellexport aus der Warenwirtschaft (bestellungen.csv). Bau mir daraus ein Dashboard als App: Umsatz pro Monat, die Top-Kunden und ein Filter nach Region. Die Datei soll in der App gespeichert sein, damit das Team sie ohne neuen Upload sieht. ${SHOW}`,
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "travel-expenses",
    request: `Ich brauche eine App für meine Reisekostenabrechnung: Belege mit Datum, Zweck, Kategorie und Betrag erfassen, die Summe sehen, Belege löschen und am Ende ein PDF zum Einreichen mit Unterschriftszeilen herunterladen. ${SHOW}`,
  },
  {
    name: "quote-pdf",
    request: `Bau mir einen Angebotsgenerator als App: Kunde und Angebotsnummer eingeben, Positionen mit Menge und Einzelpreis hinzufügen, Netto, 19 % MwSt. und Brutto sehen und das Angebot als PDF herunterladen. ${SHOW}`,
  },
  {
    name: "contacts",
    request: `Wir brauchen eine gemeinsame Kontaktliste fürs Team als App: Name, Firma, E-Mail, Telefon und Notiz; suchen, bearbeiten und löschen. Alle im Team sollen dieselben Kontakte sehen. ${SHOW}`,
  },
  {
    name: "time-tracking",
    request: `Ich brauche eine Zeiterfassung als App: pro Projekt Zeiten eintragen (Datum, Projekt, Stunden, Notiz). Dazu eine Wochenübersicht mit einem Diagramm der Stunden pro Projekt und einen Export als CSV für die Buchhaltung. ${SHOW}`,
  },
  {
    name: "expense-approval",
    request: `Baue mir eine Spesen-Freigabe für mein Team: Alle reichen Spesen ein (Betrag, Zweck, Datum). Ich sehe die offenen Anträge und kann sie genehmigen oder ablehnen. Die genehmigten Spesen will ich als PDF-Liste exportieren. ${SHOW}`,
  },
];

/** A German ERP export: semicolons, decimal commas, Windows-1252, 300 orders over twelve months. */
export function orderCsv() {
  const customers = [
    ["Nordlicht Medien GmbH", "Nord"],
    ["Café Strandgut", "Nord"],
    ["Werft Janssen & Co.", "Nord"],
    ["Weingut Schäfer", "West"],
    ["Rheinblick Hotel KG", "West"],
    ["Bäckerei Overbeck", "West"],
    ["Spreewald Logistik", "Ost"],
    ["Elbtal Druckerei", "Ost"],
    ["Alpenglück Sport", "Süd"],
    ["Brauhaus Görlitz", "Ost"],
    ["Isar Planungsbüro", "Süd"],
    ["Schwarzwald Holzbau", "Süd"],
  ];
  let seed = 7;
  const next = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const rows = ["Bestelldatum;Kunde;Region;Artikel;Menge;Umsatz netto"];
  const articles = ["Druckpapier A4", "Toner schwarz", "Bürostuhl Comfort", "Monitor 27 Zoll", "Kaffee Bio 1 kg"];
  for (let index = 0; index < 300; index++) {
    const [customer, region] = customers[Math.floor(next() ** 1.6 * customers.length)]!;
    const date = new Date(Date.UTC(2025, 9, 1) + Math.floor(next() * 365) * 86_400_000);
    const quantity = 1 + Math.floor(next() * 24);
    const cents = quantity * (900 + Math.floor(next() * 21_000));
    const amount = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2 }).format(cents / 100);
    const day = date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
    rows.push([day, customer, region, articles[index % articles.length], quantity, amount].join(";"));
  }
  // Every character above is Latin-1, where Windows-1252 and Unicode share code points.
  return Uint8Array.from(rows.join("\r\n") + "\r\n", (character) => character.charCodeAt(0));
}
