---
id: grids-custom-app-pages-blocks
title: Seiten und Blöcke in Grids Apps
icon: ti ti-layout-grid
description: Responsive Seiten aus typisierten, ressourcenbasierten Blöcken zusammensetzen.
order: 134
---
Eine Grids App ist eine kleine Zusammenstellung vorhandener Grids-Ressourcen. Ihr Seitenbaum steuert Layout und Navigation. Ihre Blöcke legen fest, welche Ressourcen erscheinen und welche bereits definierten Operationen eine Person starten darf.

## Seiten und Layout einrichten {icon="layout-grid"}

Verwende stabile IDs statt Bezeichnungen für Links. Eine Seiten-URL lautet `/apps/<id>/<pageId>`; deklarierte Record-Parameter stehen im Query-String. Die [API-Referenz](/app/grids/help/grids-custom-app-api) beschreibt ID-Regeln, Layoutgrenzen und alle Bindungen.

Diese Version unterstützt nur erforderliche Record-Parameter. Jeder Parameter deklariert eine Tabelle derselben Base; seine URL und sein Wert `@params.<name>` sind öffentliche Datensatz-IDs.

Wähle unter **Routenparameter** eine Parameter-ID und ihre Tabelle. Ein Datensatz- oder Gerendertes-HTML-Block bindet diesen Parameter automatisch. Eine reine Routenseite kann den autorisierten Parameter auch in GQL oder festen Formularwerten nutzen, ohne den Datensatz darzustellen. Seiten mit Pflichtparametern erscheinen nicht in der Navigation und können nicht die Startseite sein. Fehlende oder unzugängliche Datensätze zeigen den einheitlichen Nicht-verfügbar-Zustand.

Seiten enthalten Zeilen, Spalten und Blöcke. Nutze Breite 12 für eine Aufgabe, 8 + 4 für Hauptinhalt und Kontext oder 6 + 6 für gleichrangige Inhalte. Auf schmalen Bildschirmen stehen Spalten in derselben Reihenfolge untereinander. Prüfe beide Breiten vor dem Veröffentlichen; separate mobile Layouts sind nicht nötig.

Platziere die nächste Aktion neben den Informationen, die dafür nötig sind. Nutze einen Dialog für kurze Aufgaben, die über eine Schaltfläche beginnen. Ein Formular bleibt direkt eingebettet, wenn es zusammen mit dem Kontext auf der Seite bearbeitet werden soll.

Für ergänzende Informationen kannst du jedem Block `disclosure: { label: "Weitere Angaben" }` geben. Ein Klick auf die Überschrift öffnet den Inhalt; mit `defaultOpen: true` startet er aufgeklappt. Das Einklappen verzögert das Laden nicht und verändert keine Berechtigungen. Für die Verfügbarkeit nutzt du `availableWhen`.

## Ressourcenbasierte Blöcke konfigurieren {icon="blocks"}

### Markdown

Markdown stellt Überschriften, Listen, Links und sichere Bilder dar. Es führt weder Skripte noch eingebetteten Anwendungscode aus. Der Inline- und der große Editor vervollständigen Platzhalter für `@auth`, `@params`, `@page`, `@app`, `@base` und `@time` der aktuellen Seite. `Hello @auth.name` fügt zum Beispiel den Anzeigenamen der angemeldeten Person auf dem Server ein. Anonyme Authentifizierungswerte werden zu leerem Text. Eingefügte Werte werden vor dem Rendern von Markdown maskiert. Liquid-Bedingungen oder -Schleifen gibt es nicht.

Nutze in einer veröffentlichten App Hinweisboxen für kurze Erklärungen oder Warnungen. Füge sie in einen gewöhnlichen Markdown-Block ein; ein eigener Blocktyp ist nicht nötig:

```markdown
:::info Zahlungen bestätigen
Gleiche die Einträge mit deinen Bankumsätzen ab. Erst bestätigte Zahlungen ändern den offenen Betrag.
:::
```

Unterstützte Varianten sind `note`, `info`, `success`, `warning` und `danger`. Schreibe den Titel nach der Variante in der Sprache der App. Veröffentlichtes Markdown wird auf dem Server bereinigt; Skripte und unsichere Links werden entfernt. Der Editor behält den Markdown-Quelltext und die Hervorhebung der Kontextplatzhalter bei.

### Datensätze

