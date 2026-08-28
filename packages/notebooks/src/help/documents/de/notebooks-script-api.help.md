---
id: notebooks-script-api
title: "Skript-API"
icon: "ti ti-api"
description: "Vollständige Referenz für current, nb, ui, std, KV, Tags und Anhänge."
order: 160
---

Skriptblöcke stellen vier globale Namensräume bereit: `current`, `nb`, `ui` und `std`. Tippe in einem Skriptblock einen Namensraum und einen Punkt, um die Autovervollständigung zu verwenden.

**Skript-API**

## Laufzeitvertrag {icon="contract"}

:::reference
- **Keine Imports:** Skriptblöcke verwenden ausschließlich die bereitgestellten globalen Namensräume `current`, `nb`, `ui` und `std`.
- **Grenze des aktuellen Notizbuchs:** Die APIs unter `nb` sind auf das aktuelle Notizbuch begrenzt. Es gibt keinen Parameter, mit dem ein anderes Notizbuch gelesen werden kann.
- **Ressourcen-IDs:** IDs von Notizbüchern, Notizen, übergeordneten Notizen und Anhängen sind die sechsstelligen IDs aus URLs, APIs sowie `note://`- und `attach://`-Links.
- **Begrenzte Lesezugriffe:** Strukturierte Suchen verwenden standardmäßig `limit: 50` und erlauben höchstens 200 Ergebnisse. `search` kann große clientseitige Ergebnisse mit `__truncated` kennzeichnen.
:::

**Aktuelle Notiz**

## current {icon="file-text"}

### Aktuelle Metadaten

Lies die Eigenschaften der Notiz, die das Skript enthält.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `id` | `string` | `current.id` | Kurze Notiz-ID. |
| `title` | `string` | `current.title` | Titel der aktuellen Notiz. |
| `content` | `string` | `current.content` | Aktueller Markdown-Inhalt. |
| `tags` | `string[]` | `current.tags` | Aus dem aktuellen Inhalt gelesene Tags. |
| `notebook` | `{ id: string; name: string }` | `current.notebook` | Identität des aktuellen Notizbuchs; `id` ist die öffentliche kurze ID. |
| `createdAt` | `string` | `current.createdAt` | Zeitpunkt der Erstellung. |
| `updatedAt` | `string` | `current.updatedAt` | Zeitpunkt der letzten Aktualisierung. |
| `lockedAt` | `string \| null` | `current.lockedAt` | Zeitpunkt der Sperrung oder `null`, wenn die Notiz nicht gesperrt ist. |

### Änderungen an der aktuellen Notiz

Diese Methoden aktualisieren die Notiz, die das Skript enthält. Schreibmethoden sind APIs des Bearbeitungsmodus.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `setContent` | `void` | `await current.setContent(markdown)` | Ersetzt den gesamten Markdown-Inhalt. |
| `appendContent` | `void` | `await current.appendContent(markdown)` | Hängt Markdown an und erhält lesbare Absatzabstände. |
| `prependContent` | `void` | `await current.prependContent(markdown)` | Fügt Markdown am Anfang der Notiz ein. |
| `insertContentAt` | `void` | `await current.insertContentAt({ line, col? }, markdown)` | Fügt Markdown an einer nullbasierten Zeile und optionalen Spalte ein. |
| `replaceLine` | `void` | `await current.replaceLine(line, text)` | Ersetzt eine nullbasierte Zeile, ohne den übrigen Inhalt zu ändern. |

### Benannte Blöcke unter `current`

Methoden im Singular geben den ersten passenden benannten Block oder `undefined` zurück. Methoden im Plural geben Arrays zurück und können ohne Namen aufgerufen werden.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `table` | `table \| undefined` | `current.table("ideas")` | Liest oder aktualisiert eine benannte Markdown-Tabelle. Schreibbare Tabellenansichten unterstützen `add(...cells)`. |
| `tables` | `table[]` | `current.tables(name?)` | Listet benannte Tabellen auf. Ohne Namen werden alle Tabellenblöcke aufgelistet. |
| `list` | `list \| undefined` | `current.list("shopping")` | Liest oder aktualisiert eine benannte Aufzählung. Schreibbare Listenansichten unterstützen `add(...items)`. |
| `lists` | `list[]` | `current.lists(name?)` | Listet benannte Aufzählungen auf. |
| `todo` | `todo \| undefined` | `current.todo("tasks")` | Liest oder aktualisiert eine benannte Aufgabenliste. Aufgaben stellen `done`, `content` und `line` bereit. |
| `todos` | `todo[]` | `current.todos(name?)` | Listet benannte Aufgabenblöcke auf. |
| `data` | `data \| undefined` | `current.data("recipe")` | Liest oder ersetzt einen benannten Datenblock. Schreibbare Datenansichten unterstützen `set(object)`. |
| `dataBlocks` | `data[]` | `current.dataBlocks(name?)` | Listet benannte Datenblöcke auf. |
| `section` | `section \| undefined` | `current.section("log")` | Liest einen benannten Markdown-Abschnitt oder hängt Inhalt daran an. |
| `sections` | `section[]` | `current.sections(name?)` | Listet benannte Abschnitte auf. |

