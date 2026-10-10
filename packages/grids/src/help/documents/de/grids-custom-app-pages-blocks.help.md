---
id: grids-custom-app-pages-blocks
title: Seiten und Blöcke in Grids Apps
icon: ti ti-layout-grid
description: Setze responsive Seiten aus typisierten Blöcken zusammen, die vorhandene Ressourcen verwenden.
order: 134
---
Eine Grids App ordnet vorhandene Ressourcen auf Seiten an. Ihre Blöcke legen fest, welche Ressourcen erscheinen und welche definierten Vorgänge eine Person starten kann.

## Seiten und Layout einrichten {icon="layout-grid"}

Verwende für Links stabile IDs, keine Bezeichnungen. Eine Seiten-URL lautet `/apps/<id>/<pageId>`. Deklarierte Record-Parameter stehen im Query-String. Die [Custom-App-API-Referenz](/app/grids/help/grids-custom-app-api) nennt die ID-Regeln, die Layoutgrenzen und alle Bindungen.

Diese Version unterstützt nur erforderliche Record-Parameter. Jeder Parameter deklariert eine Tabelle derselben Base. Seine URL und sein Wert `@params.<name>` sind öffentliche Datensatz-IDs.

Wähle unter **Routenparameter** eine Parameter-ID und ihre Tabelle. Fügst du einen Datensatz- oder Gerendertes-HTML-Block hinzu, bindet er diesen Parameter automatisch. Eine reine Routenseite kann den autorisierten Parameter auch in GQL oder in festen Formularwerten nutzen, ohne den Datensatz anzuzeigen. Seiten mit Pflichtparametern erscheinen nicht in der Navigation und können nicht die Startseite sein. Fehlende oder unzugängliche Datensätze zeigen den einheitlichen Zustand für nicht Verfügbares.

Seiten enthalten Zeilen, Spalten und Blöcke. Nutze Breite 12 für eine Aufgabe, 8 + 4 für Hauptinhalt und Kontext und 6 + 6 für gleichrangige Inhalte. Auf schmalen Bildschirmen stehen Spalten in derselben Reihenfolge untereinander. Prüfe beide Breiten vor dem Veröffentlichen. Ein eigenes mobiles Layout brauchst du nicht.

Setze die nächste Aktion neben die Informationen, die sie braucht. Nutze einen Dialog für eine kurze Aufgabe, die eine Schaltfläche öffnet. Lass ein Formular eingebettet, wenn Personen darin zusammen mit dem Kontext der Seite arbeiten.

Für ergänzende Informationen kannst du jedem Block `disclosure: { label: "Weitere Angaben" }` geben. Personen öffnen die Überschrift, um den Inhalt zu sehen. Mit `defaultOpen: true` startet er aufgeklappt. Im Builder konfigurierst du das unter **Aufklappbarer Inhalt**. Das Einklappen verzögert das Laden nicht und ändert keinen Zugriff. Nutze `availableWhen`, um die Verfügbarkeit zu steuern.

## Blöcke konfigurieren {icon="blocks"}

### Markdown

Markdown zeigt Überschriften, Listen, Links und sichere Bilder. Es führt weder Skripte noch eingebetteten Code aus. Der Inline- und der große Editor vervollständigen die Platzhalter `@auth`, `@params`, `@page`, `@app`, `@base` und `@time` der aktuellen Seite. `Hello @auth.name` fügt zum Beispiel auf dem Server den Anzeigenamen der angemeldeten Person ein. Anonyme Authentifizierungswerte werden zu leerem Text. Grids maskiert eingefügte Werte, bevor es das Markdown rendert. Liquid-Bedingungen oder -Schleifen gibt es nicht.

Nutze in einer veröffentlichten App Hinweisboxen der Cloud für kurze Erklärungen oder Warnungen. Füge sie in einen gewöhnlichen Markdown-Block ein. Ein eigener Blocktyp ist nicht nötig:

