---
id: grids-build-business-app
title: Eine Geschäftsanwendung aufbauen
icon: ti ti-building-store
description: Inventar, Ausleihen, CRM, Rechnungen und Erstattungen an den tatsächlichen Aufgaben ausrichten.
order: 107
---
Baue zuerst einen vollständigen Arbeitsablauf, bevor du Berichte oder weitere Automatisierung ergänzt. Zum Einrichten benötigst du Base-Admin-Zugriff. Eine Vorlage liefert bearbeitbare Beispiele; sie legt deine Geschäftsregeln nicht fest.

## Die benötigten Datensätze wählen {icon="table"}

Jede integrierte Vorlage enthält Workflows, Dokumentvorlagen und mindestens eine veröffentlichte Custom App. Öffne in Buchhandlung und Finanzen eine Bestellung oder Transaktion, um Details zu prüfen, den Versand auszuführen und erzeugte Dokumente zu sehen. Die Erstellungsformulare öffnen ebenfalls die Detailseite des neuen Datensatzes. Inventar zeigt Leihverträge bei Ausleihen und erzeugte Etiketten bei Gegenständen. Diese Verbesserungen gelten für neu erstellte Bases; Vorlagenupdates verändern bestehende Bases nicht.

| Deine Aufgabe | Beginne mit | Erste Prüfung |
| --- | --- | --- |
| Geräte auflisten | Gegenstände und Standorte; Kategorien bei Bedarf | Jeder physische Gegenstand hat einen eigenen stabilen, eindeutigen Code |
| Geräte ausleihen | Gegenstände, Ausleihen und Ausleihpositionen | Eine Position verbindet einen Gegenstand mit einer Ausleihe und dokumentiert Ausgabe und Rückgabe |
| Kunden und Vertrieb verwalten | Organisationen, Kontakte, Verkaufschancen und Aktivitäten | Verantwortliche Person und Kunde sind eindeutig |
| Rechnungen ausstellen | Kunden, Rechnungen und Rechnungspositionen | Menge, Preis, Steuer und Kundendaten passen zur beabsichtigten Rechnung |
| Auslagen erstatten | Anträge, Antragspositionen, Belegdateien und Zahlungsreferenzen | Anspruchstellende Person, geprüfte Daten und Zahlungsnachweis sind unterscheidbar |

Für eine einfache Inventarliste reichen Felder, repräsentative Datensätze und nützliche Ansichten. Ergänze Ausleihen erst, wenn du Übergaben und Rückgaben benötigst. Verwende einen generierten oder eindeutigen Code als fachliche Kennung und ein Principal-Feld für eine Cloud-Person oder -Gruppe. Eine Kundenrelation erteilt diesem Kunden keinen Zugriff.

Lege für Warenwirtschaft zuerst fest, welche Einkäufe, Eingänge, Bestellungen, Lieferungen, Teilrückgaben und Bestandsmengen du verwalten möchtest. Ein angezeigter Bestand reserviert keine Ware. Versprich Schutz vor Überbuchung bei gleichzeitiger Kommissionierung erst, wenn die bestandsändernden Aktionen diese Regel durchsetzen. Grids ist kein fertiges ERP, Buchhaltungssystem oder Zahlungsdienst.

## In Abhängigkeitsreihenfolge aufbauen {icon="route"}

:::steps
1. **Entscheidungen festlegen.** Halte für jede Aktion fest, wer sie ausführen darf, welche aktuellen Voraussetzungen gelten, was gemeinsam geändert wird und woran du den Abschluss erkennst.
2. **Tabellen und Felder anlegen.** Ergänze Relationen nach ihren Zieltabellen, danach Berechnungen. Speichere Preis- und Steuerdaten direkt, wenn spätere Quellenänderungen den Geschäftsvorgang nicht verändern dürfen.
3. **Repräsentative Datensätze ausprobieren.** Berücksichtige fehlende Angaben, mehrere Positionen und einen Fall, der abgelehnt werden muss.
4. **Formulare und Workflows ergänzen.** Formulare erfassen Eingaben; Aktionen prüfen Übergänge wie Ausgabe, Rückgabe, Freigabe und Versand. Schließe Statusfelder von der gewöhnlichen App-Bearbeitung aus. Prüfe unter **Tabelleneinstellungen → Datenintegrität → Datensatzänderungen** auch andere Schreibwege.
5. **Die App für die Zielgruppe bauen.** Stelle eine Aufgabenliste, eine Datensatzdetailseite, ein Erstellungsformular sowie passende Aktionen und Dokumente bereit. Folge für die Seitenkonfiguration **Erste Grids App erstellen**.
6. **Zugriff prüfen und veröffentlichen.** Prüfe die Veröffentlichungsvorschau und teste den veröffentlichten Ablauf mit einem Konto jeder vorgesehenen Zielgruppe.
:::

