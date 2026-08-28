export type CompletionHelp = { detail: string; info: string };

/**
 * German presentation text keyed by the stable script API path. Signatures,
 * identifiers, type names, and examples stay verbatim; only explanatory prose
 * is localized. Keeping every entry explicit makes missing help fail loudly
 * when a new completion is added.
 */
export const GERMAN_COMPLETION_HELP: Record<string, CompletionHelp> = {
  current: {
    detail: "Aktuelle Notiz",
    info: "Lese- und Schreibzugriff auf die Notiz, in der dieses Skript steht, einschließlich benannter Blöcke wie `current.table('ideas')`.",
  },
  nb: {
    detail: "Notebook-API",
    info: "Notizen im aktuellen Notebook auflisten, durchsuchen, abrufen, erstellen, aktualisieren und löschen.",
  },
  ui: {
    detail: "UI-Bausteine",
    info: "Skriptausgaben aus Tabellen, Diagrammen, Schaltflächen, Dialogen, Markdown, Links und Karten erstellen.",
  },
  std: {
    detail: "Stdlib-Hilfen",
    info: "Ausgewählte Bereiche aus `@k2b/stdlib`: Datum, Text, unscharfe Suche, Diagramme, Dateien, Bilder und Zeitsteuerung.",
  },
  "current.id": { detail: "string", info: "Sechs Zeichen lange Kurz-ID dieser Notiz." },
  "current.title": { detail: "string", info: "Aktueller Titel als Momentaufnahme beim Start des Skripts." },
  "current.content": { detail: "string", info: "Aktueller Notizinhalt; im Bearbeitungsmodus wird direkt aus `Y.Text` gelesen." },
  "current.tags": { detail: "string[]", info: "Aus dem aktuellen Inhalt gelesene `#tags`." },
  "current.notebook": { detail: "{ id, name }", info: "Verweis auf das zugehörige Notebook." },
  "current.createdAt": { detail: "ISO string", info: "Zeitpunkt der Erstellung." },
  "current.updatedAt": { detail: "ISO string", info: "Zeitpunkt der letzten Aktualisierung." },
  "current.lockedAt": { detail: "ISO string | null", info: "Enthält einen Wert, wenn die Notiz gesperrt und schreibgeschützt ist." },
  "current.kv": {
    detail: "KV der aktuellen Notiz",
    info: "Gemeinsam bearbeitbarer Schlüssel-Wert-Speicher dieser Notiz. `current.kv.observe(...)` liefert laufende Änderungen.",
  },
  "current.table": {
    detail: "(name) → table view | undefined",
    info: "Liest eine benannte Markdown-Tabelle mit `@name`. Das Ergebnis bietet bei `current` zusätzlich `.add(...)`.",
  },
  "current.tables": {
    detail: "(name?) → table views",
    info: "Liest alle passenden benannten Tabellen. Ohne Namen werden alle benannten Tabellen dieser Notiz zurückgegeben.",
  },
  "current.list": {
    detail: "(name) → list view | undefined",
    info: "Liest eine benannte Liste mit `@name`. Das Ergebnis bietet bei `current` zusätzlich `.add(...)`.",
  },
  "current.lists": {
    detail: "(name?) → list views",
    info: "Liest alle passenden benannten Aufzählungen. Ohne Namen werden alle benannten Listen zurückgegeben.",
  },
  "current.todo": {
    detail: "(name) → todo view | undefined",
    info: "Liest eine benannte Aufgabenliste, etwa `@shopping` gefolgt von `- [ ] milk`.",
  },
  "current.todos": {
    detail: "(name?) → todo views",
    info: "Liest alle passenden benannten Aufgabenlisten. Ohne Namen werden alle benannten Aufgabenlisten zurückgegeben.",
  },
  "current.data": {
    detail: "(name) → data view | undefined",
    info: "Liest einen benannten `@name`-/`:::data`-Block. Das Ergebnis bietet bei `current` zusätzlich `.set(...)`.",
  },
  "current.dataBlocks": {
    detail: "(name?) → data views",
    info: "Liest alle passenden benannten `:::data`-Blöcke. Ohne Namen werden alle benannten Datenblöcke zurückgegeben.",
  },
  "current.section": {
    detail: "(name) → section view | undefined",
    info: "Liest einen benannten Überschriftenabschnitt. Das Ergebnis bietet bei `current` zusätzlich `.append(...)`.",
  },
  "current.sections": {
    detail: "(name?) → section views",
    info: "Liest alle passenden benannten Überschriftenabschnitte. Ohne Namen werden alle benannten Abschnitte zurückgegeben.",
  },
  "current.setContent": { detail: "(content) → Promise<void>", info: "Ersetzt den gesamten Inhalt in einer `Y.Text`-Transaktion." },
  "current.appendContent": {
    detail: "(markdown) → Promise<void>",
    info: "Hängt Markdown am Ende an und fügt bei Bedarf automatisch `\\n\\n` als Trennzeichen ein.",
  },
  "current.prependContent": {
    detail: "(markdown) → Promise<void>",
    info: "Fügt Markdown am Anfang ein und ergänzt automatisch ein abschließendes `\\n\\n`.",
  },
  "current.insertContentAt": {
    detail: "({line, col?}, markdown) → Promise<void>",
    info: "Fügt Markdown an der angegebenen Zeile und Spalte ein; Werte außerhalb des Inhalts werden auf gültige Grenzen begrenzt.",
  },
  "current.replaceLine": {
    detail: "(line, text) → Promise<void>",
    info: "Ersetzt die vollständige Zeile an der angegebenen, bei null beginnenden Zeilennummer.",
  },
  "nb.attachments": {
    detail: "Notebook-Anhänge",
    info: "Anhänge im aktuellen Notebook hochladen, auflisten, abrufen, einfügen und löschen.",
  },
  "nb.tags": { detail: "Schlagwortindex", info: "Alle `#tags` des Notebooks auflisten und Notizen zu einem Schlagwort finden." },
  "nb.localKV": {
    detail: "Persönlicher Notebook-KV",
    info: "Privater, dauerhafter Schlüssel-Wert-Speicher je Benutzer und Notebook.",
  },
  "nb.list": {
    detail: "() → Promise<KitNote[]>",
    info: "Gibt bis zu 1000 Notizen des aktuellen Notebooks intern seitenweise geladen zurück.",
  },
  "nb.get": {
    detail: "(shortId) → Promise<KitNote | null>",
    info: "Ruft eine Notiz über ihre Kurz-ID ab. Gibt `null` zurück, wenn sie fehlt oder zu einem anderen Notebook gehört.",
  },
  "nb.search": {
    detail: "(query | KitQuery) → Promise<KitNote[]>",
    info: "Sucht über einen Text in Titel und Inhalt oder über eine strukturierte Abfrage mit Schlagwörtern, Datumsbereichen, Limit und Offset.",
  },
  "nb.searchTags": {
    detail: "(tag | tags, options?) → Promise<KitNote[]>",
    info: "Findet Notizen, die alle angegebenen Schlagwörter enthalten. `search('#garden')` verwendet denselben Suchpfad.",
  },
  "nb.create": {
    detail: "({ parentId?, content? }?) → Promise<KitNote>",
    info: "Erstellt eine Notiz. Der Titel wird aus dem Inhalt abgeleitet; ohne Inhalt gilt die Standard-Titelvorlage des Notebooks.",
  },
  "nb.update": {
    detail: "(shortId, { parentId }) → Promise<KitNote>",
    info: "Verschiebt eine vorhandene Notiz unter eine andere Notiz oder an die Wurzel des Notebooks.",
  },
  "nb.remove": { detail: "(shortId) → Promise<void>", info: "Löscht eine Notiz dauerhaft." },
  "ui.row": {
    detail: "(...children) → KitElement",
    info: "Horizontales Flex-Layout mit Umbruch und Abstand. Elemente können `KitElement`, `HTMLElement`, Text oder falsy sein.",
  },
  "ui.col": { detail: "(...children) → KitElement", info: "Vertikales Flex-Layout mit Abstand zwischen den Elementen." },
  "ui.card": { detail: "(...children) → KitElement", info: "Container mit Innenabstand zur visuellen Gruppierung." },
  "ui.metric": {
    detail: "(label, value, options?) → KitElement",
    info: "Kompakte Dashboard-Kennzahl. Für KPI-Werte ist sie einer Kombination aus `card(heading(...), text(...))` vorzuziehen.",
  },
  "ui.divider": { detail: "() → KitElement", info: "Erstellt eine horizontale Trennlinie." },
  "ui.text": { detail: "(content) → KitElement", info: "Erstellt einen Absatz mit einfachem Text." },
  "ui.heading": { detail: "(content, level?) → KitElement", info: "Erstellt eine Überschrift von `h1` bis `h6`; Standard ist `h2`." },
  "ui.md": { detail: "(markdown) → KitElement", info: "Rendert beliebiges Markdown mit derselben Engine wie der Notizinhalt." },
  "ui.noteLink": {
    detail: "(note | shortId, label?) → KitElement",
    info: "Rendert einen anklickbaren Link zu einer Notiz und akzeptiert eine `KitNote` oder eine Kurz-ID.",
  },
  "ui.noteList": {
    detail: "(notes, options?) → KitElement",
    info: "Rendert eine kompakte vertikale Liste mit Notizlinks. Optionen: `{ emptyText }`.",
  },
  "ui.table": {
    detail: "(rows, options?) → KitElement",
    info: "Rendert Zeilen wie Markdown-Tabellen als Kacheltabelle. Werte vom Typ `KitNote` werden zu Notizlinks, Schlagwortlisten zu Pillen.",
  },
  "ui.chart": {
    detail: "(kind, options) → KitElement",
    info: "Rendert ein SVG-Diagramm aus der stdlib. Die Breite wird am Ausgabecontainer gemessen; die Höhe wird in Pixeln angegeben.",
  },
  "ui.button": {
    detail: "(label, onClick, options?) → KitElement",
    info: "Erstellt eine anklickbare Schaltfläche. Optionen: `{ variant: 'primary'|'secondary'|'danger', icon?: 'ti ti-…', disabled?: boolean }`.",
  },
  "ui.html": {
    detail: "(rawHtml) → KitElement",
    info: "Fasst unverändertes HTML in einen Container. Nur für vertrauenswürdige Skripte; der Inhalt wird nicht bereinigt.",
  },
  "ui.live": {
    detail: "(render) → KitElement",
    info: "Rendert einen reaktiven Bereich. Im Bearbeitungsmodus wird er bei Änderungen am aktuellen Notizinhalt neu berechnet, in der Leseansicht einmalig.",
  },
  "ui.render": {
    detail: "(...elements) → void",
    info: "Hängt Elemente in den Ausgabecontainer des Skripts ein. Entspricht einem Aufruf von `.show()` für jedes Element.",
  },
  "ui.toast": {
    detail: "(description, options?) → void",
    info: "Zeigt eine globale Kurzmeldung. Optionen: `{ variant: 'default'|'success'|'error', duration, title, iconClass }`.",
  },
  "ui.prompt": { detail: "Modale Dialoge", info: "Promise-basierte Dialoge mit `alert`, `confirm`, `text` und `form`." },
  "std.text": {
    detail: "Textbearbeitung",
    info: "Bietet `slugify`, `humanize`, `titleify`, `truncate`, `summarize`, Fallkonvertierungen und `pprintBytes`.",
  },
  "std.dates": {
    detail: "Datums- und Zeitformatierung",
    info: "Bietet `formatDate`, `formatDateTime`, `formatDateTimeRelative` und `formatDuration`.",
  },
  "std.fuzzy": { detail: "Unscharfe Suche", info: "Bietet `match`, `filter`, `segments`, `closest` und `distance`." },
  "std.crypto": {
    detail: "Hashing und Kryptografie",
    info: "Bietet Hashes, IDs, asymmetrische und symmetrische Kryptografie sowie TOTP.",
  },
  "std.encoding": { detail: "Bytes ↔ Text", info: "Konvertiert Base64, Hex und Base62." },
  "std.charts": {
    detail: "SVG-Diagramme",
    info: "Erzeugt SVG-Diagramme auf niedriger Ebene. Für eine gerenderte Ausgabe ist `ui.chart(kind, options)` vorzuziehen.",
  },
  "std.qr": { detail: "QR-Code-Generatoren", info: "Erzeugt QR-Nutzdaten und rendert sie als SVG." },
  "std.password": { detail: "Passworterzeugung", info: "Bietet `random`, `memorable`, `pin` und eine Prüfung der Passwortstärke." },
  "std.timing": { detail: "Zeitsteuerung", info: "Bietet `sleep`, `debounce`, `throttle`, `jitter` und `withMinLoadTime`." },
  "std.files": {
    detail: "Dateidownloads und Dialoge",
    info: "Bietet Downloads, ZIP-Dateien, Datei- und Ordnerauswahl sowie MIME-Hilfen.",
  },
  "std.images": { detail: "Bildverarbeitung", info: "Ändert Größe und Ausschnitt, wendet Filter an, dreht und konvertiert Bilder." },
  "std.clipboard": { detail: "Zwischenablage", info: "Kopiert Text mit `copy(text)` in die Zwischenablage." },
  "current.kv.get": {
    detail: "(key) → T | undefined",
    info: "Liest synchron aus der gemeinsam bearbeitbaren `Y.Map`. Gibt `undefined` zurück, wenn der Schlüssel fehlt.",
  },
  "current.kv.set": {
    detail: "(key, value | updater) → void",
    info: "Schreibt synchron einen Wert oder verwendet eine Aktualisierungsfunktion, die den aktuellen Wert erhält.",
  },
  "current.kv.delete": {
    detail: "(key) → void",
    info: "Entfernt einen Wert synchron und synchronisiert die Änderung mit allen Mitwirkenden.",
  },
  "current.kv.keys": { detail: "() → string[]", info: "Gibt alle gesetzten Schlüssel alphabetisch sortiert zurück." },
  "current.kv.observe": {
    detail: "(key, cb) → unsubscribe()",
    info: "Ruft `cb` auf, sobald ein beliebiger Teilnehmer den Wert zu `key` ändert. Die Beobachtung endet automatisch beim nächsten Skriptlauf.",
  },
  "nb.attachments.list": { detail: "() → Promise<KitAttachment[]>", info: "Gibt alle Anhänge dieses Notebooks zurück." },
  "nb.attachments.listInNote": {
    detail: "() → Promise<KitAttachment[]>",
    info: "Gibt nur Anhänge zurück, auf die der Inhalt der aktuellen Notiz über `attach://shortId` verweist.",
  },
  "nb.attachments.get": {
    detail: "(shortId) → Promise<KitAttachment | null>",
    info: "Ruft einen einzelnen Anhang über seine Kurz-ID ab.",
  },
  "nb.attachments.upload": {
    detail: "(file: File | Blob, filename?) → Promise<KitAttachment>",
    info: "Lädt eine Datei oder ein `Blob` hoch. Für ein `Blob` ist ein Dateiname erforderlich; bei `File` wird er übernommen.",
  },
  "nb.attachments.uploadFromPicker": {
    detail: "({ accept?, multiple? }?) → Promise<KitAttachment[]>",
    info: "Öffnet die Dateiauswahl des Browsers und lädt alle ausgewählten Dateien hoch.",
  },
  "nb.attachments.insertIntoContent": {
    detail: "(shortId) → Promise<void>",
    info: "Hängt `[filename](attach://shortId)` beziehungsweise für Bilder `![](…)` an die aktuelle Notiz an.",
  },
  "nb.attachments.remove": { detail: "(shortId) → Promise<void>", info: "Löscht einen Anhang dauerhaft." },
  "nb.tags.list": {
    detail: "() → Promise<KitTagSummary[]>",
    info: "Gibt alle Schlagwörter dieses Notebooks mit der Anzahl zugehöriger Notizen zurück.",
  },
  "nb.tags.notesForTag": {
    detail: "(tag) → Promise<KitNote[]>",
    info: "Findet alle Notizen des Notebooks, die auf das angegebene Schlagwort verweisen.",
  },
  "nb.localKV.get": { detail: "(key) → Promise<T | undefined>", info: "Liest asynchron aus dem persönlichen OPFS-Speicher." },
  "nb.localKV.set": {
    detail: "(key, value | updater) → Promise<void>",
    info: "Schreibt asynchron einen Wert oder verwendet eine Aktualisierungsfunktion, die den aktuellen Wert erhält.",
  },
  "nb.localKV.delete": { detail: "(key) → Promise<void>", info: "Entfernt einen Wert asynchron." },
  "nb.localKV.keys": { detail: "() → Promise<string[]>", info: "Gibt alle Schlüssel im Namensraum dieses Notebooks zurück." },
  "nb.localKV.observe": {
    detail: "(key, cb) → unsubscribe()",
    info: "Ruft `cb` bei jeder Änderung an `key` auf, sowohl im aktuellen als auch in anderen Browser-Tabs.",
  },
  "ui.prompt.alert": { detail: "(message, options?) → Promise<void>", info: "Zeigt einen Informationsdialog mit einer OK-Schaltfläche." },
  "ui.prompt.confirm": {
    detail: "(message, options?) → Promise<boolean>",
    info: "Zeigt einen Ja-Nein-Dialog. Ergibt bei Bestätigung `true` und bei Abbruch `false`.",
  },
  "ui.prompt.text": {
    detail: "(message, default?, options?) → Promise<string | null>",
    info: "Zeigt ein einzelnes Texteingabefeld und gibt bei Abbruch `null` zurück.",
  },
  "ui.prompt.form": {
    detail: "(spec) → Promise<values | null>",
    info: "Zeigt ein modales Formular mit mehreren Feldern. Feldtypen: `text` mit `multiline` und `lines`, `number`, `boolean` und `select`.",
  },
  "std.text.slugify": { detail: "(text) → string", info: "Erzeugt einen URL-tauglichen Slug." },
  "std.text.humanize": { detail: "(text) → string", info: "Wandelt etwa `humanize-string` in lesbaren Text wie `Humanize string` um." },
  "std.text.titleify": { detail: "(text) → string", info: "Schreibt Text als Titel." },
  "std.text.truncate": { detail: "(text, max) → string", info: "Kürzt Text auf die maximale Länge und ergänzt Auslassungspunkte." },
  "std.text.summarize": { detail: "(text, max) → string", info: "Entfernt Formatierungen und kürzt den verbleibenden Text." },
  "std.text.camelCase": { detail: "(text) → string", info: "Wandelt Text in `camelCase` um." },
  "std.text.snakeCase": { detail: "(text) → string", info: "Wandelt Text in `snake_case` um." },
  "std.text.kebabCase": { detail: "(text) → string", info: "Wandelt Text in `kebab-case` um." },
  "std.text.pascalCase": { detail: "(text) → string", info: "Wandelt Text in `PascalCase` um." },
  "std.text.pprintBytes": { detail: "(bytes) → string", info: "Formatiert eine Bytezahl lesbar, etwa als `1.23 MB`." },
  "std.dates.formatDate": { detail: "(date) → string", info: "Formatiert ein Datum passend zur aktiven Spracheinstellung." },
  "std.dates.formatDateTime": { detail: "(date) → string", info: "Formatiert Datum und Uhrzeit passend zur aktiven Spracheinstellung." },
  "std.dates.formatDateTimeRelative": {
    detail: "(date) → string",
    info: "Formatiert einen Zeitpunkt relativ, etwa als „vor 3 Minuten“.",
  },
  "std.dates.formatDuration": { detail: "(ms) → string", info: "Formatiert eine Dauer in Millisekunden als lesbaren Text." },
  "std.dates.getMonthGrid": { detail: "(date) → Date[][]", info: "Erzeugt ein Kalenderraster mit sechs Wochenzeilen." },
  "std.fuzzy.match": {
    detail: "(query, target) → number",
    info: "Bewertet die Ähnlichkeit; ein höherer Wert bedeutet eine bessere Übereinstimmung.",
  },
  "std.fuzzy.filter": {
    detail: "(query, items, getString?) → items[]",
    info: "Entfernt Nichttreffer und sortiert die übrigen Elemente nach ihrer Bewertung.",
  },
  "std.fuzzy.segments": {
    detail: "(query, target) → Segment[]",
    info: "Teilt Text zum Hervorheben in passende und nicht passende Abschnitte.",
  },
  "std.fuzzy.closest": {
    detail: "(input, choices) → string | null",
    info: "Korrigiert Tippfehler anhand der Bearbeitungsdistanz und gibt die ähnlichste Auswahl zurück.",
  },
  "std.fuzzy.distance": { detail: "(a, b) → number", info: "Berechnet die Levenshtein-Distanz zwischen zwei Texten." },
  "std.crypto.common": {
    detail: "Hash, UUID, IDs, Schlüssel",
    info: "Bietet `hash`, `fnv1aHash`, `uuid`, `readableId` und `generateKey`.",
  },
  "std.crypto.asymmetric": {
    detail: "ECDSA + ECDH+AES-GCM",
    info: "Erzeugt Schlüssel und bietet Signieren, Prüfen, Verschlüsseln und Entschlüsseln.",
  },
  "std.crypto.symmetric": { detail: "AES-GCM", info: "Verschlüsselt und entschlüsselt mit einem Passwort oder Schlüssel." },
  "std.crypto.totp": { detail: "Zwei-Faktor-Authentifizierung", info: "Erzeugt und prüft zeitbasierte Einmalpasswörter." },
  "std.encoding.toBase64": { detail: "(Uint8Array | string) → string", info: "Kodiert Bytes oder Text als Base64." },
  "std.encoding.fromBase64": { detail: "(string) → Uint8Array", info: "Dekodiert Base64 als Bytefolge." },
  "std.encoding.toHex": { detail: "(bytes) → string", info: "Kodiert Bytes als Hexadezimaltext." },
  "std.encoding.fromHex": { detail: "(string) → Uint8Array", info: "Dekodiert Hexadezimaltext als Bytefolge." },
  "std.encoding.toBase62": {
    detail: "(bigint | number) → string",
    info: "Kodiert eine Zahl als URL-tauglichen alphanumerischen Base62-Text.",
  },
  "std.encoding.fromBase62": { detail: "(string) → bigint", info: "Dekodiert Base62-Text als `bigint`." },
  "std.charts.scatter": { detail: "(data, options?) → string", info: "Erzeugt ein SVG-Streudiagramm." },
  "std.charts.line": { detail: "(data, options?) → string", info: "Erzeugt ein SVG-Liniendiagramm." },
  "std.charts.bar": { detail: "(data, options?) → string", info: "Erzeugt ein SVG-Balkendiagramm." },
  "std.charts.pie": { detail: "(data, options?) → string", info: "Erzeugt ein SVG-Kreisdiagramm." },
  "std.charts.donut": { detail: "(data, options?) → string", info: "Erzeugt ein SVG-Ringdiagramm." },
  "std.charts.histogram": { detail: "(data, options?) → string", info: "Erzeugt ein SVG-Histogramm." },
  "std.charts.boxplot": { detail: "(data, options?) → string", info: "Erzeugt ein SVG-Boxplot-Diagramm." },
  "std.charts.sparkline": {
    detail: "(data, options?) → string",
    info: "Erzeugt eine minimalistische SVG-Trendlinie für die Einbettung im Text.",
  },
  "std.qr.wifi": { detail: "({ ssid, password, security, hidden? }) → string", info: "Erzeugt die Nutzdaten für eine WLAN-Konfiguration." },
  "std.qr.email": { detail: "(email, opts?) → string", info: "Erzeugt `mailto`-Nutzdaten mit Empfänger, Betreff und Inhalt." },
  "std.qr.tel": { detail: "(phone) → string", info: "Erzeugt QR-Nutzdaten für eine Telefonnummer." },
  "std.qr.vcard": { detail: "(contact) → string", info: "Erzeugt einen Kontakt im Format vCard 3.0." },
  "std.qr.event": { detail: "(event) → string", info: "Erzeugt einen Kalendereintrag als iCalendar-`VEVENT`." },
  "std.qr.toSvg": { detail: "(payload, options?) → string", info: "Rendert beliebige QR-Nutzdaten als SVG-Text." },
  "std.password.random": { detail: "(length?, options?) → string", info: "Erzeugt ein kryptografisch zufälliges Passwort." },
  "std.password.memorable": {
    detail: "(wordCount?, options?) → string",
    info: "Erzeugt eine merkbare Passphrase aus der EFF-Wortliste, etwa `correct-horse-battery-staple`.",
  },
  "std.password.pin": { detail: "(length?) → string", info: "Erzeugt eine numerische PIN." },
  "std.password.strength": {
    detail: "(password) → { score, feedback }",
    info: "Bewertet ein Passwort von 0 bis 4 und liefert konkrete Verbesserungshinweise.",
  },
  "std.timing.sleep": { detail: "(ms) → Promise<void>", info: "Wartet asynchron die angegebene Anzahl Millisekunden." },
  "std.timing.debounce": {
    detail: "(fn, ms) → debounced",
    info: "Verzögert einen Funktionsaufruf, bis für die angegebene Dauer kein neuer Aufruf erfolgt.",
  },
  "std.timing.throttle": {
    detail: "(fn, ms) → throttled",
    info: "Begrenzt die Aufrufhäufigkeit einer Funktion auf das angegebene Zeitintervall.",
  },
  "std.timing.jitter": { detail: "(ms, ratio?) → number", info: "Ergänzt eine Dauer um eine zufällige Abweichung." },
  "std.timing.random": {
    detail: "(min?, max?, step?) → number",
    info: "Erzeugt eine Zufallszahl im angegebenen Bereich und optionalen Schrittmaß.",
  },
  "std.timing.shuffle": { detail: "(array) → array", info: "Mischt ein Array direkt mit dem Fisher-Yates-Verfahren." },
  "std.timing.withMinLoadTime": {
    detail: "(promise, ms) → Promise<T>",
    info: "Hält einen Ladezustand mindestens für die angegebene Dauer sichtbar und verhindert dadurch kurzes Flackern.",
  },
  "std.files.downloadFileFromContent": {
    detail: "(content, filename, mime?) → void",
    info: "Startet den Download des angegebenen Inhalts unter dem Dateinamen und optionalen MIME-Typ.",
  },
  "std.files.createZip": { detail: "(entries) → Promise<Blob>", info: "Erstellt aus den angegebenen Einträgen ein ZIP-Archiv als `Blob`." },
  "std.files.downloadAsZip": {
    detail: "(entries, filename) → Promise<void>",
    info: "Erstellt ein ZIP-Archiv aus den Einträgen und lädt es unter dem angegebenen Dateinamen herunter.",
  },
  "std.files.showFileDialog": {
    detail: "(opts?) → Promise<File[]>",
    info: "Öffnet die Dateiauswahl und gibt die ausgewählten Dateien zurück.",
  },
  "std.files.showFolderDialog": {
    detail: "() → Promise<FileSystemDirectoryHandle | null>",
    info: "Öffnet die Ordnerauswahl und gibt den gewählten Ordner oder bei Abbruch `null` zurück.",
  },
  "std.files.getMimeType": { detail: "(filename) → string | null", info: "Ermittelt den MIME-Typ aus einem Dateinamen." },
  "std.files.getExtension": { detail: "(mime) → string | null", info: "Ermittelt eine passende Dateiendung aus einem MIME-Typ." },
  "std.images.create": {
    detail: "(File | Blob | string) → Promise<ImgData>",
    info: "Beginnt eine Bildverarbeitungskette mit einer Datei, einem `Blob` oder Text.",
  },
  "std.images.resize": { detail: "(opts) → step", info: "Fügt der mit `.then` verketteten Verarbeitung eine Größenänderung hinzu." },
  "std.images.crop": { detail: "(opts) → step", info: "Fügt der Verarbeitung einen Bildausschnitt hinzu." },
  "std.images.filter": { detail: "(opts) → step", info: "Fügt der Verarbeitung Bildfilter wie Helligkeit hinzu." },
  "std.images.rotate": { detail: "(degrees) → step", info: "Fügt der Verarbeitung eine Drehung in Grad hinzu." },
  "std.images.flip": {
    detail: "('horizontal' | 'vertical') → step",
    info: "Fügt der Verarbeitung eine horizontale oder vertikale Spiegelung hinzu.",
  },
  "std.images.toBlob": {
    detail: "(opts?) → step → Promise<Blob>",
    info: "Schließt die Verarbeitung ab und gibt das Bild als `Blob` zurück.",
  },
  "std.images.toFile": {
    detail: "(filename, opts?) → step → Promise<File>",
    info: "Schließt die Verarbeitung ab und gibt das Bild als `File` zurück.",
  },
  "std.images.toBase64": {
    detail: "(opts?) → step → Promise<string>",
    info: "Schließt die Verarbeitung ab und gibt das Bild Base64-kodiert zurück.",
  },
  "std.images.toCanvas": {
    detail: "() → step → Promise<HTMLCanvasElement>",
    info: "Schließt die Verarbeitung ab und gibt das Bild als `HTMLCanvasElement` zurück.",
  },
  "std.images.batch": {
    detail: "(items, pipeline, onProgress?) → Promise<T[]>",
    info: "Verarbeitet mehrere Bilder mit derselben Verarbeitungskette und optionaler Fortschrittsmeldung.",
  },
  "std.images.presets": {
    detail: "{ avatar, thumbnail }",
    info: "Enthält vorbereitete Verarbeitungsketten für Avatare und Vorschaubilder.",
  },
  "std.clipboard.copy": { detail: "(text) → Promise<void>", info: "Kopiert Text in die Zwischenablage des Systems." },
};