```markdown
:::info Zahlungen bestätigen
Gleiche die Einträge mit deinen Bankumsätzen ab. Erst bestätigte Zahlungen ändern den offenen Betrag.
:::
```

Unterstützte Varianten sind `note`, `info`, `success`, `warning` und `danger`. Schreibe den Titel nach der Variante, in der Sprache der App. Der Server bereinigt veröffentlichtes Markdown und entfernt Skripte und unsichere Links. Der Editor behält den Markdown-Quelltext und die Hervorhebung der Kontextplatzhalter.

### Datensätze

Datensätze liest eine vorhandene gespeicherte Ansicht oder eine Inline-GQL-Abfrage.

- Eine gespeicherte Ansicht kann eine ausdrückliche Auswahl von Tabellenfeldern verwenden oder die Kartenkonfiguration dieser Ansicht samt Dateicover wiederverwenden.
- Karten können schreibgeschützt sein, zu einer Zeilenseite navigieren oder Zeilenaktionen anbieten. Die Veröffentlichung schreibt sie mit der gespeicherten Ansicht fest.
- Inline-GQL zeigt die ausgewählten gewöhnlichen Datensatzspalten einschließlich Aliassen. Eine nichtleere Tabellenliste `columnIds` kann ausgewählte Feldspalten für das Verhalten verfügbar halten und zeigt nur die aufgeführten Feld-IDs.
- Nutze Kennzahlen oder Diagramm für Aggregatergebnisse.

Beide Quellen unterstützen einen Leertext, optionale Zeilennavigation und optionale serverseitige Suche. Ein leeres Tabellenergebnis zeigt Blocktitel und Leertext direkt an. Eine erfolglose Suche behält Tabelle und Suchfeld, damit Personen die Suche ändern können. Lade- und Fehlerzustände bleiben von einem leeren Ergebnis unterscheidbar.

In der Tabellendarstellung ergänzt `display.relativeDateColumnIds` neben dem absoluten Datum „heute“, „morgen“ oder einen Abstand in Kalendertagen. Das geht nur bei reinen Datumsspalten. Die Angaben verwenden die konfigurierte Zeitzone. Sie markieren einen Eintrag nicht als überfällig.

Mit `display.mobile: { titleColumnId, detailColumnIds }` wählst du für schmale Bildschirme eine Überschrift und ergänzende Werte pro Zeile. Breitere Bildschirme behalten die Tabelle. Beide Darstellungen verwenden dieselben Zeilenlinks, Workflow-Aktionen, Suche und Seitennavigation. Diese Verweise müssen auf sichtbare Spalten zeigen: öffentliche Feld-IDs bei einer gespeicherten Ansicht, eindeutige Spaltenbeschriftungen aus der Abfragevorschau bei GQL. Jeder Verweis darf in seiner Datumsliste oder mobilen Konfiguration nur einmal vorkommen.

`pageSize` legt fest, wie viele Zeilen der Server auf einmal liefert. Personen bewegen sich durch geschützte Cursor-Seiten. Suche und Seitennavigation laufen auf dem Server und laden nie das ganze Ergebnis in den Browser. Ein GQL-`limit` begrenzt das ganze Ergebnis, wenn die erstellende Person nur die ersten N passenden Zeilen will. Gemeinsame Abfragebudgets gelten unabhängig davon.

Eine Inline-Abfrage erhält automatisch den typisierten Kontext `@auth.id`, `@auth.name`, `@auth.username`, `@auth.email`, `@auth.subjects`, `@params`, `@page`, `@app`, `@base` und `@time`. `@auth.subjects` enthält die UUID der angemeldeten Person und die UUIDs ihrer wirksamen Gruppen. Für anonyme Personen ist die Liste leer. Grids bindet die Werte getrennt vom Abfragetext. Unbekannte Namensräume und nicht deklarierte Seitenparameter verhindern die Veröffentlichung.