Base-Lesezugriff zeigt jeden Datensatz der Base. Persönliche Ansichten und versteckte Navigation trennen Kunden oder Mitarbeitende nicht voneinander. Teile getrennte Grids Apps für Zielgruppen mit engerem Zugriff. Verwende serverseitig durchgesetzte Abfragen und Verfügbarkeitsregeln für Listen, Detailseiten, Formulare und Aktionen. Teste im CRM-Portal eine kopierte Detail-URL zu einer Verkaufschance eines anderen Kunden. Erteile keinen Base-Zugriff, nur damit das Portal funktioniert.

Binde vor dem Veröffentlichen einer App-Aktion alle Workflow-Pflichteingaben. Ein fester Launcher liefert seine gespeicherten Bindungen; bei `inputMode: prompt` muss die App-Aktion die Pflichteingaben liefern. Dieser Modus öffnet in der App keinen freien Eingabedialog. Die Ausleihseite der Inventarvorlage zeigt beispielsweise verfügbare Gegenstände mit einer Zeilenaktion zum Hinzufügen einer Ausleihposition: Sie bindet `item` an `ROW.id` und `loan` an `RECORD.id` der Seite. Die gewählte Zeile liefert den Gegenstand, ohne der lesenden Person eine allgemeine Datensatzauswahl der Base zu öffnen.

## Übergaben und Versand sicher wiederholen {icon="repeat"}

Lege für Geräteausleihen pro Gegenstand eine Position an. Die Ausgabe muss die aktive Ausleihe, die ausgabefähige Position und den verfügbaren Gegenstand prüfen und diese Position als aktuelle Belegung des Gegenstands eintragen. Die Rückgabe muss genau diese Belegung prüfen, bevor sie sie aufhebt. Eine alte Ausleihe darf niemals einen inzwischen erneut ausgeliehenen Gegenstand zurückgeben. Erfasse den Rückgabezustand, damit beschädigte Gegenstände nicht verfügbar werden. Schließe eine Ausleihe erst ab, wenn ihre Positionen abgeschlossen sind.

Die Inventarvorlage liefert positionsbezogene Ausgabe- und Rückgabeaktionen. Ergänze Positionen, solange die Ausleihe noch angefragt ist, bevor du sie genehmigst. Prüfe die Aktionen vor einer Anpassung. Kits beschreiben angefragte Ausstattung; sie sichern keine Reservierungen für zukünftige Zeiträume.

Wenn zwei Personen dieselbe Aktion auslösen können, müssen deren Prüfungen und zusammengehörige Datensatzänderungen gemeinsam gelingen. Workflows bieten dafür `atomicRecords` mit begrenztem Umfang; mehrere gewöhnliche Änderungsschritte bilden keine gemeinsame Transaktion. Konkurrierende Aktionen müssen denselben bestehenden Datensatz zur Koordination verwenden. Details zum Erstellen stehen unter **Workflows**.

Vor Dokumenterzeugung oder E-Mail-Versand sollte eine Aktion einen bereiten Versand übernehmen und als in Bearbeitung markieren. Nur dieser Vorgang fährt fort. Ein Wiederholungsschlüssel identifiziert einen Aufruf; zwei unabhängig gestartete Anfragen benötigen trotzdem dieselbe Prüfung des Geschäftszustands. Markiere den Versand erst nach Abschluss seiner Schritte als abgeschlossen. Bleibt er in Bearbeitung, prüfe den ursprünglichen Lauf, die Dokumente und die E-Mail-Zustellung vor einem neuen Versuch. Abbrechen macht eine E-Mail oder ein erzeugtes Dokument nicht rückgängig.

