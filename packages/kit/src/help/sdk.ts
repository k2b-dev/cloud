import { sdkReference } from "../sdk";

// Signatures come only from sdkReference; localized explanations stay app-owned.
const de: Record<string, string> = {
  "db.tables.list":
    "Tabellen und Zeilenzahlen der gemeinsamen Server-Datenbank auflisten. rsql und die App-Datenbank müssen aktiviert sein.",
  "db.tables.create": "Tabelle anlegen. Erfordert App-Admin. Spalten haben name, type sowie optional not_null, unique und index.",
  "db.tables.delete": "Tabelle und Datensätze löschen. Erfordert App-Admin.",
  "db.table":
    "Gebundene Methoden: schema.get(), schema.update(changes) sowie rows.list(query), rows.get(id), rows.insert(rowOrRows), rows.update(id,row), rows.delete(id). Schemaänderungen benötigen Admin, Datensätze Use. Listen liefern rsql data/meta; höchstens 1000 Zeilen pro Seite.",
  "db.query":
    "SELECT-Teilmenge mit gebundenen Parametern und höchstens 1000 Ergebniszeilen. Keine CTEs, Kommentare, internen Objekte oder beliebigen Funktionen. Für Schreibzugriffe die Row-APIs verwenden.",
  "db.importData":
    "Validierte JSON-Zeilen in sequenziellen Batches anhängen. Fehlende Tabellen benötigen createTable und Admin. Ergebnis: { confirmedRows, totalRows, status, error? }; status ist complete, cancelled oder unknown. Keine automatischen Schreib-Retries. Abbruch erhält bestätigte Batches. onProgress erhält { confirmedRows, totalRows, phase }. Standardmäßig Fortschritts-Toast; notify:false blendet ihn aus. Bewusst neue Importe können Duplikate einfügen.",

  "pdf.text":
    "Lokalen PDF-Text mit PDF.js als [{ page, text }] auslesen. Keine OCR oder Uploads. Bis 16 MiB Datei/Text und 1000 Seiten; onProgress(page, total). Stoppen beendet den Worker.",
  script: "Definiert ein Werkzeug mit statischen Metadaten.",
  "ui.text": "Text anzeigen; mit set(text) aktualisieren.",
  "ui.button": "Worker-Callback ausführen. Standardmäßig sekundär; setDisabled und setLoading steuern den Zustand.",
  "ui.input": "Texteingabe; getValue() liest den Wert. onChange reagiert auf Eingaben.",
  "ui.select": "Optionen benötigen value und label; icon und description sind optional. getValue() liefert den Wert.",
  "ui.table":
    "set(rows) ersetzt alle Zeilen. upsert(rows) ersetzt passende Schlüssel an Ort und Stelle und hängt neue Zeilen an. remove(ids) entfernt passende Zeilen, remove() leert die Anzeige, remove([]) ändert nichts. upsert und gezieltes remove brauchen rowKey und eindeutige String-/Zahlenschlüssel. setColumns und setState bleiben verfügbar; höchstens 1000 Zeilen.",
  "ui.workbench":
    "Eine Werkbank als Wurzel: Eingaben links, Ergebnisse rechts und eine gemeinsame Fußzeile. Auf kleinen Bildschirmen untereinander.",
  "ui.section": "Elemente mit einer gemeinsamen Überschrift gruppieren.",
  "ui.filePicker": "Lokale Dateien wählen; Callback erhält File[]. Abbrechen erhält die bisherige Auswahl.",
  "ui.status": "Status anzeigen; set, setState und setDescription aktualisieren ihn.",
  "ui.list":
    "Einträge mit id, title, optional description, icon und action anzeigen. set(items) ersetzt sichtbare Einträge. upsert(items) ersetzt passende IDs und hängt neue an. remove(ids) entfernt passende Einträge, remove() leert die Anzeige, remove([]) ändert nichts. IDs müssen eindeutig sein. Aktions-Handles wiederverwenden; entfernte Einträge behalten ihre Handles in der Liste. action kann auch eine Button-Zeile sein. Höchstens 1000 Einträge; das UI-Knotenlimit gilt weiterhin.",
  "ui.link": "Textlink für relative URLs, HTTP(S) oder mailto. Erlaubt keinen Netzwerkzugriff im Worker.",
  "ui.linkButton": "Link als Schaltfläche; standardmäßig sekundär.",
  "ui.markdown":
    "Cloud-Markdown anzeigen und mit set aktualisieren. HTML wird maskiert; Bilder erscheinen als Alternativtext ohne Netzwerkanfrage.",
  "ui.modal.confirm": "Bestätigung mit verpflichtendem Titel. Promise<boolean>; Abbrechen liefert false.",
  "ui.modal.text":
    "Texteingabe mit Titel und Feldbeschriftung. value, required, minLength, maxLength und multiline sind optional. Promise<string|null>; Abbrechen liefert null.",
  "ui.modal.number":
    "Zahleingabe mit Titel und Feldbeschriftung. value, required, min und max sind optional. Promise<number|null>; Abbrechen liefert null.",
  "ui.modal.dialog":
    "Formular mit 1–64 benannten Feldern: type text, number, select oder boolean; label ist Pflicht. Gemeinsame Optionen: required, default, description, placeholder. Text: minLength/maxLength/multiline; Zahl: min/max/step; Select: options mit value und label, optional icon/description. Keine Funktionen im Schema. Ergebnis ist ein Objekt oder null bei Abbruch. Standardbuttons und Fehler folgen der Cloud-Sprache. Stoppen und Navigation schließen Dialoge; Host-Aufrufe laufen sequenziell.",
  "ui.chart":
    "Responsives stdlib-Diagramm über die gemeinsame UI. Alle 14 Typen: line, scatter, bar, pie, donut, sparkline, histogram, boxplot, gauge, barGauge, stat, heatmap, map, stateTimeline. JSON-Daten und stdlib-Optionsnamen; keine Formatter-Funktionen, HTML, Links, CSS-Klassen oder externen Ressourcen. set({kind,...options}) ersetzt die Konfiguration. Größe, Theme und Leerzustand übernimmt die UI. Insgesamt höchstens 1000 Array-Einträge; upsert/remove gelten nur für Listen und Tabellen.",
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
  db: 'const result = await kit.db.importData("items", [{ label: "Example", amount: 1200 }], { createTable: true });\nkit.ui.text(JSON.stringify(result));',
  pdf: 'const file = await kit.file.open({ accept: ".pdf" });\nif (file) { const pages = await kit.pdf.text(file); kit.ui.text(pages.map(p => p.text).join("\\n")); }',
  script: 'export default kit.script({ name: "Main", run() { kit.ui.text("Hello!"); } });',
  ui: 'const status = kit.ui.status("Ready");\nconst table = kit.ui.table({ columns: [{ key: "name", label: "Name" }] });\nconst picker = kit.ui.filePicker("CSV", { accept: ".csv,text/csv", async onChange(files) {\n  if (!files.length) return;\n  try { table.set((await kit.sheet.fromCsv(files[0])).slice(0, 100)); }\n  catch (error) { status.setState("error"); status.set(error.message); }\n} });\nkit.ui.workbench({ controls: [picker], content: [table], footer: { status } });',
  file: 'const file = await kit.file.open({ accept: ".csv,text/csv" });\nif (file) await kit.file.save(await file.text(), "copy.csv");',
  sheet:
    'const rows = await kit.sheet.fromCsv("name;amount\\nExample;12,34");\nconst csv = kit.sheet.toCsv(rows, { delimiter: ";" });\nawait kit.file.save(csv, "result.csv");',
  money:
    'const net = kit.money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });\nconst { gross } = kit.money.taxFromNet(net, { percent: "19", rounding: "half-up" });\nkit.ui.text(kit.money.format(gross, { locale: "de-DE" }));\nconst shares = kit.money.allocate(gross, [1, 1, 1]);',
  store: 'const history = await kit.store.get("history") ?? [];\nawait kit.store.set("history", [...history, { filename: "result.csv" }]);',
  opfs: 'await kit.opfs.write("exports/result.csv", "name;amount\\nExample;12,34");\nconst saved = await kit.opfs.read("exports/result.csv");\nif (saved) await kit.file.save(saved, "result.csv");',
};
export function sdkHelp(locale: "en" | "de") {
  return ["script", "ui", "file", "sheet", "money", "store", "opfs", "pdf", "db"].map((namespace, index) => {
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
    const database =
      namespace === "db"
        ? locale === "de"
          ? '\n\nGemeinsame Daten werden über den Host auf dem Server verarbeitet. Erst ein Cloud-Admin und dann ein App-Admin müssen die Funktion aktivieren. Use teilt sämtliche Zeilen der App; es gibt keine automatischen Zeilenrechte.\n\nSpaltentypen: text, integer, real, boolean, json, date, datetime. Namen beginnen mit einem Buchstaben und enthalten nur Buchstaben, Ziffern und Unterstriche (maximal 63 Zeichen). id, created_at und updated_at verwaltet rsql. schema.update akzeptiert { rename?, add_columns?, drop_columns?, rename_columns? }; rename_columns ordnet alte Namen neuen Namen zu.\n\nrows.list({ label: "eq.Example", order: "label.asc", limit: 50, offset: 0 }) liefert { data, meta }. query("SELECT * FROM items WHERE amount > ?", [100]) liefert { data }. Listen und SELECT liefern höchstens 1000 Zeilen, Ergebnisse höchstens 16 MiB. Einzelne Requests passen in 2 MiB plus Transporthülle; Importe teilen bis zu 16 MiB Eingabedaten in kleinere Batches.\n\nFür Einzelpersonen einfache Reads/Writes und sequenzielle Importe verwenden. Constraints helfen bei gemeinsam bearbeiteten Daten; Read-then-write und mehrere Import-Batches sind keine atomare Transaktion. Keine Locks oder Queues ohne konkreten Bedarf.'
          : '\n\nShared data is processed on the server through the host. A Cloud admin and then an app admin must enable the feature. Use shares every row in the app; there are no automatic row-level permissions.\n\nColumn types: text, integer, real, boolean, json, date, datetime. Names start with a letter and contain only letters, digits and underscores (up to 63 characters). rsql manages id, created_at and updated_at. schema.update accepts { rename?, add_columns?, drop_columns?, rename_columns? }; rename_columns maps old names to new names.\n\nrows.list({ label: "eq.Example", order: "label.asc", limit: 50, offset: 0 }) returns { data, meta }. query("SELECT * FROM items WHERE amount > ?", [100]) returns { data }. Lists and SELECT return at most 1000 rows; results are limited to 16 MiB. Individual requests fit 2 MiB plus their transport envelope; imports split up to 16 MiB of input into smaller batches.\n\nFor one-person tools, use simple reads/writes and sequential imports. Constraints help with shared edits; read-then-write and multiple import batches are not atomic transactions. Do not add locks or queues without an actual requirement.'
        : "";
    const money =
      namespace === "money"
        ? locale === "de"
          ? "\n\nGeld ist { amount, currency }, mit ganzzahligen Untereinheiten. Währungen dürfen nicht gemischt werden. Rundung: half-up, half-even oder toward-zero. Faktoren und Steuersätze sind Dezimalstrings; Parsing akzeptiert keine Währungssymbole. Fehler werden geworfen."
          : "\n\nMoney is { amount, currency }, with safe integer minor units. Mixed currencies are rejected. Rounding: half-up, half-even or toward-zero. Factors and tax percentages are decimal strings; parsing accepts no currency symbols. Invalid inputs throw."
        : "";
    return `---\nid: kit-sdk-${namespace}\ntitle: "Kit SDK: ${namespace}"\nicon: ti ti-code\ndescription: "${locale === "de" ? "Signaturen und Beispiel für" : "Signatures and example for"} kit.${namespace}"\norder: ${200 + index}\n---\n\n${intro}${database}${money}\n\n${body}\n\n## ${locale === "de" ? "Beispiel" : "Example"}\n\n\`\`\`js\n${examples[namespace]}\n\`\`\`\n`;
  });
}
