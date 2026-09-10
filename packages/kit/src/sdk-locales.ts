export const sdkGerman: Record<string, string> = {
  "db.tables.list":
    "Tabellen und Zeilenzahlen der gemeinsamen Server-Datenbank auflisten. rsql und die App-Datenbank müssen aktiviert sein.",
  "db.tables.create": "Tabelle anlegen. Erfordert App-Admin. Spalten haben name, type sowie optional not_null, unique und index.",
  "db.tables.delete": "Tabelle und Datensätze löschen. Erfordert App-Admin.",
  "db.table":
    "Gebundene Methoden: schema.get(), schema.update(changes) sowie rows.list(query), rows.get(id), rows.insert(rowOrRows), rows.update(id,row), rows.delete(id). Schemaänderungen benötigen Admin, Datensätze Use. Listen liefern rsql data/meta; höchstens 1000 Zeilen pro Seite.",
  "db.query":
    "SELECT-Teilmenge mit gebundenen Parametern und höchstens 1000 Ergebniszeilen. Keine CTEs, Kommentare, internen Objekte oder beliebigen Funktionen. Für Schreibzugriffe die Row-APIs verwenden.",
  "db.importData":
    "Validierte JSON-Zeilen in sequenziellen Batches anhängen. Fehlende Tabellen benötigen createTable und Admin. Ergebnis: { confirmedRows, totalRows, status, error? }; status ist complete, cancelled, failed oder unknown. Keine automatischen Schreib-Retries. Abbruch erhält bestätigte Batches. onProgress erhält { confirmedRows, totalRows, phase }. Standardmäßig Fortschritts-Toast; notify:false blendet ihn aus. Bewusst neue Importe können Duplikate einfügen.",

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