Datensätze liest entweder eine vorhandene gespeicherte Ansicht oder eine Inline-GQL-Abfrage. Eine gespeicherte Ansicht kann eine ausdrückliche Auswahl von Tabellenfeldern verwenden oder die vorhandene Kartenkonfiguration dieser Ansicht einschließlich ihres Dateicovers wiederverwenden. Karten können schreibgeschützt sein, zu einer Zeilenseite navigieren oder Zeilenaktionen anbieten und werden bei der Veröffentlichung mit der gespeicherten Ansicht festgeschrieben. Inline-GQL zeigt die ausgewählten gewöhnlichen Datensatzspalten einschließlich Aliasnamen. Eine nicht leere Tabellenliste `columnIds` kann ausgewählte Feldspalten für Verhalten verfügbar halten, während nur die aufgeführten Feld-IDs sichtbar sind. Nutze Kennzahlen oder Diagramm für Aggregatergebnisse. Beide Datensatzquellen unterstützen einen Leertext, optionale Zeilennavigation und optionale serverseitige Suche.

Eine leere Ergebnistabelle zeigt nur Blocktitel und Leertext. Eine erfolglose Suche behält Tabelle und Suchfeld, damit du die Suche ändern kannst. Lade- und Fehlerzustände bleiben von einem leeren Ergebnis unterscheidbar.

In der Tabellendarstellung ergänzt `display.relativeDateColumnIds` das absolute Datum um „heute“, „morgen“ oder einen Abstand in Kalendertagen. Das ist nur für reine Datumsspalten möglich. Die Angaben verwenden die konfigurierte Zeitzone; sie stufen einen Eintrag nicht als überfällig ein.

Mit `display.mobile: { titleColumnId, detailColumnIds }` wählst du eine Überschrift und ergänzende Werte pro Zeile für schmale Bildschirme. Auf breiteren Bildschirmen bleibt die Tabelle sichtbar. Zeilenlinks, Workflow-Aktionen, Suche und Seitennavigation funktionieren in beiden Darstellungen gleich. Referenziere sichtbare Spalten: öffentliche Feld-IDs bei gespeicherten Ansichten, die eindeutigen Spaltenbeschriftungen aus der Abfragevorschau bei GQL. Innerhalb der Datumsliste beziehungsweise der mobilen Konfiguration darf jede Referenz nur einmal vorkommen.

`pageSize` legt fest, wie viele Zeilen der Server auf einmal zurückgibt. Lesende Personen bewegen sich durch geschützte Cursor-Seiten. Suche und Seitennavigation laufen auf dem Server und laden nie das vollständige Ergebnis in den Browser. Ein GQL-`limit` begrenzt das vollständige Ergebnis, wenn die verfassende Person bewusst nur die ersten N passenden Zeilen benötigt. Gemeinsame Abfragebudgets werden unabhängig davon durchgesetzt.

Eine Inline-Abfrage erhält automatisch den typisierten Kontext `@auth.id`, `@auth.name`, `@auth.username`, `@auth.email`, `@auth.subjects`, `@params`, `@page`, `@app`, `@base` und `@time`. `@auth.subjects` enthält die UUID der angemeldeten Person und die UUIDs wirksamer Gruppen; für anonyme Personen ist die Liste leer. Werte werden getrennt vom Abfragetext gebunden. Unbekannte Namensräume und nicht deklarierte Seitenparameter verhindern die Veröffentlichung.

Nutze `ROW.id` nur für den Zeilenlink oder die Workflow-Zeilenaktionen dieses Datensatzblocks. Ein Zeilenlink kann stattdessen `{ source: ROW, path: relation, fieldId: ... }` binden, wenn das Feld eine ausgewählte einzelne Relation zur Tabelle des Zielparameters ist. Vor dem Start des Workflows wird eine Zeilenaktion gegen das exakte veröffentlichte Abfrageergebnis geprüft. Konfiguriere bis zu sechs Aktionen mit einer erforderlichen zugänglichen Bezeichnung und einem optionalen Symbol. Tabellen und Karten können Bezeichnung, Symbol oder beides zeigen.

### Referenzierte Datensätze