## Rechnungen bewahren und Auslagen prüfen {icon="file-invoice"}

Erzeugte Dokumente behalten ihren ursprünglichen Snapshot und die exakten Dateien. Änderungen an Quelldatensätzen schreiben ein ausgestelltes Dokument nicht um; erneutes Erzeugen erstellt ein weiteres Dokument. Wenn auch die Quelldatensätze gesperrt werden müssen, konfiguriere deren Finalisierung. Die Finalisierung eines Rechnungskopfs finalisiert seine Positionsdatensätze nicht rekursiv. Halte Versand- und Zahlungsänderungen in getrennten operativen Datensätzen, wenn die Rechnung selbst finalisiert ist.

Eine HTML-Rechnungsvorlage ist keine E-Rechnung. Wähle einen installierten E-Rechnungsrenderer und prüfe vor der Nutzung seine unterstützten Währungs-, Steuer-, Adress- und Korrekturfälle. Prüfe sowohl das lesbare Dokument als auch die strukturierte Datei. Der Rechnungsaussteller bleibt für den Inhalt verantwortlich; technische Validierung ist keine steuerliche oder rechtliche Freigabe. Die Buchhandlungsvorlage zeigt Rechnungen, wickelt aber keine Zahlungen ab.

Binde bei Auslagen die angemeldete anspruchstellende Person fest im Formular, statt die Auswahl einer anderen Identität zu erlauben. Die Vier-Augen-Finalisierung verlangt eine andere Person als diejenige, die die Finalisierung angefragt hat. Sie vergleicht kein separates Anspruchstellerfeld: Reicht jemand stellvertretend ein, musst du die Selbstfreigabe durch die anspruchstellende Person weiterhin gesondert ausschließen.

Die Prüfung gilt für die genaue Datensatzversion. Änderungen an Werten, Relationen oder angehängten Dateien dieses Datensatzes machen seine offene Anfrage ungültig. Die Bearbeitung eines verknüpften Positionsdatensatzes ist nicht dieselbe Änderung wie die Bearbeitung des geprüften Datensatzes. Lege fest, welche Datensätze und Belegversionen zur Einreichung gehören, und stelle sicher, dass eine veränderte Einreichung erneut geprüft werden muss. Eine Kopffreigabe genehmigt keine späteren Positionsänderungen. Unter **Tabellen & Felder** stehen die Zugriffsanforderungen und dauerhaften Einstellungen für Historie und Finalisierung.

Ein Bezahlt-Kontrollkästchen überweist kein Geld. Zahlungsausführung benötigt ein ausdrücklich angebundenes Zahlungssystem, eine stabile Zahlungsreferenz und einen geprüften Umgang mit doppelten oder ungewissen Anfragen. Eine ungewisse HTTP-Wirkung muss vor einem weiteren Versuch mit diesem System geklärt werden. Die Finanzvorlage erfasst Transaktionen und Belegversand; sie ist kein Erstattungsprozess mit Antragstellung und Freigabe.

## Den gesamten Ablauf prüfen {icon="checklist"}

Teste eine leere Liste, eine normale Einreichung, eine veraltete Bearbeitung sowie fehlende oder unzugängliche Datensatz-IDs. Wiederhole den Ablauf nach Neuladen und über eine kopierte Detail-URL. Probiere zwei unabhängige Ausgabe-, Versand- oder Zahlungsanfragen aus und prüfe einen unterbrochenen Vorgang. Teste bei Auslagen außerdem Selbstfreigabe und nach der Prüfung geänderte Belege oder Positionen.

Halte fest, was bestanden hat und was ungeprüft bleibt. Bewahre den App-Link, die zuständige Person und Wiederherstellungsanweisungen beim Prozess auf. Ein gültiger App-Entwurf allein beweist weder Zugriffstrennung noch sichere Wiederholungen oder korrekte Zahlungen.

Weiterführend: [Erste Grids App erstellen](/app/grids/help/grids-build-custom-app), [Workflows](/app/grids/help/grids-workflows), [Dokumente & PDFs](/app/grids/help/grids-documents-pdfs) und [Tabellen & Felder](/app/grids/help/grids-tables-fields).