Nutze `ROW.id` nur für den Zeilenlink oder die Workflow-Zeilenaktionen dieses Datensatzblocks. Ein Zeilenlink kann stattdessen `{ source: ROW, path: relation, fieldId: ... }` binden, wenn das Feld eine ausgewählte Einfachrelation zur Tabelle des Zielparameters ist. Bevor ihr Workflow startet, prüft Grids eine Zeilenaktion erneut gegen das exakte veröffentlichte Abfrageergebnis. Konfiguriere bis zu sechs Aktionen, jede mit einer zugänglichen Pflichtbeschriftung und einem optionalen Symbol. Tabellen und Karten können Beschriftung, Symbol oder beides zeigen.

### Referenzierte Datensätze

Referenzierte Datensätze ist nur auf einer Datensatzseite verfügbar. Der Block zeigt Zeilen aus einer festgelegten Quelltabelle, deren festgelegtes Relationsfeld den aktuellen Seitendatensatz enthält. Wähle im Block die genau angezeigten Felder, Tabellen- oder Kartendarstellung, Suche, Seitengröße und optionale Zeilenworkflows. Die Veröffentlichung kompiliert das in dieselbe begrenzte GQL- und `recordQueries`-Capability wie bei Datensätze. Der Zugriff auf die App bleibt die äußere Grenze. Der Block erweitert den Seitendatensatz nicht und bietet keine uneingeschränkte Rückwärtssuche.

### Kennzahlen und Diagramm

Kennzahlen und Diagramm lesen eine vorhandene gespeicherte Ansicht oder eine Inline-GQL-Abfrage. Die Laufzeit wendet gemeinsame Abfragebudgets an.

Kennzahlen übernehmen das Zahlenformat normalerweise von den ausgewählten Feldern. Für Aggregatausdrücke ohne Feldinformationen setze ein gemeinsames `valueFormat`, etwa `{ style: "number", decimalPlaces: 2, unit: "EUR" }`. Diese Vorgabe gilt für jeden Wert des Blocks. Grids leitet keine Währung aus der Abfrage ab. Das Format ändert nur die Anzeige und behält die exakten berechneten Werte.

- Kennzahlen akzeptiert eine nicht gruppierte Aggregatabfrage und zeigt bis zu 12 benannte skalare Ergebnisse.
- Diagramm akzeptiert eine gruppierte Aggregatabfrage und zeigt ein Ring-, Balken- oder Liniendiagramm mit mindestens einer Reihe von Aggregatwerten. Ein Diagrammblock zeigt über sein `limit` höchstens 100 Gruppen.

Balken- und Liniendiagramme zeigen die optionalen Beschriftungen der X- und Y-Achse. Ringdiagramme ignorieren sie. Kategorienamen und Achsenbeschriftungen, die neben oder unter dem Diagramm keinen Platz finden, werden gekürzt. Zeige mit der Maus darauf, um sie vollständig zu sehen. Bei mehr als 12 Gruppen zeigt das Diagramm höchstens 12 gleichmäßig verteilte Namen.

Die veröffentlichte Capability hält die genauen Tabellen und Felder hinter dem Block fest. Personen, die die App verwenden, brauchen keinen Zugriff auf die Base. Die Laufzeit kann keine Quellen außerhalb dieser unveränderlichen Capability abfragen. Veröffentliche erneut, nachdem du die Quelle einer gespeicherten Ansicht geändert hast.

### Formular

Das Formular bestimmt Eingaben, Validierung, Standardwerte und das Erstellen. Personen, die die App verwenden, können verknüpfte Datensätze ohne Zugriff auf die Base wählen. Die Suche zeigt nur IDs und die veröffentlichten Anzeigebezeichnungen des konfigurierten Ziels. Änderungen an diesen Bezeichnungen oder an ihren Formelabhängigkeiten erfordern eine neue Veröffentlichung.

Ein Formular ist standardmäßig eingebettet. Setze `presentation.kind` auf `dialog` und wähle eine Schaltflächenbeschriftung, um es über der aktuellen Seite zu öffnen. Dieselben Standardwerte, festen Werte, Validierungen und Zugriffsregeln gelten. Personen müssen bestätigen, bevor sie ungespeicherte Eingaben verwerfen. Während des Speicherns lässt sich der Dialog nicht schließen.