Referenzierte Datensätze ist nur auf einer Record-Seite verfügbar. Der Block zeigt Zeilen aus einer festgeschriebenen Quelltabelle, deren festgeschriebenes Relationsfeld den aktuellen Seitendatensatz enthält. Wähle im Block die exakten sichtbaren Felder, Tabellen- oder Kartendarstellung, Suche, Seitengröße und optionale Zeilenworkflows. Die Veröffentlichung kompiliert dies in dieselbe begrenzte GQL- und `recordQueries`-Capability wie bei Datensätzen. Die App-Freigabe bleibt die äußere Zugriffsgrenze. Der Block erweitert den Seitendatensatz nicht und gibt keine uneingeschränkte Rückwärtssuche frei.

### Kennzahlen und Diagramm

Kennzahlen und Diagramm lesen entweder eine vorhandene gespeicherte Ansicht oder eine Inline-GQL-Abfrage. Die Laufzeit wendet gemeinsame Abfragebudgets an.

Kennzahlen übernehmen normalerweise das Zahlenformat ausgewählter Felder. Für Aggregatausdrücke ohne Feldinformationen lässt sich ein gemeinsames `valueFormat` festlegen, etwa `{ style: "number", decimalPlaces: 2, unit: "EUR" }`. Es gilt für jeden Wert des Blocks. Grids leitet keine Währung aus der Abfrage ab. Die Formatierung verändert nur die Anzeige, nicht die exakten Berechnungswerte.

Kennzahlen akzeptiert eine nicht gruppierte Aggregatabfrage und stellt bis zu 12 benannte skalare Ergebnisse dar. Diagramm akzeptiert eine gruppierte Aggregatabfrage und stellt ein Ring-, Balken- oder Liniendiagramm mit mindestens einer Aggregatwertreihe dar. Ein Diagrammblock darf über sein `limit` höchstens 100 Gruppen darstellen.

Die veröffentlichte Capability zeichnet die exakten Tabellen und Felder hinter dem Block auf. Lesende Personen der App benötigen keinen Basiszugriff. Die Laufzeit kann keine Quellen außerhalb dieser unveränderlichen Capability abfragen. Veröffentliche nach einer Änderung der Quelle einer gespeicherten Ansicht erneut.

### Formular

Formulare bestimmen Eingaben, Validierung und Standardwerte. App-Lesende können ohne Base-Zugriff verknüpfte Datensätze wählen: Die Suche zeigt nur IDs und veröffentlichte Anzeigefelder der Zieltabelle. Änderungen daran oder an ihren Formelabhängigkeiten erfordern erneutes Veröffentlichen.

Ein Formular ist standardmäßig direkt eingebettet. Mit `presentation.kind: dialog` und einer Schaltflächenbeschriftung öffnet es sich über der aktuellen Seite. Standardwerte, feste Werte, Validierung und Berechtigungen gelten unverändert. Ungespeicherte Eingaben werden erst nach Bestätigung verworfen; während des Speicherns lässt sich der Dialog nicht schließen.

Dialog-Schaltflächen sind nur so breit wie ihr Inhalt. Wähle `presentation.variant: primary` für die wichtigste nächste Aktion oder `secondary` (Standard) für eine ergänzende Aktion.

Dieses Beispiel öffnet auf einer Rechnungsseite ein Zahlungsformular, dem die aktuelle Rechnung bereits zugewiesen ist. Ersetze die Beispiel-IDs durch die IDs deines Formulars und Relationsfelds:

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

Wähle **Formularaktion → Datensatz dieser Seite bearbeiten**, um einen vorhandenen Entwurf zu bearbeiten. Die Seite muss einen Datensatz aus der Tabelle des Formulars binden. Der Server lädt die Eingaben und konfigurierten zugehörigen Zeilen vor der Darstellung; beim Speichern werden ihre Versionen gemeinsam geprüft. Eine entfernte Zeile wird vom übergeordneten Datensatz getrennt, aber nicht gelöscht. Gemeinsam genutzte Zeilen und festgeschriebene Datensätze lassen sich hier nicht bearbeiten. Verknüpfte Tabellen müssen zur selben Base gehören. Bestehende Formular-Blöcke legen weiterhin neue Datensätze an, bis du die Aktion änderst und die App erneut veröffentlichst.

