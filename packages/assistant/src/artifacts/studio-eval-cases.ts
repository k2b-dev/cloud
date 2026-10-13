// Assistant routing cases for scripts/eval-code-mode.ts: one fresh chat per user request.

export type StudioEvalCase = {
  name: string;
  locale: "de" | "en";
  /** An answer is direct (optionally calculated), with no app or view presentation: route "none". */
  expect: "studio-app" | "view" | "answer";
  request: string;
  files?: { path: string; mediaType: string; bytes: () => Uint8Array }[];
};

/** Upper bound for one case: model turns, checks and presentation. */
export const STUDIO_EVAL_CASE_MS = 25 * 60_000;
const SHOW = "Zeig mir die App hier im Chat.";
export const STUDIO_EVAL_CASES: StudioEvalCase[] = [
  {
    name: "todo",
    locale: "de",
    expect: "studio-app",
    request: `Ich brauche eine einfache Todo-Liste als App. Meine Aufgaben sollen gespeichert bleiben, ich will sie abhaken, löschen und nach offen und erledigt filtern können. ${SHOW}`,
  },
  {
    name: "csv-dashboard",
    locale: "de",
    expect: "studio-app",
    request: `Hier ist unser Bestellexport aus der Warenwirtschaft (bestellungen.csv). Bau mir daraus ein Dashboard als App: Umsatz pro Monat, die Top-Kunden und ein Filter nach Region. Die Datei soll in der App gespeichert sein, damit das Team sie ohne neuen Upload sieht. ${SHOW}`,
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "travel-expenses",
    locale: "de",
    expect: "studio-app",
    request: `Ich brauche eine App für meine Reisekostenabrechnung: Belege mit Datum, Zweck, Kategorie und Betrag erfassen, die Summe sehen, Belege löschen und am Ende ein PDF zum Einreichen mit Unterschriftszeilen herunterladen. ${SHOW}`,
  },
  {
    name: "quote-pdf",
    locale: "de",
    expect: "studio-app",
    request: `Bau mir einen Angebotsgenerator als App: Kunde und Angebotsnummer eingeben, Positionen mit Menge und Einzelpreis hinzufügen, Netto, 19 % MwSt. und Brutto sehen und das Angebot als PDF herunterladen. ${SHOW}`,
  },
  {
    name: "contacts",
    locale: "de",
    expect: "studio-app",
    request: `Wir brauchen eine gemeinsame Kontaktliste fürs Team als App: Name, Firma, E-Mail, Telefon und Notiz; suchen, bearbeiten und löschen. Alle im Team sollen dieselben Kontakte sehen. ${SHOW}`,
  },
  {
    name: "time-tracking",
    locale: "de",
    expect: "studio-app",
    request: `Ich brauche eine Zeiterfassung als App: pro Projekt Zeiten eintragen (Datum, Projekt, Stunden, Notiz). Dazu eine Wochenübersicht mit einem Diagramm der Stunden pro Projekt und einen Export als CSV für die Buchhaltung. ${SHOW}`,
  },
  {
    name: "expense-approval",
    locale: "de",
    expect: "studio-app",
    request: `Baue mir eine Spesen-Freigabe für mein Team: Alle reichen Spesen ein (Betrag, Zweck, Datum). Ich sehe die offenen Anträge und kann sie genehmigen oder ablehnen. Die genehmigten Spesen will ich als PDF-Liste exportieren. ${SHOW}`,
  },
  {
    name: "calculator-de",
    locale: "de",
    expect: "studio-app",
    request: "Bau mir eine Taschenrechner-App",
  },
  {
    name: "calculator-en",
    locale: "en",
    expect: "studio-app",
    request: "Build me a calculator app",
  },
  {
    name: "unit-converter-de",
    locale: "de",
    expect: "studio-app",
    request: "Ich brauche einen Einheitenumrechner für Länge, Gewicht und Temperatur",
  },
  {
    name: "unit-converter-en",
    locale: "en",
    expect: "studio-app",
    request: "I need a unit converter for length, weight and temperature",
  },
  {
    name: "tip-calculator-de",
    locale: "de",
    expect: "studio-app",
    request: "Bau mir einen Trinkgeldrechner, der die Rechnung auf mehrere Personen aufteilt",
  },
  {
    name: "tip-calculator-en",
    locale: "en",
    expect: "studio-app",
    request: "Build me a tip calculator that splits the bill between several people",
  },
  {
    name: "timer-de",
    locale: "de",
    expect: "studio-app",
    request: "Mach mir einen Timer mit Start, Pause und Zurücksetzen",
  },
  {
    name: "timer-en",
    locale: "en",
    expect: "studio-app",
    request: "Make me a countdown timer with start, pause and reset",
  },
  {
    name: "form-de",
    locale: "de",
    expect: "studio-app",
    request: "Erstell mir ein einfaches Formular, in das mein Team Urlaubswünsche einträgt",
  },
  {
    name: "form-en",
    locale: "en",
    expect: "studio-app",
    request: "Create a simple form where my team enters vacation requests",
  },
  {
    name: "sales-chart-de",
    locale: "de",
    expect: "view",
    request: "Zeig mir eine Grafik der Umsätze",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "top-customers-de",
    locale: "de",
    expect: "view",
    request: "Tabelle der Top 10 Kunden nach Umsatz",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "sales-chart-en",
    locale: "en",
    expect: "view",
    request: "Show me a chart of the revenue",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "top-customers-en",
    locale: "en",
    expect: "view",
    request: "Table of the top 10 customers by revenue",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "dashboard-de",
    locale: "de",
    expect: "view",
    request: "Mach mir ein Dashboard der Umsätze aus dieser CSV",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "dashboard-en",
    locale: "en",
    expect: "view",
    request: "Give me a dashboard of this export",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "explorer-de",
    locale: "de",
    expect: "view",
    request: "Lass mich die Bestellungen nach Region filtern und vergleichen",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "explorer-en",
    locale: "en",
    expect: "view",
    request: "Let me filter and compare the orders by region",
    files: [{ path: "/bestellungen.csv", mediaType: "text/csv", bytes: () => orderCsv() }],
  },
  {
    name: "tip-answer-de",
    locale: "de",
    expect: "answer",
    request: "Was sind 15 % Trinkgeld auf 84,50 € für 3 Personen?",
  },
  {
    name: "tip-answer-en",
    locale: "en",
    expect: "answer",
    request: "What is a 15% tip on $84.50 split between 3 people?",
  },
  {
    name: "convert-answer-de",
    locale: "de",
    expect: "answer",
    request: "Rechne 5 Meilen in Kilometer um",
  },
  {
    name: "convert-answer-en",
    locale: "en",
    expect: "answer",
    request: "Convert 5 miles to kilometers",
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