Dialog-Schaltflächen sind so breit wie ihr Inhalt. Wähle `presentation.variant: primary` für die wichtigste nächste Aktion oder `secondary` (Standard) für eine ergänzende Aktion.

Dieses Beispiel öffnet auf einer Seite mit einer Rechnung ein Zahlungsformular, dem die Rechnung bereits zugewiesen ist. Ersetze die Beispiel-IDs durch die IDs deines Formulars und Relationsfelds:

```yaml
id: record-payment
type: form
formId: PayFrm
presentation:
  kind: dialog
  label: Zahlung erfassen
  icon: plus
  variant: primary
fixedValues:
  BillFk:
    source: RECORD
    path: id
```

Wähle **Formularaktion → Datensatz dieser Seite bearbeiten**, um einen vorhandenen Entwurf zu bearbeiten. Die Seite muss einen Datensatz aus der Tabelle des Formulars binden. Der Server lädt Eingaben und konfigurierte zugehörige Zeilen vor der Darstellung. Beim Speichern prüft er die Versionen des übergeordneten Datensatzes und der bearbeiteten Zeilen gemeinsam. Das Entfernen einer zugehörigen Zeile löst sie vom übergeordneten Datensatz. Den zugrunde liegenden Datensatz löscht es nicht. Gemeinsam genutzte Zeilen und finalisierte Datensätze lassen sich so nicht bearbeiten. Verknüpfte Tabellen müssen zur selben Base gehören. Bestehende Formularblöcke erstellen weiter neue Datensätze, bis du diese Aktion änderst und die App erneut veröffentlichst.

Der Block kann vertrauenswürdige Werte für jedes Eingabefeld liefern:

- Nutze `LITERAL` für einen validierten festen Wert.
- Kompatible Relationsfelder können einen deklarierten Record-Wert aus `PARAMS` oder `RECORD.id` der aktuellen Seite verwenden.
- Ein Principal-Feld kann mit `AUTH.currentUser` die angemeldete Person zuweisen, ohne eine weitere Auswahl zu zeigen.

Gelieferte Eingaben fehlen im dargestellten Formular. Der Server ermittelt sie erneut, und der Browser kann sie nicht überschreiben. So funktionieren Abläufe wie „weiteren Artikel zu dieser Liste hinzufügen“, ohne erneut nach derselben Relation zu fragen.

Formulare, die über `actionsBlockId` mit Aktionen für den gespeicherten Zustand verbunden sind, müssen eingebettet bleiben, damit der Workflow-Status sichtbar bleibt. Die Dialogdarstellung können sie nicht verwenden.

Nach erfolgreichem Absenden kann ein eingebettetes Formular auf der Seite bleiben. Ein Dialog schließt sich und aktualisiert die Seite, die ihn geöffnet hat. Ein ausdrückliches `onSuccessNavigate` hat Vorrang und navigiert innerhalb derselben App, wobei es den Verlaufseintrag ersetzt. Navigationsparameter können deklarierte `PARAMS`-Werte behalten oder `RESULT.recordId` des erstellten Formulardatensatzes verwenden.

Eine App kann bis zu 24 Formularblöcke veröffentlichen. Jedes referenzierte Formular kann bis zu 100 Eingaben bereitstellen. Die Seite kann bis zu 30 davon vorgeben.

#### Ein Formular mit Kontext zeigen

Ein über `actionsBlockId` verbundenes Formular zeigt seine Eingaben neben der aktuellen Zusammenfassung und den nächsten Aktionen. Beide verwenden denselben Entwurf. Das letzte konfigurierte berechnete Feld erscheint zuerst als hervorgehobener Wert. Fehlende Eingaben kannst du direkt anspringen. Primäre Aktionen bleiben gesperrt, bis die Eingaben gültig und gespeichert sind. Das Speichern lädt den bestätigten Datensatz neu. Die serverseitigen Prüfungen bleiben maßgeblich.