Der Block kann vertrauenswürdige Werte für jedes Eingabefeld bereitstellen. Nutze `LITERAL` für einen validierten festen Wert. Kompatible Relationsfelder können einen deklarierten Record-Wert aus `PARAMS` oder `RECORD.id` des aktuellen Seitendatensatzes verwenden. Ein Principal-Feld kann mit `AUTH.currentUser` die angemeldete Person zuweisen, ohne einen weiteren Picker anzuzeigen. Bereitgestellte Eingaben fehlen im dargestellten Formular, werden erneut vom Server aufgelöst und können im Browser nicht überschrieben werden. Dies unterstützt Abläufe wie „weiteren Artikel zu dieser Liste hinzufügen“, ohne erneut nach derselben Relation zu fragen.

Formulare mit über `actionsBlockId` verknüpften Aktionen bleiben eingebettet, damit der Workflow-Status sichtbar bleibt. Die Dialogdarstellung ist für sie nicht zulässig.

Nach erfolgreichem Speichern kann ein eingebettetes Formular auf der Seite bleiben. Ein Dialog schließt sich und aktualisiert seine Ausgangsseite. Ein explizites `onSuccessNavigate` hat Vorrang und navigiert innerhalb derselben App mit Ersetzen. Navigationsparameter können deklarierte `PARAMS`-Werte beibehalten oder `RESULT.recordId` des erstellten Formulardatensatzes verwenden.

Eine App darf bis zu 24 Formularblöcke veröffentlichen. Jedes referenzierte Formular darf bis zu 100 Eingaben bereitstellen, von denen die Seite bis zu 30 vorgeben darf.

#### Formulare mit Kontext

Ein über `actionsBlockId` verbundenes Formular zeigt Eingaben neben der aktuellen
Zusammenfassung und den nächsten Aktionen. Beide verwenden denselben Entwurf.
Das letzte konfigurierte berechnete Feld erscheint zuerst als hervorgehobener Wert.
Fehlende Angaben lassen sich direkt anspringen. Primäre Aktionen bleiben gesperrt,
bis die Eingaben gültig und gespeichert sind. Nach dem Speichern wird der bestätigte
Datensatz neu geladen. Die serverseitigen Prüfungen bleiben maßgeblich.

Das optionale Objekt `workspace` erlaubt `summaryTitle`, `summaryDescription`,
`helpTitle` und `helpText`. Selten benötigtes Hintergrundwissen gehört in den
aufklappbaren Hinweis. Die Option setzt einen Aktionsblock voraus und ist in einem
Dialog nicht verfügbar.

Mit `heading.title` kann ein Datensatzblock einen bearbeitbaren Entwurf benennen.
Das Überschriftsfeld wird dann zum Untertitel. Eine ausgestellte Belegnummer hat
Vorrang; festgeschriebene Datensätze verwenden die Entwurfsüberschrift nicht.

### Datensatz

Datensatz erfordert einen Seitendatensatz. Der Block stellt die ausdrückliche Liste `fieldIds` dar und kann direkte Bearbeitung über eine ausdrückliche Teilmenge `editableFieldIds` erlauben. Jedes bearbeitbare Feld muss auch angezeigt werden und ein beschreibbares gespeichertes Feld sein. Berechnete und Systemfelder verhindern die Veröffentlichung.

Wähle `layout: grid` (Standard), `rows` für nebeneinanderstehende Bezeichnungen und Werte oder `compact` für kurze Metadaten. Nutze `summary` für Summen: Werte werden am Zeilenende ausgerichtet, die letzte Zeile wird hervorgehoben. Setze die Gesamtsumme in `fieldIds` an die letzte Stelle.

Schreibgeschützte Objektlisten erhalten innerhalb des Blocks eine gerahmte Tabelle mit abgerundeten Ecken. Feldname und Zeilenanzahl stehen gemeinsam in ihrer Kopfzeile. Ergänzende Spalten stehen unter weiteren Angaben; längere Listen werden in Seiten unterteilt.

Mit `relativeDates` ergänzt du ausgewählte angezeigte Datumsfelder um einen Abstand in Kalendertagen, etwa `17.09.2026 (heute)`. Das absolute Datum bleibt sichtbar. Felder mit Uhrzeit werden nicht unterstützt; doppelte oder nicht angezeigte Feld-IDs verhindern die Validierung.

Mit `heading: { fieldId }` wird ein angezeigtes Feld zur Überschrift, etwa Kunde oder Betreff. Es erscheint dann nicht nochmals in der Feldliste. Mit `heading: { fieldId, documentNumber: true }` und einer `documents`-Vorlagenliste wird die vorhandene Dokumentnummer zur Überschrift; das gewählte Feld bleibt darunter sichtbar. Entwürfe behalten die Feldüberschrift, sofern `heading.title` keine Aufgabenüberschrift vorgibt. Dokumente lassen sich über dauerhaft sichtbare, beschriftete Schaltflächen herunterladen.

