---
id: grids-build-business-app
title: Eine Geschäftsanwendung aufbauen
icon: ti ti-building-store
description: Inventar, Ausleihen, CRM, Rechnungen und Erstattungen an den tatsächlichen Aufgaben ausrichten.
order: 107
---
Beginne mit einem vollständigen Ablauf. Die Einrichtung benötigt Base-Admin-Zugriff. Vorlagen sind bearbeitbare Beispiele, keine Geschäftsregeln.

## Die benötigten Datensätze wählen {icon="table"}

Jede Vorlage enthält Workflows, Dokumentvorlagen und eine veröffentlichte Custom App. Bestellungen in Buchhandlung und Transaktionen in Finanzen bieten Details, Versand und Dokumente; Erstellungsformulare öffnen den neuen Datensatz. Inventar zeigt Verträge bei Ausleihen und Etiketten bei Gegenständen. Vorlagenupdates gelten nur für neue Bases.

| Deine Aufgabe | Beginne mit | Erste Prüfung |
| --- | --- | --- |
| Geräte auflisten | Gegenstände und Standorte; Kategorien bei Bedarf | Jeder physische Gegenstand hat einen eigenen stabilen, eindeutigen Code |
| Geräte ausleihen | Gegenstände, Ausleihen und Ausleihpositionen | Eine Position verbindet einen Gegenstand mit einer Ausleihe und dokumentiert Ausgabe und Rückgabe |
| Kunden und Vertrieb verwalten | Organisationen, Kontakte, Verkaufschancen und Aktivitäten | Verantwortliche Person und Kunde sind eindeutig |
| Rechnungen ausstellen | Kunden, Rechnungen und Rechnungspositionen | Menge, Preis, Steuer und Kundendaten passen zur beabsichtigten Rechnung |
| Auslagen erstatten | Anträge, Antragspositionen, Belegdateien und Zahlungsreferenzen | Anspruchstellende Person, geprüfte Daten und Zahlungsnachweis sind unterscheidbar |

Eine Inventarliste braucht Felder, Datensätze und Ansichten; ergänze Ausleihen für Übergaben und Rückgaben. Nutze generierte oder eindeutige Codes als fachliche Kennungen und Principals für Cloud-Personen/-Gruppen. Kundenrelationen erteilen keinen Zugriff.

Grenze bei Warenwirtschaft Einkäufe, Eingänge, Bestellungen, Lieferungen, Teilrückgaben und Bestand ab. Angezeigte Summen reservieren nichts: Bestandsaktionen müssen gleichzeitige Überbuchung verhindern. Grids ist kein fertiges ERP, Buchhaltungssystem oder Zahlungsdienst.

## In Abhängigkeitsreihenfolge aufbauen {icon="route"}

:::steps
1. **Entscheidungen festlegen.** Bestimme Berechtigte, Voraussetzungen, zusammengehörige Änderungen und Abschlusskriterien.
2. **Tabellen und Felder anlegen.** Ergänze Relationen nach ihren Zieltabellen, danach Berechnungen. Speichere Preis- und Steuerdaten direkt, wenn spätere Quellenänderungen den Geschäftsvorgang nicht verändern dürfen.
3. **Datensätze ausprobieren.** Teste fehlende Angaben, mehrere Positionen und einen abzulehnenden Fall.
4. **Formulare und Workflows ergänzen.** Formulare erfassen Eingaben; Aktionen prüfen Übergänge wie Ausgabe, Rückgabe, Freigabe und Versand. Schließe Statusfelder von der gewöhnlichen App-Bearbeitung aus. Prüfe unter **Tabelleneinstellungen → Datenintegrität → Datensatzänderungen** auch andere Schreibwege.
5. **App bauen.** Ergänze Aufgabenliste, Datensatzdetails, Erstellungsformular, Aktionen und Dokumente. Siehe **Erste Grids App erstellen**.
6. **Zugriff prüfen und veröffentlichen.** Prüfe die Veröffentlichungsvorschau und teste den veröffentlichten Ablauf mit einem Konto jeder vorgesehenen Zielgruppe.
:::