Das optionale Objekt `workspace` akzeptiert `summaryTitle`, `summaryDescription`, `helpTitle` und `helpText`. Lege selten benötigtes Hintergrundwissen in den Hilfebereich. Diese Option braucht einen Aktionsblock und ist in einem Dialog nicht verfügbar.

Eine Datensatzüberschrift kann `heading.title` verwenden, solange der Datensatz bearbeitbar ist. Ihr Überschriftsfeld wird dann zum Untertitel. Eine ausgestellte Belegnummer hat Vorrang. Finalisierte Datensätze verwenden nie die Entwurfsüberschrift.

### Datensatz

Datensatz braucht einen Seitendatensatz. Der Block zeigt die ausdrückliche Liste `fieldIds`. Er kann die direkte Bearbeitung über eine ausdrückliche Teilmenge `editableFieldIds` erlauben. Jedes bearbeitbare Feld muss auch angezeigt werden und ein beschreibbares gespeichertes Feld sein. Berechnete Felder und Systemfelder verhindern die Veröffentlichung.

Wähle ein Layout:

- `grid` (Standard);
- `rows` für Paare aus Bezeichnung und Wert;
- `compact` für kurze Metadaten;
- `summary` für Summen: Werte stehen rechtsbündig, und die letzte Zeile ist hervorgehoben. Setze die Gesamtsumme an die letzte Stelle von `fieldIds`;
- `context` für einen kompakten verknüpften Datensatz, etwa den ursprünglichen Beleg.

Schreibgeschützte Objektlisten erscheinen als gerahmte Tabelle mit abgerundeten Ecken im Block. Feldname und Zeilenanzahl teilen sich ihre Kopfzeile. Ergänzende Spalten stehen unter weiteren Angaben. Längere Listen werden in Seiten unterteilt.

Füge eine Teilmenge der angezeigten Feld-IDs zu `relativeDates` hinzu, um reine Datumswerte zu ergänzen, etwa `17.09.2026 (heute)`. Der absolute Wert bleibt sichtbar. Felder mit Uhrzeit werden nicht unterstützt. Doppelte Felder oder Felder außerhalb von `fieldIds` scheitern bei der Validierung.

Mit `heading: { fieldId }` kennzeichnest du einen Datensatz mit einem seiner angezeigten Felder, etwa Kunde oder Betreff. Das Feld wandert in die Überschrift und erscheint nicht doppelt. Mit `heading: { fieldId, documentNumber: true }` und einer `documents`-Vorlagenliste wird eine vorhandene Belegnummer zur Überschrift, und das Feld bleibt darunter sichtbar. Entwürfe behalten ihre Feldüberschrift, außer `heading.title` liefert eine Aufgabenüberschrift. Dokument-Downloads bleiben als beschriftete Schaltflächen sichtbar.

Die Aktion Bearbeiten erscheint nur, wenn die Veröffentlichung dieses beschreibbare Feld enthält und der Block verfügbar ist. Beim Absenden prüft Grids diese Punkte erneut: Zugriff auf die App, unveränderliche Erlaubnisliste der Felder, `availableWhen`, aktuellen Feldtyp, Audit-Fragen der Tabelle und aktuelle Datensatzversion. Felder außerhalb der bearbeitbaren Teilmenge des Blocks bleiben schreibgeschützt.

Ein bearbeitbares Dateifeld verwendet denselben auditierten Lebenszyklus wie der Arbeitsbereich der Base: Hinzufügen, atomares Ersetzen und **Aus Datensatz entfernen**. Der Zugriff auf die App bleibt die äußere Grenze. Die veröffentlichte Capability für bearbeitbare Felder grenzt ihn weiter ein. Das Entfernen löst den aktuellen Anhang. Geschützter Verlauf oder Artefakte können die exakten Bytes behalten. Ungeschützte Dateien kann Grids bereinigen.