Die Aktion Bearbeiten erscheint nur, wenn die Veröffentlichung dieses beschreibbare Feld enthält und der Block verfügbar ist. Beim Absenden prüft Grids erneut App-Freigabe, unveränderliche Feld-Erlaubnisliste, `availableWhen`, aktiven Feldtyp, Audit-Fragen der Tabelle und aktuelle Datensatzversion. Felder außerhalb der bearbeitbaren Teilmenge des Blocks bleiben schreibgeschützt.

Ein bearbeitbares Dateifeld verwendet denselben auditierten Lebenszyklus für Hinzufügen, atomisches Ersetzen und **Aus Datensatz entfernen** wie der Basis-Arbeitsbereich. Die App-Freigabe bleibt die äußere Grenze; die veröffentlichte Capability für bearbeitbare Felder grenzt sie weiter ein. Das Entfernen löst den aktuellen Anhang. Geschützte Historie oder Artefakte können die exakten Bytes behalten, während ungeschützte Dateien bereinigt werden können.

`documents.templateIds` zeigt verknüpfte Dokumente aus Vorlagen der Seitendatensatz-Tabelle. Downloads sind geschützt; die Ausstellung erfordert einen Workflow. Optionale Entwurfsvorschauen müssen explizit freigegeben werden: siehe [API-Referenz](/app/grids/help/grids-custom-app-api). Der Block erstellt keine öffentlichen Links.

### Gerendertes HTML

Gerendertes HTML erfordert einen Seitendatensatz und referenziert genau ein Feld vom Typ `html_template` aus dessen Tabelle. Der Block stellt den bereits gerenderten Wert dar, ohne benachbarte Datensatzfelder offenzulegen. Wähle die Höhe `compact`, `normal` oder `large`; der Iframe passt seine Größe nicht an den Vorlageninhalt an.

Die Ausgabe läuft in einer Sandbox ohne Skripte, Formulare, Pop-ups, Zugriff auf die übergeordnete Seite oder Zeigerinteraktion. Eine standardmäßig verweigernde Inhaltsrichtlinie blockiert außerdem externe Bilder, Schriftarten, Medien, Frames, Verbindungen und Navigation. Nur Inline-Stile und `data:`-Bilder sind verfügbar. Nutze einen Datensatz-, Formular- oder Aktionsblock für Interaktionen. Eine Änderung des Feldtyps, das Entfernen des Felds oder ein Fehler beim Rendern der Vorlage erzeugt einen lokalen Nicht-verfügbar-Zustand. Die App-Seite fällt niemals auf rohes HTML zurück.

### Kommentare

Kommentare erfordert einen Seitendatensatz und eine angemeldete Person mit Lesezugriff auf die App. Der Block lädt beim Darstellen eine begrenzte erste Seite und ruft ältere Kommentare anschließend mit Keyset-Seitennavigation ab. Der veröffentlichte Kommentarblock und die aktuelle App-Freigabe erlauben das Erstellen von Kommentaren ohne Schreibzugriff auf Basis oder Datensatz. Verfassende Personen können ihre eigenen Kommentare bearbeiten und löschen. Personen mit Verwaltungsrechten für die Basis können alle Kommentare moderieren. Gelöschte Kommentare bleiben als Platzhalter mit Zeitstempel erhalten, damit die Gesprächsreihenfolge verständlich bleibt.

Kommentare übernehmen die Sichtbarkeit des Datensatzes. Sie führen weder eine eigene Zielgruppe noch einen eigenen Berechtigungsspeicher ein.

### Aktionen

Aktionen enthält Schaltflächen, die entweder innerhalb derselben Grids App navigieren oder einen vorhandenen aktivierten Workflow-Launcher für Grids Apps starten. Eine Workflow-Aktion kann JSON-Werte aus `LITERAL`, deklarierte Record-Werte aus `PARAMS` oder `RECORD.id` des aktuellen Seitendatensatzes an kompatible Workflow-Eingaben binden. Feste Launcher verwenden ihre gespeicherten Bindungen und akzeptieren keine Aktionseingaben.