Base-Lesezugriff zeigt alle Datensätze. Persönliche Ansichten und versteckte Navigation trennen Zielgruppen nicht. Teile für engeren Zugriff Grids Apps mit serverseitigen Abfragen und Verfügbarkeitsregeln auf Listen, Details, Formularen und Aktionen. Teste die kopierte Verkaufschancen-URL eines anderen Kunden; erteile keinen Base-Zugriff, nur damit das Portal funktioniert.

Binde vor Veröffentlichung alle Workflow-Pflichteingaben. Feste Launcher nutzen gespeicherte Bindungen; `inputMode: prompt` verlangt App-Eingaben, öffnet aber keinen freien Dialog. Inventars Zeilenaktion zum Hinzufügen einer Ausleihposition bindet `item` an `ROW.id` und `loan` an `RECORD.id`, ohne allgemeine Base-Datensatzauswahl.

## Übergaben und Versand sicher wiederholen {icon="repeat"}

Erstelle pro Gegenstand eine Ausleihposition. Ausgabe prüft aktive Ausleihe, zulässige Position und verfügbaren Gegenstand und speichert die Belegung. Rückgabe muss diese treffen: Alte Ausleihen dürfen keine neu verliehenen Gegenstände zurückgeben. Erfasse Schäden vor erneuter Verfügbarkeit. Schließe Ausleihen erst nach allen Positionen ab.

Inventar liefert Ausgabe-/Rückgabeaktionen; prüfe sie vor Anpassungen. Ergänze Positionen vor Genehmigung der angefragten Ausleihe. Kits beschreiben Ausstattung, sichern aber keine zukünftigen Reservierungen.

Nutze `atomicRecords` für begrenzte Prüfungen und Änderungen, die gemeinsam gelingen müssen. Einzelne Änderungsschritte sind keine gemeinsame Transaktion. Konkurrierende Aktionen müssen denselben bestehenden Datensatz zur Koordination nutzen. Siehe **Workflows**.

Übernimm einen bereiten Versand vor Dokumenterzeugung oder E-Mail. Ein Wiederholungsschlüssel identifiziert einen Aufruf; unabhängige Anfragen brauchen trotzdem dieselbe Prüfung des Geschäftszustands. Schließe den Versand erst nach seinen Schritten ab. Prüfe bei Stillstand den ursprünglichen Lauf, Dokumente und E-Mail-Zustellung vor Wiederholung. Abbrechen macht E-Mails oder Dokumente nicht rückgängig.

## Rechnungen bewahren {icon="file-invoice"}

Erzeugte Dokumente behalten ihren Snapshot und ihre Dateien. Quellenänderungen schreiben sie nicht um. Wiederholbare Vorlagen erzeugen ein weiteres Dokument; Vorlagen mit einmaliger Ausstellung je festgeschriebenem Datensatz liefern das vorhandene. Ein Rechnungskopf finalisiert verknüpfte Positionen nicht rekursiv. Objektlistenpositionen gehören dagegen zum Kopf und werden mit ihm festgeschrieben. Erfasse spätere Zahlungen getrennt.

## Mit Rechnungswesen starten {icon="file-invoice"}

Die Vorlage **Rechnungswesen** bietet Rechnungen, Korrekturen und Provisionsgutschriften in EUR für unterschiedliche deutsche Geschäftspartner mit USt-IdNr. und 7 % oder 19 % USt. Andere Fälle benötigen ein anderes Modell oder einen anderen Renderer.

1. Ergänze unter **Dein Unternehmen** die echten Unternehmens- und Bankdaten. Beispieldatensätze sind Entwürfe.
2. Erstelle eine Rechnung, wähle oder erstelle den Partner und erfasse Objektlistenpositionen. Prüfe Summen, Leistungs- und Fälligkeitsdatum vor der Ausstellung.
3. Wähle **Rechnung ausstellen / abrufen** auf der gespeicherten Detailseite. Das schreibt den Beleg fest. Wiederhole diese Aktion nach einem Renderfehler: Dokument und Nummer bleiben gleich. `REF-…` ist eine interne Referenz, keine Rechnungsnummer.
4. Erfasse tatsächlich eingegangene oder ausgezahlte Beträge und wähle **Zahlung bestätigen**. Erst bestätigte Zahlungen zählen zum Saldo; danach sind sie unveränderlich. Es wird keine Überweisung ausgeführt.