`documents.templateIds` zeigt verknüpfte Dokumente aus Vorlagen, die zur Tabelle des Seitendatensatzes gehören. Downloads sind geschützt. Das Ausstellen erfordert einen Workflow. Optionale Entwurfsvorschauen müssen ausdrücklich aktiviert sein: siehe [Custom-App-API-Referenz](/app/grids/help/grids-custom-app-api). Dieser Block erstellt keine öffentlichen Links.

### Gerendertes HTML

Gerendertes HTML braucht einen Seitendatensatz und verweist auf genau ein Feld vom Typ `html_template` aus dessen Tabelle. Der Block zeigt den bereits gerenderten Wert des Felds und legt keine anderen Felder des Datensatzes offen. Wähle die Höhe `compact`, `normal` oder `large`. Der Iframe passt seine Größe nicht an den Vorlageninhalt an.

Die Ausgabe läuft in einer Sandbox ohne Skripte, Formulare, Pop-ups, Zugriff auf die übergeordnete Seite oder Zeigerinteraktion. Eine Inhaltsrichtlinie, die standardmäßig alles verweigert, blockiert zusätzlich externe Bilder, Schriftarten, Medien, Frames, Verbindungen und Navigation. Nur Inline-Stile und `data:`-Bilder funktionieren. Nutze für Interaktionen einen Datensatz-, Formular- oder Aktionsblock. Ändert sich der Feldtyp, wird das Feld entfernt oder scheitert das Rendern der Vorlage, zeigt der Block einen lokalen Zustand für nicht Verfügbares. Er fällt in der App-Seite nie auf rohes HTML zurück.

### Kommentare

Kommentare braucht einen Seitendatensatz und eine angemeldete Person, die die App verwendet. Der Block lädt eine begrenzte erste Seite erst, wenn er gerendert wird. Danach lädt er ältere Kommentare mit Keyset-Seitennavigation. Der veröffentlichte Kommentarblock und der aktuelle Zugriff auf die App erlauben das Erstellen von Kommentaren ohne Zugriff **Bearbeiten** auf Base oder Datensatz. Verfassende Personen können ihre eigenen Kommentare bearbeiten und löschen. Personen mit Zugriff **Verwalten** auf die Base können jeden Kommentar moderieren. Gelöschte Kommentare bleiben als Platzhalter mit Zeitstempel, damit die Reihenfolge des Gesprächs verständlich bleibt.

Kommentare übernehmen die Sichtbarkeit des Datensatzes. Sie führen keine eigene Zielgruppe und keinen eigenen Zugriffsspeicher ein.

### Aktionen

Aktionen enthält Schaltflächen, die innerhalb derselben Grids App navigieren oder einen vorhandenen aktivierten Workflow-Launcher für Grids Apps starten. Eine Workflow-Aktion kann JSON-Werte aus `LITERAL`, deklarierte Record-Werte aus `PARAMS` oder `RECORD.id` der aktuellen Seite an kompatible Workflow-Eingaben binden. Feste Launcher verwenden ihre gespeicherten Bindungen und akzeptieren keine Aktionseingaben.

Wähle für eine kurze Aufgabe **Im Dialog abfragen**, um ungebundene skalare Eingaben abzufragen. Der Dialog verwendet Beschriftungen und Validierung des Workflows, sendet einmal ab und aktualisiert nach Erfolg die Seite. Lass den aktuellen Datensatz vom Server binden. Prüfe nach einer unklaren Antwort denselben Vorgang erneut. Sende keinen neuen ab. Optionale Hinweise und eine Erfolgsmeldung beschreiben die Aufgabe in den Worten der Person.

Der Block kann keine beliebigen URLs aufrufen, keine Datensätze direkt ändern und keinen Workflow ausführen, den die veröffentlichte Capability-Menge nicht enthält.