Der Block kann keine beliebigen URLs aufrufen, Datensätze direkt aktualisieren oder einen Workflow ausführen, der nicht in der veröffentlichten Capability-Menge enthalten war.
Das Starten eines Workflows erfolgt asynchron. Die Schaltfläche verfolgt ihre eingegrenzte Ausführung und zeigt bei Erfolg oder Fehler die bereinigte Ergebnismeldung des Workflows. Sie legt weder den allgemeinen Workflow-Verlauf noch rohe Fehler offen. Navigation nach einem Workflow gehört in den Workflow oder einen späteren Übergang des Seitenzustands. Aktionen bindet keine beliebigen Workflow-Ergebnisse.

Die Laufzeit validiert die veröffentlichte App-Freigabe, exakte Seite, Block, Aktion, Launcher, Workflow-Revision, Seitendatensätze und `availableWhen`-Abfrage erneut. Eine Aktion, die in der unveränderlichen Capability-Menge der Veröffentlichung fehlt, wird ausgelassen. Workflow-Aktionen erfordern ein angemeldetes Konto.

#### Dokumente im Hintergrund erstellen

Für eine Dokumentaktion am Seitendatensatz setzt du `background` auf
`{ acceptedMessage, documentBlockId, documentTemplateId }`. Der referenzierte
Datensatzblock muss diese Vorlage ohne Verfügbarkeitsbedingung anzeigen.
Eine solche Seite hat eine Ergebnisvorlage; mehrere Aktionen dürfen sie erzeugen.
Nach Annahme erscheint die konfigurierte Nachricht. Du kannst weiterarbeiten.

Nach Navigation oder Neuladen bleibt der Status sichtbar. Sobald die gespeicherte
Datei vorhanden ist, öffnet die Aktion das Dokument. Zeigt ein berechtigter,
sichtbarer Datensatzblock bereits genau dieses fertige Dokument, entfällt die
doppelte Abschlussaktion. Andernfalls bleibt sie verfügbar. Gleichzeitige Aufrufe derselben
veröffentlichten Aktion mit denselben Seitendatensätzen und Eingaben verwenden den
laufenden Auftrag, auch bei verschiedenen berechtigten App-Lesern. Sichtbar ist nur
der Dokumentstatus, nicht die Eingaben, Ergebnisse oder internen Fehler anderer
Nutzer. Erfordert der Workflow eine administrative Prüfung, ist kein neuer Start möglich.

Ein Datensatzlistenblock in Tabellendarstellung zeigt mit `workflowStatus: true`
diese Zustände pro Zeile. Dafür muss seine Zeilennavigation direkt mit `ROW.id`
auf die uneingeschränkt verfügbare Dokumentseite zeigen. Die Liste bleibt suchbar
und in Seiten unterteilt. Sichtbare laufende Einträge werden aktualisiert.

#Skalare Workflow-Eingaben können über `prompt.inputs` direkt im Aktionsdialog abgefragt werden. Beschriftungen und Validierung stammen aus dem Workflow. Binde den aktuellen Datensatz weiterhin serverseitig. Ein Abschluss führt den Vorgang aus und aktualisiert nach Erfolg die Seite. Bei unklarem Ausgang prüft eine Wiederholung denselben Vorgang; sie startet keinen zweiten. `description` und `successMessage` erklären Aufgabe und Ergebnis.

## Scanner

Scanner bettet eine vorhandene aktivierte Scanner-Ausführungsoption ein. Angemeldete lesende Personen der App können mit der Kamera scannen oder einen Code manuell eingeben. Öffentliche anonyme Personen sehen stattdessen eine Aufforderung zur Anmeldung. Sitzungswerte werden einmal beim Öffnen des Scanners abgefragt, Werte nach dem Scan für jeden Code.

Die App veröffentlicht den exakten Block, Launcher, die Workflow-Revision und den Hash der Scanner-Konfiguration. Jeder Aufruf und jedes Lesen des Status prüft diesen Snapshot und die App-Freigabe der lesenden Person erneut. Eine Änderung der Ausführungsoption oder des Workflows erfordert eine erneute Veröffentlichung der App. Ergebnisse von Scanner-Ausführungen bleiben auf die Person begrenzt, die sie gestartet hat.