Bereite Korrekturen von der ursprünglichen Rechnung aus vor; reduziere kopierte Positionen für eine Teilkorrektur. Prüfungen erhalten den verbleibenden Netto- und Steuerbetrag je Satz. Provisionsgutschriften benötigen eine Vereinbarungsreferenz und das Empfängerkonto; erfasse Positionen direkt und rechne dieselbe Verpflichtung nicht zweimal ab. **Entwurf verwerfen** verschiebt unfertige, nicht ausgestellte Belege in den Papierkorb. Interne Notizen erscheinen nicht im PDF/XML.

Korrekturen beginnen mit dem heutigen Belegdatum und ohne Fälligkeitsdatum; prüfe beides vor der Ausstellung. Erfasse Kundenerstattungen über **Erstattung erfassen** an der ursprünglichen Rechnung mit positivem Betrag. Die Bestätigung mindert deren Zahlungseingänge und verhindert Erstattungen über das aktuelle Guthaben hinaus, auch bei gleichzeitigen Bestätigungen. Die Korrektur hat keinen eigenen Zahlungssaldo. Unbestätigte Zahlungen und Erstattungen kannst du verwerfen; bestätigte bleiben unveränderlich.

HTML-Rechnungsvorlagen sind keine E-Rechnungen. Prüfe Währungs-, Steuer-, Adress- und Korrekturgrenzen des installierten Renderers sowie beide Ausgabedateien. Der Aussteller bleibt verantwortlich; Validierung ist keine steuerliche oder rechtliche Freigabe. Buchhandlung zeigt Rechnungen, wickelt aber keine Zahlungen ab.

## Auslagen prüfen {icon="checklist"}

Binde bei Auslagen die angemeldete anspruchstellende Person fest im Formular, statt die Auswahl einer anderen Identität zu erlauben. Die Vier-Augen-Finalisierung verlangt eine andere Person als diejenige, die die Finalisierung angefragt hat. Sie vergleicht kein separates Anspruchstellerfeld: Reicht jemand stellvertretend ein, musst du die Selbstfreigabe durch die anspruchstellende Person weiterhin gesondert ausschließen.

Die Prüfung gilt für eine genaue Datensatzversion. Geänderte Werte, Relationen oder Dateien machen deren offene Anfrage ungültig; Änderungen verknüpfter Positionen nicht. Definiere Datensätze und Belegversionen der Einreichung und verlange nach Änderungen eine neue Prüfung. Eine Kopffreigabe genehmigt keine späteren Positionsänderungen. Siehe **Tabellen & Felder** für Zugriff und dauerhafte Historien-/Finalisierungseinstellungen.

Ein Bezahlt-Kontrollkästchen überweist nichts. Zahlungsausführung braucht ein angebundenes System, stabile Referenzen und Schutz vor doppelten/ungewissen Anfragen. Kläre ungewisse HTTP-Wirkungen dort vor Wiederholung. Finanzen erfasst Transaktionen und Belegversand, keinen Erstattungsprozess mit Antrag und Freigabe.

## Den gesamten Ablauf prüfen {icon="checklist"}

Teste eine leere Liste, eine normale Einreichung, eine veraltete Bearbeitung sowie fehlende oder unzugängliche Datensatz-IDs. Wiederhole den Ablauf nach Neuladen und über eine kopierte Detail-URL. Probiere zwei unabhängige Ausgabe-, Versand- oder Zahlungsanfragen aus und prüfe einen unterbrochenen Vorgang. Teste bei Auslagen außerdem Selbstfreigabe und nach der Prüfung geänderte Belege oder Positionen.

Halte Ergebnisse, Unsicherheiten, App-Link, zuständige Person und Wiederherstellung fest. Ein gültiger Entwurf beweist weder Zugriffstrennung noch sichere Wiederholungen oder korrekte Zahlungen.

Weiterführend: [Erste Grids App erstellen](/app/grids/help/grids-build-custom-app), [Workflows](/app/grids/help/grids-workflows), [Dokumente & PDFs](/app/grids/help/grids-documents-pdfs) und [Tabellen & Felder](/app/grids/help/grids-tables-fields).
