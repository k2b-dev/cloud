import { sdkReference } from "../sdk";

// Signatures come only from sdkReference; localized explanations stay app-owned.
const de: Record<string, string> = {
  "pdf.text": "Lokalen PDF-Text mit PDF.js als [{ page, text }] auslesen. Keine OCR oder Uploads. Bis 16 MiB Datei/Text und 1000 Seiten; onProgress(page, total). Stoppen beendet den Worker.",
  script: "Definiert ein Werkzeug mit statischen Metadaten.",
  "ui.text": "Text anzeigen; mit setText(text) aktualisieren.",
  "ui.button": "Worker-Callback ausführen. Standardmäßig sekundär; setDisabled und setLoading steuern den Zustand.",
  "ui.input": "Texteingabe; getValue() liest den Wert. onChange reagiert auf Eingaben.",
  "ui.select": "Optionen benötigen value und label; icon und description sind optional. getValue() liefert den Wert.",
  "ui.table": "setRows, setColumns und setState aktualisieren die Tabelle. Höchstens 1000 sichtbare Zeilen.",
  "ui.workbench":
    "Eine Werkbank als Wurzel: Eingaben links, Ergebnisse rechts und eine gemeinsame Fußzeile. Auf kleinen Bildschirmen untereinander.",
  "ui.section": "Elemente mit einer gemeinsamen Überschrift gruppieren.",
  "ui.filePicker": "Lokale Dateien wählen; Callback erhält File[]. Abbrechen erhält die bisherige Auswahl.",
  "ui.status": "Status anzeigen; setText, setState und setDescription aktualisieren ihn.",
  "ui.list":
    "Einträge mit id, title, optional description, icon und action anzeigen. Jede ID muss eindeutig sein; action ist ein UI-Handle.",
  "ui.link": "Textlink für relative URLs, HTTP(S) oder mailto. Erlaubt keinen Netzwerkzugriff im Worker.",
  "ui.linkButton": "Link als Schaltfläche; standardmäßig sekundär.",
  "ui.markdown":
    "Cloud-Markdown anzeigen und mit setMarkdown aktualisieren. HTML wird maskiert; Bilder erscheinen als Alternativtext ohne Netzwerkanfrage.",
  "ui.progress": "Fortschritt mit set(fraction) zwischen null und eins setzen.",
  "ui.row": "Elemente horizontal mit Zeilenumbruch anordnen.",
  "ui.column": "Elemente vertikal anordnen.",
  "file.open": "Eine lokale Datei wählen; Promise<File|null>. accept nutzt HTML-Dateifilter, etwa .csv,text/csv.",
  "file.openMultiple": "Mehrere lokale Dateien wählen; Promise<File[]>.",
  "file.openFolder": "Ordner mit Unterordnern wählen; Promise<File[]> mit webkitRelativePath.",
  "file.save": "Sofort einen lokalen Download anfordern. Die Browser-Einstellungen gelten weiterhin.",
  "sheet.fromCsv": "CSV mit Kopfzeile lesen; Werte und Kennungen bleiben Strings.",
  "sheet.toCsv": "Excel-kompatible CSV erzeugen; standardmäßig Semikolon, BOM und Schutz vor Tabellenformeln.",
  "store.get": "JSON aus dem lokalen App-Speicher lesen; fehlender Schlüssel liefert null.",
  "store.set": "JSON lokal speichern. Der Speicher muss für die App freigegeben sein.",
  "store.delete": "Einen lokalen Schlüssel löschen.",
  "store.keys": "Schlüssel dieser App und dieses Benutzers auflisten.",
  "opfs.read": "Lokale File oder null lesen.",
  "opfs.write": "In den eigenen App-Ordner schreiben; ausgewählte Originale werden nicht überschrieben.",
  "opfs.delete": "Eine relative Datei löschen.",
  "opfs.list": "Relative Dateipfade dieser App und dieses Benutzers auflisten.",
  "money.fromMinor": "Geld aus ganzzahligen Untereinheiten erzeugen, bei EUR aus Cent.",
  "money.fromDecimal": "Dezimalstring lesen. Überzählige Nachkommastellen benötigen eine Rundungsregel.",
  "money.toDecimal": "Dezimalstring in Haupteinheiten mit fester Nachkommastellenzahl erzeugen.",
  "money.currencyDigits": "Nachkommastellenzahl einer Währung bestimmen.",
  "money.parse": "Zahlentext mit expliziter Sprache und Währung lesen.",
  "money.format": "Geld mit expliziter Sprache formatieren.",
  "money.add": "Werte derselben Währung addieren.",
  "money.subtract": "Werte derselben Währung subtrahieren.",
  "money.sum": "Werte summieren. Eine leere Liste benötigt currency.",
  "money.compare": "Werte derselben Währung vergleichen: -1, 0 oder 1.",
  "money.multiply": "Mit einem Dezimalstring multiplizieren; Rundungsregel erforderlich.",
  "money.divide": "Durch einen Dezimalstring dividieren; Rundungsregel erforderlich.",
  "money.taxFromNet": "Netto, Steuer und Brutto aus dem Nettobetrag berechnen.",
  "money.taxFromGross": "Netto, Steuer und Brutto aus dem Bruttobetrag berechnen.",
  "money.allocate": "Betrag exakt nach Gewichten aufteilen; Reste nach größtem Rest verteilen.",
};
const examples: Record<string, string> = {
  pdf: 'const file = await kit.file.open({ accept: ".pdf" });\nif (file) { const pages = await kit.pdf.text(file); kit.ui.text(pages.map(p => p.text).join("\\n")); }',
  script: 'export default kit.script({ name: "Main", run() { kit.ui.text("Hello!"); } });',
  ui: 'const status = kit.ui.status("Ready");\nconst table = kit.ui.table({ columns: [{ key: "name", label: "Name" }] });\nconst picker = kit.ui.filePicker("CSV", { accept: ".csv,text/csv", async onChange(files) {\n  if (!files.length) return;\n  try { table.setRows((await kit.sheet.fromCsv(files[0])).slice(0, 100)); }\n  catch (error) { status.setState("error"); status.setText(error.message); }\n} });\nkit.ui.workbench({ controls: [picker], content: [table], footer: { status } });',
  file: 'const file = await kit.file.open({ accept: ".csv,text/csv" });\nif (file) await kit.file.save(await file.text(), "copy.csv");',
  sheet:
    'const rows = await kit.sheet.fromCsv("name;amount\\nExample;12,34");\nconst csv = kit.sheet.toCsv(rows, { delimiter: ";" });\nawait kit.file.save(csv, "result.csv");',
  money:
    'const net = kit.money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });\nconst { gross } = kit.money.taxFromNet(net, { percent: "19", rounding: "half-up" });\nkit.ui.text(kit.money.format(gross, { locale: "de-DE" }));\nconst shares = kit.money.allocate(gross, [1, 1, 1]);',
  store: 'const history = await kit.store.get("history") ?? [];\nawait kit.store.set("history", [...history, { filename: "result.csv" }]);',
  opfs: 'await kit.opfs.write("exports/result.csv", "name;amount\\nExample;12,34");\nconst saved = await kit.opfs.read("exports/result.csv");\nif (saved) await kit.file.save(saved, "result.csv");',
};
export function sdkHelp(locale: "en" | "de") {
  return ["script", "ui", "file", "sheet", "money", "store", "opfs", "pdf"].map((namespace, index) => {
    const methods = sdkReference.methods.filter(([name]) => name === namespace || name.startsWith(`${namespace}.`));
    const body = methods
      .map(([name, signature, description]) => {
        if (locale === "de" && !de[name]) throw new Error(`Missing SDK translation: ${name}`);
        return `## kit.${name}\n\n\`kit.${signature}\`\n\n${locale === "de" ? de[name] : description}`;
      })
      .join("\n\n");
    const intro =
      locale === "de"
        ? "Diese Methoden laufen im isolierten Worker. Beispiele gehören in run() oder in einen Callback. Fachliche Texte bestimmst du selbst."
        : "These methods run in the isolated worker. Put examples inside run() or a callback. Script-authored text is your choice.";
    const money =
      namespace === "money"
        ? locale === "de"
          ? "\n\nGeld ist { amount, currency }, mit ganzzahligen Untereinheiten. Währungen dürfen nicht gemischt werden. Rundung: half-up, half-even oder toward-zero. Faktoren und Steuersätze sind Dezimalstrings; Parsing akzeptiert keine Währungssymbole. Fehler werden geworfen."
          : "\n\nMoney is { amount, currency }, with safe integer minor units. Mixed currencies are rejected. Rounding: half-up, half-even or toward-zero. Factors and tax percentages are decimal strings; parsing accepts no currency symbols. Invalid inputs throw."
        : "";
    return `---\nid: kit-sdk-${namespace}\ntitle: "Kit SDK: ${namespace}"\nicon: ti ti-code\ndescription: "${locale === "de" ? "Signaturen und Beispiel für" : "Signatures and example for"} kit.${namespace}"\norder: ${200 + index}\n---\n\n${intro}${money}\n\n${body}\n\n## ${locale === "de" ? "Beispiel" : "Example"}\n\n\`\`\`js\n${examples[namespace]}\n\`\`\`\n`;
  });
}