Scannerblöcke unterstützen skalare Sitzungs- und Nach-dem-Scan-Eingaben. Eingaben für Datensätze und Datensatzlisten bleiben im vollständigen Workflow-Scanner verfügbar, werden in einem eingebetteten App-Scanner aber abgelehnt, weil eine lesende Person der App möglicherweise keinen unmittelbaren Basiszugriff auf einen Datensatz-Picker besitzt. Die gescannte Eingabe selbst kann weiterhin über einen generierten Scan-Code oder ein konfiguriertes eindeutiges Feld zu einem Datensatz aufgelöst werden.

## Navigation ausdrücklich definieren {icon="arrow-right"}

Zwischen Seiten normale Push-Navigation verwenden, nach Formularerfolg ersetzende Navigation. Jeder Zielparameter benötigt eine kompatible Bindung. Für wiederholte Eingaben den Eltern-Datensatz als Seitenparameter behalten und die Formularrelation daran binden.

Die [API-Referenz](/app/grids/help/grids-custom-app-api) beschreibt die exakten Navigations- und Erfolgsbindungen.

## Verfügbarkeit mit GQL durchsetzen {icon="adjustments"}

Eine Seite, ein Block, Formular oder eine Aktion kann eine `availableWhen.query` deklarieren. Der Server stellt denselben impliziten Kontext wie bei Datenabfragen bereit. Die Ressource ist nur verfügbar, wenn die begrenzte Abfrage mindestens eine Zeile zurückgibt.

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

Leere Ergebnisse oder Abfragefehler blenden Ressource und Datenquelle aus. Absenden, Aufruf und Workflow-Effekte prüfen Regeln, Rechte, Launcher und Veröffentlichung. `atomicRecords` prüft einmal nach den Sperren; eigene Änderungen entziehen diesem Schritt nicht die Freigabe. Spätere Effekte prüfen erneut. Sichere den Startzustand atomar.

Im visuellen Builder bleibt die optionale Verfügbarkeit eingeklappt, bis du eine Regel hinzufügst. Ihre Zusammenfassung lautet **Immer**, **Eigene Regel** oder **Benötigt Aufmerksamkeit**. Bearbeite kurze Abfragen im Inspektor oder wähle **Großen Editor öffnen** für denselben automatisch gespeicherten Entwurfswert. Beide Editoren verwenden nur den impliziten Kontext der ausgewählten Seite. Die unmittelbare GQL-Konsole bietet den `@…`-Kontext von Grids Apps bewusst nicht an.

## Lokale Zustände gestalten {icon="info-circle"}

Blöcke zeigen eigene Lade-, Leer- und Fehlerzustände. Gib im Leerzustand einen sinnvollen nächsten Schritt an; blockiere nicht die ganze Seite. Nicht-verfügbar-Zustände verraten nie, ob ein Datensatz existiert. Nur die aktive Seite lädt, mit begrenzten Quellen und deduplizierten autorisierten Zugriffen.

## Bewusste Grenzen kennen {icon="barrier-block"}

Die erste Version besitzt keine appweiten Variablen, keinen allgemeinen Ausdrucksgraphen, keine wiederverwendbaren Blockdefinitionen, beliebige externe Abruf- oder Aktionsziele, basisübergreifenden Ressourcen, unmittelbaren Abfragen außerhalb von GQL, von der App verfasstes Inline-HTML, CSS, JavaScript, Liquid-Kontrollfluss oder domänenspezifische Anfrage-, Warenkorb-, Batch- oder Ausleihblöcke. Ein Block für Gerendertes HTML darf nur ein vorhandenes HTML-Vorlagenfeld auswählen. Seine Vorlage und sein CSS bleiben Eigentum dieses Felds und werden dort validiert. Bereinigtes Markdown darf weiterhin gewöhnliche Links und die dokumentierten Platzhalter des Anfragekontexts enthalten.

Setze wiederholte Abläufe aus typisierten Seitenparametern, festen Formularwerten, begrenzten Quellen, Navigation und vorhandenen Workflows zusammen. Wenn sich ein Prozess mit diesen Bausteinen nicht sicher ausdrücken lässt, erweitere die zuständige Grids-Ressource, statt appspezifisches Verhalten in die Seitenlaufzeit aufzunehmen.

Lies vor der Freigabe der App für andere Personen [Veröffentlichen und Berechtigungen](/app/grids/help/grids-publish-custom-app).

Mit `layout: "context"` erscheint ein Datensatzblock als kompakter Bezug, etwa zum ursprünglichen Beleg.