**Notizbuch-API**

## nb {icon="notebook"}

### Notizen unter `nb`

Suche und verwalte Notizen im aktuellen Notizbuch.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `list` | `note[]` | `await nb.list()` | Listet Notizen im aktuellen Notizbuch auf. |
| `get` | `note \| null` | `await nb.get(shortId)` | Ruft eine Notiz anhand ihrer kurzen ID ab. |
| `search` | `note[]` | `await nb.search(query)` | Sucht anhand einer Zeichenfolge oder strukturierten Abfrage. |
| `searchTags` | `note[]` | `await nb.searchTags(tagOrTags, options?)` | Findet Notizen, die alle angegebenen Tags enthalten. |
| `create` | `note` | `await nb.create({ parentId?, content? })` | Erstellt eine Notiz. Ihr Titel wird aus dem Inhalt abgeleitet; ohne Inhalt wird die Standardvorlage des Notizbuchs für Titel verwendet. |
| `update` | `note` | `await nb.update(shortId, { parentId })` | Verschiebt eine Notiz unter eine andere Notiz oder mit `null` auf die oberste Ebene. |
| `remove` | `void` | `await nb.remove(shortId)` | Entfernt eine Notiz anhand ihrer kurzen ID. |

### Anhänge unter `nb`

Lade Anhänge im aktuellen Notizbuch hoch, liste sie auf, füge sie ein oder entferne sie.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `list` | `attachment[]` | `await nb.attachments.list()` | Listet alle hochgeladenen Anhänge im Notizbuch auf. |
| `listInNote` | `attachment[]` | `await nb.attachments.listInNote()` | Listet Anhänge auf, auf die der Inhalt der aktuellen Notiz verweist. |
| `get` | `attachment \| null` | `await nb.attachments.get(shortId)` | Ruft einen Anhang anhand seiner kurzen ID ab. |
| `upload` | `attachment` | `await nb.attachments.upload(file, filename?)` | Lädt eine `File`- oder `Blob`-Datei hoch. Für `Blob`-Uploads ist ein Dateiname erforderlich. |
| `uploadFromPicker` | `attachment[]` | `await nb.attachments.uploadFromPicker({ accept?, multiple? })` | Öffnet die Dateiauswahl des Browsers und lädt die ausgewählten Dateien hoch. |
| `insertIntoContent` | `void` | `await nb.attachments.insertIntoContent(shortId)` | Hängt einen Markdown-Link oder eine Bildreferenz für den Anhang an die aktuelle Notiz an. |
| `remove` | `void` | `await nb.attachments.remove(shortId)` | Entfernt einen Anhang anhand seiner kurzen ID. |

### Tags unter `nb`

Lies den Tag-Index des Notizbuchs.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `list` | `{ tag: string; count: number }[]` | `await nb.tags.list()` | Listet alle im Notizbuch verwendeten Tags mit der Anzahl ihrer Notizen auf. |
| `notesForTag` | `note[]` | `await nb.tags.notesForTag(tag)` | Findet Notizen, die auf einen Tag verweisen. |

**KV**

## Zustands-APIs {icon="database"}

### `current.kv`

Gemeinsam bearbeiteter Zustand für die aktuelle Notiz. Aufrufe sind synchron und werden mit anderen Mitwirkenden geteilt.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `get` | `value \| undefined` | `current.kv.get("key")` | Liest einen Schlüssel. |
| `set` | `void` | `current.kv.set("key", valueOrUpdater)` | Setzt einen Schlüssel. Der Wert kann ein direkter Wert oder eine Aktualisierungsfunktion sein. |
| `delete` | `void` | `current.kv.delete("key")` | Löscht einen Schlüssel. |
| `keys` | `string[]` | `current.kv.keys()` | Listet Schlüssel alphabetisch sortiert auf. |
| `observe` | `() => void` | `current.kv.observe("key", callback)` | Abonniert Änderungen eines Schlüssels und gibt eine Funktion zum Beenden des Abonnements zurück. |

### `nb.localKV`

Privater Zustand pro Benutzer und Notizbuch. Aufrufe sind asynchron; die Daten werden lokal im Browser gespeichert.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `get` | `value \| undefined` | `await nb.localKV.get("key")` | Liest einen privaten Schlüssel. |
| `set` | `void` | `await nb.localKV.set("key", valueOrUpdater)` | Setzt einen privaten Schlüssel. |
| `delete` | `void` | `await nb.localKV.delete("key")` | Löscht einen privaten Schlüssel. |
| `keys` | `string[]` | `await nb.localKV.keys()` | Listet private Schlüssel für diesen Notizbuch-Namensraum auf. |
| `observe` | `() => void` | `nb.localKV.observe("key", callback)` | Abonniert Änderungen im selben und in anderen Tabs für einen Schlüssel. |

**Darstellung und Interaktion**

## ui {icon="layout-dashboard"}

### Layout und Inhalt unter `ui`