Das Starten eines Workflows läuft asynchron. Die Schaltfläche verfolgt ihren eigenen Lauf und zeigt bei Erfolg oder Fehler die bereinigte Ergebnismeldung des Workflows. Sie legt nie den allgemeinen Workflow-Verlauf oder rohe Fehler offen. Navigation nach einem Workflow gehört in den Workflow oder in eine spätere Änderung des Seitenzustands. Aktionen bindet keine beliebigen Workflow-Ergebnisse.

Die Laufzeit validiert erneut den veröffentlichten Zugriff auf die App, die exakte Seite, den Block, die Aktion, den Launcher, die Workflow-Revision, die Seitendatensätze und die `availableWhen`-Abfrage. Eine Aktion, die in der unveränderlichen Capability-Menge der Veröffentlichung fehlt, lässt Grids weg. Workflow-Aktionen erfordern ein angemeldetes Konto.

#### Dokumente im Hintergrund erstellen

Setze `background` einer Workflow-Aktion auf `{ acceptedMessage, documentBlockId, documentTemplateId }`, um ein Dokument aus dem Seitendatensatz zu erstellen. Der referenzierte Datensatzblock muss diese Vorlage ohne Verfügbarkeitsbedingung zeigen. Eine Seite mit Hintergrunddokument hat eine Ergebnisvorlage. Mehrere Aktionen können sie erstellen. Nach der Annahme erscheint die konfigurierte Nachricht, und die Person kann weiterarbeiten.

Die Aktion stellt ihren Status nach Navigation oder Neuladen wieder her. Sie öffnet die gespeicherte Datei, sobald sie bereit ist. Zeigt ein berechtigter, sichtbarer Datensatzblock bereits genau dieses fertige Dokument, lässt Grids die doppelte Abschlussaktion weg. Sonst bleibt die Aktion verfügbar.

Gleichzeitige Anfragen für dieselbe veröffentlichte Aktion mit denselben Seitendatensätzen und Eingaben schließen sich dem laufenden Lauf an. Das gilt auch für Anfragen einer anderen berechtigten Person, die die App verwendet. Personen sehen den Dokumentstatus, nicht die Workflow-Eingaben, Ausgaben oder rohen Fehler anderer Personen. Muss die Administration den Lauf prüfen, ist kein neuer Start möglich.

Ein Datensätze-Block in Tabellendarstellung mit `workflowStatus: true` zeigt diese Zustände neben seinen Zeilen. Er braucht eine direkte `ROW.id`-Navigation zur bedingungslos verfügbaren Datensatzseite des Dokuments. Die Liste bleibt seitenweise und durchsuchbar. Die Laufzeit aktualisiert sichtbare laufende Einträge. Sie wartet nicht auf den Abschluss, bevor sie die Seite zeigt.

### Scanner

Scanner bettet eine vorhandene aktivierte Scanner-Ausführungsoption ein. Angemeldete Personen, die die App verwenden, können mit der Kamera scannen oder einen Code manuell eingeben. Öffentliche anonyme Personen sehen stattdessen eine Aufforderung zur Anmeldung. Der Scanner fragt Sitzungswerte einmal beim Öffnen ab und Werte nach dem Scan für jeden Code.

Die App veröffentlicht den exakten Block, den Launcher, die Workflow-Revision und den Hash der Scanner-Konfiguration. Jeder Aufruf und jedes Lesen des Status prüft diesen Snapshot und den Zugriff der Person auf die App erneut. Eine Änderung der Ausführungsoption oder des Workflows erfordert eine neue Veröffentlichung der App. Ergebnisse von Scanner-Läufen sieht nur die Person, die sie gestartet hat.

Scannerblöcke unterstützen skalare Sitzungs- und Nach-dem-Scan-Eingaben. Abfragen von Datensätzen und Datensatzlisten bleiben im vollständigen Workflow-Scanner verfügbar. Ein eingebetteter App-Scanner lehnt sie ab, weil eine Person, die die App verwendet, den Zugriff auf die Base für eine Datensatzauswahl nicht haben muss. Die gescannte Eingabe selbst kann weiterhin über einen erzeugten Scan-Code oder ein konfiguriertes eindeutiges Feld zu einem Datensatz führen.