Erzeuge sichtbare Ausgaben für den Skriptblock.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `row` | `element` | `ui.row(...children)` | Horizontale Flex-Zeile. Inhalte werden umgebrochen, wenn der Platz nicht ausreicht. |
| `col` | `element` | `ui.col(...children)` | Vertikale Flex-Spalte. |
| `card` | `element` | `ui.card(...children)` | Visuell abgegrenzte Gruppe mit Innenabstand für zusammengehörige Inhalte. |
| `metric` | `element` | `ui.metric(label, value, options?)` | Kompakte Kennzahlenkarte für Dashboards. |
| `divider` | `element` | `ui.divider()` | Horizontale Trennlinie. |
| `text` | `element` | `ui.text(content)` | Unformatierter Absatztext. |
| `heading` | `element` | `ui.heading(content, level?)` | Überschrift der Ebene 1 bis 6. Standard ist Ebene 2. |
| `md` | `element` | `ui.md(markdown)` | Rendert Markdown mit derselben Engine wie der Lesemodus. |
| `html` | `element` | `ui.html(rawHtml)` | Schnittstelle für vertrauenswürdige Skripte. Die Zeichenfolge wird als rohes HTML gesetzt. |

### Datenansichten unter `ui`

Stelle Notizbuchdaten als Links, Tabellen und Diagramme dar.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `noteLink` | `element` | `ui.noteLink(noteOrShortId, label?)` | Rendert einen anklickbaren Link zu einer Notiz. |
| `noteList` | `element` | `ui.noteList(notes, options?)` | Rendert Notizen als kompakte Liste von Notiz-Links. |
| `table` | `element` | `ui.table(rowsOrTable, options?)` | Rendert Zeilen oder eine `KitTableView` mit der Tabellenansicht des Notizbuchs. |
| `chart` | `element` | `ui.chart(kind, options)` | Rendert ein stdlib-SVG-Diagramm. Die Breite wird am Container gemessen; die Höhe kann festgelegt werden. |

### Aktionen und Einbinden unter `ui`

Verknüpfe Aktionen und binde Ausgaben ein.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `button` | `element` | `ui.button(label, onClick, options?)` | Rendert eine Schaltfläche. Asynchrone Fehler werden abgefangen und direkt angezeigt. |
| `toast` | `void` | `ui.toast(description, options?)` | Zeigt eine Plattform-Benachrichtigung an. Sie wird nicht in die Skriptausgabe eingebunden. |
| `live` | `element` | `ui.live(render)` | Rendert einen kleinen reaktiven Bereich. Im Bearbeitungsmodus wird er erneut ausgeführt, wenn sich der Inhalt der aktuellen Notiz ändert. |
| `render` | `void` | `ui.render(...elements)` | Bindet ein oder mehrere Elemente in die Skriptausgabe ein. |
| `show` | `void` | `element.show()` | Jedes `ui`-Element kann sich selbst in die Skriptausgabe einbinden. |

### `ui.prompt`

Öffne Plattform-Dialoge aus einem Skript.

| API | Rückgabe | Beispiel | Funktion |
| --- | --- | --- | --- |
| `alert` | `void` | `await ui.prompt.alert(message, options?)` | Zeigt einen Informationsdialog an. |
| `confirm` | `boolean` | `await ui.prompt.confirm(message, options?)` | Zeigt einen Bestätigungsdialog an. |
| `text` | `string \| null` | `await ui.prompt.text(message, defaultValue?, options?)` | Fragt einen Textwert ab. |
| `form` | `object \| null` | `await ui.prompt.form(spec)` | Fragt mehrere Werte ab. Felder unterstützen `text`, `textarea`, `number`, `boolean` und `select`. |

**Ausgewählte stdlib-APIs**

## std {icon="library"}

:::reference
- **std.text:** Textfunktionen wie `slugify`, `humanize`, `truncate`, Groß-/Kleinschreibung und `pprintBytes`.
- **std.dates:** Formatierung von Datum und Uhrzeit sowie Kalenderfunktionen.
- **std.fuzzy:** Funktionen für unscharfe Suche und Tippfehlerkorrektur.
- **std.crypto:** Hashing, UUIDs und lesbare IDs, asymmetrische und symmetrische Kryptografie sowie TOTP-Funktionen.
- **std.encoding:** Konvertierungen von Base64-, Hex- und Base62-Zeichenfolgen.
- **std.charts:** Basisgeneratoren für SVG-Diagramme. Verwende für eingebundene Ausgaben bevorzugt `ui.chart`.
- **std.qr:** Generatoren für QR-Codes und SVG-Darstellung.
- **std.password:** Passwortgeneratoren und Analyse der Passwortstärke.
- **std.timing:** Asynchrone Zeitfunktionen wie `sleep`, `debounce`, `throttle`, `jitter` und `withMinLoadTime`.
- **std.files:** Dateidownloads im Browser, ZIP-Archive, Datei- und Ordnerauswahl sowie MIME-Funktionen.
- **std.images:** Funktionen für die Verarbeitung von Bildern im Browser.
- **std.clipboard:** Skript-Schnittstelle für die Zwischenablage mit `copy(text)`.
:::