## Navigation ausdrücklich festlegen {icon="arrow-right"}

Nutze zwischen Seiten normale Push-Navigation und nach erfolgreichem Absenden eines Formulars ersetzende Navigation. Jeder Zielparameter braucht eine kompatible Bindung. Behalte für wiederholte Eingaben den übergeordneten Datensatz in einem deklarierten Seitenparameter und binde die Relation des Formulars daran.

Die [Custom-App-API-Referenz](/app/grids/help/grids-custom-app-api) nennt die genauen Formen für Navigations- und Erfolgsbindungen.

## Verfügbarkeit mit GQL durchsetzen {icon="adjustments"}

Eine Seite, ein Block, ein Formular oder eine Aktion kann eine `availableWhen.query` deklarieren. Der Server liefert denselben impliziten Kontext wie bei Datenabfragen. Die Ressource ist nur verfügbar, wenn die begrenzte Abfrage mindestens eine Zeile liefert.

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

Ein leeres Ergebnis oder ein Abfragefehler blendet die Ressource und ihre Datenquelle aus. Absenden, Aufruf und Workflow-Auswirkungen prüfen Bedingungen, Zugriff, Launcher und Veröffentlichung erneut. `atomicRecords` prüft einmal, nachdem es seine Sperren hat. Seine eigenen Änderungen machen diesen Schritt nicht ungültig. Spätere Auswirkungen prüfen erneut. Sichere den Startzustand mit atomaren Prüfungen.

Im visuellen Builder bleibt die optionale Verfügbarkeit eingeklappt, bis du eine Regel hinzufügst. Ihre Zusammenfassung lautet **Immer**, **Benutzerdefinierte Regel** oder **Prüfung erforderlich**. Bearbeite kurze Abfragen im Inspektor oder wähle **Großen Editor öffnen** für denselben automatisch gespeicherten Entwurfswert. Beide Editoren verwenden nur den impliziten Kontext der ausgewählten Seite. Die GQL-Konsole für Rohdaten bietet den `@…`-Kontext von Grids Apps bewusst nicht an.

## Lokale Zustände gestalten {icon="info-circle"}

Blöcke zeigen eigene Lade-, Leer- und Fehlerzustände. Gib Leerzuständen einen nützlichen nächsten Schritt. Blockiere nicht die ganze Seite. Zustände für nicht Verfügbares verraten nie, ob ein Datensatz existiert. Nur die aktive Seite lädt, mit begrenzten Quellen und zusammengefassten berechtigten Lesevorgängen.

## Die bewussten Grenzen kennen {icon="barrier-block"}

Die erste Version hat nichts davon:

- appweite Variablen oder einen allgemeinen Ausdrucksgraphen;
- wiederverwendbare Blockdefinitionen;
- beliebige externe Abruf- oder Aktionsziele;
- Ressourcen aus anderen Bases;
- Abfragen auf Rohdaten außerhalb von GQL;
- in der App geschriebenes Inline-HTML, CSS, JavaScript oder Liquid-Kontrollfluss;
- fachspezifische Blöcke für Anfragen, Warenkörbe, Stapel oder Ausleihen.

Ein Block für Gerendertes HTML kann nur ein vorhandenes HTML-Vorlagenfeld auswählen. Dieses Feld besitzt und validiert seine Vorlage und sein CSS. Bereinigtes Markdown kann weiterhin gewöhnliche Links und die dokumentierten Platzhalter des Anfragekontexts enthalten.

Setze wiederholte Abläufe aus typisierten Seitenparametern, festen Formularwerten, begrenzten Quellen, Navigation und vorhandenen Workflows zusammen. Lässt sich ein Prozess mit diesen Bausteinen nicht sicher ausdrücken, erweitere die zuständige Grids-Ressource. Ergänze kein App-spezifisches Verhalten in der Seitenlaufzeit.

Lies [Grids App veröffentlichen](/app/grids/help/grids-publish-custom-app), bevor du die App für andere Personen bereitstellst.
