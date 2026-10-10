---
id: grids-build-business-app
title: Eine Geschäfts-App aufbauen
icon: ti ti-building-store
description: Richte Inventar, Ausleihen, CRM, Rechnungen und Erstattungen an der Arbeit aus, die Personen erledigen müssen.
order: 107
---
Beginne mit einem vollständigen Ablauf. Zum Einrichten brauchst du Zugriff **Verwalten** auf die Base. Vorlagen sind bearbeitbare Beispiele, nicht deine Geschäftsregeln.

## Die benötigten Datensätze wählen {icon="table"}

Jede Vorlage enthält Workflows, Dokumentvorlagen und veröffentlichte Apps. Aktualisierungen einer Vorlage gelten nur für neue Bases. Bestehende Bases behalten ihre Konfiguration und ihre Daten.

- **Buchhandlung:** Beginne bei den Bestellungen und ergänze Positionen direkt in der Bestellung. Katalog und Kunden haben eigene Bereiche. Der Kopf zeigt den Versandstatus. **Nächster Schritt** bietet Versand, Abholung oder Abschluss an, je nachdem, was die Bestellung braucht. Kurze Formulare zum Erstellen und Bearbeiten öffnen sich im Dialog. Der Versand der Bestellübersicht ist optional und ändert den Versandstatus nicht. Prüfe vorher die gespeicherten Verkaufspreise. Spätere Änderungen am Katalog ändern weder diese Preise noch vorhandene Dokumente.
- **Private Finanzen:** Erfasse Einnahmen und Ausgaben, gleiche Transaktionen mit deiner Bank ab und vergleiche die Ausgaben des aktuellen Monats mit seinem Budget. Der Belegversand ist optional und markiert eine Transaktion nicht als abgeglichen. Umbuchungen zählen weder als Einnahme noch als Ausgabe. Die Vorlage synchronisiert keine Kontostände.
- **Inventar:** Ausleihende wählen mehrere Sets und Einzelgeräte in einer Anfrage und verfolgen ihre eigenen Anfragen. Eine Anfrage braucht mindestens ein Set oder Einzelgerät. Das Team gibt Einzelgeräte ausdrücklich für den Katalog frei. Es nutzt eine eigene App für die Ausleihverwaltung, für Vorbereitung, Übergabe und Rücknahme. Die Ausgabe startet die physische Ausleihe. Der Versand der Vereinbarung ist optional. Rückgaben funktionieren über die Detailseite eines Geräts und über einen Scanner.
- **Rechnungswesen:** Erstelle Rechnungen, Korrekturen und Provisionsgutschriften und stelle sie aus. Erfasse danach tatsächliche Zahlungen. Folge dem Ablauf für Rechnungswesen weiter unten.

Buchhandlung und Private Finanzen dienen jeweils einer arbeitenden Zielgruppe. Inventar trennt Ausleihende vom Team, weil sie unterschiedliche Datensätze und Aktionen brauchen. Teile mit diesen Zielgruppen die passende App, statt ihnen direkten Zugriff auf die Base zu geben.

Teile **Geräteausleihen** mit Ausleihenden. Teile die **Ausleihverwaltung** nur mit dem Team, das sich um Geräte und Anfragen kümmert. Die Vorlage weist diese Zielgruppen nicht automatisch zu. Kommentare zur Ausleihe sieht auch die anfragende Person. Nutze für interne Notizen das separate Feld **Admin-Notizen**.

| Deine Aufgabe | Beginne mit | Erste Prüfung |
| --- | --- | --- |
| Geräte auflisten | Gegenstände und Standorte; Kategorien bei Bedarf | Jeder physische Gegenstand hat einen eigenen stabilen, eindeutigen Code |
| Geräte ausleihen | Gegenstände, Ausleihen und Ausleihpositionen | Eine Position verbindet einen Gegenstand mit einer Ausleihe und dokumentiert Ausgabe und Rückgabe |
| Kunden und Vertrieb verfolgen | Organisationen, Kontakte, Verkaufschancen und Aktivitäten | Verantwortliche Person und Kunde sind eindeutig |
| Rechnungen ausstellen | Kunden, Rechnungen und Rechnungspositionen | Menge, Preis, Steuer und Kundendaten passen zur beabsichtigten Rechnung |
| Auslagen erstatten | Anträge, Antragspositionen, Belegdateien und Zahlungsreferenzen | Anspruchstellende Person, geprüfte Daten und Zahlungsnachweis sind unterscheidbar |

Eine Inventarliste braucht Felder, Datensätze und Ansichten. Ergänze Ausleihen für Übergaben und Rückgaben. Nutze erzeugte oder eindeutige Codes als fachliche Kennungen. Nutze Principal-Felder für Cloud-Personen und -Gruppen. Kundenrelationen geben keinen Zugriff.

Lege für eine Warenwirtschaft den Umfang von Einkäufen, Wareneingängen, Bestellungen, Lieferungen, Teilrückgaben und Bestand fest. Angezeigte Summen reservieren keinen Bestand. Aktionen, die den Bestand ändern, müssen gleichzeitige Überbuchung verhindern. Grids ist kein fertiges ERP, kein Buchhaltungssystem und keine Zahlungsintegration.

## In der Reihenfolge der Abhängigkeiten aufbauen {icon="route"}

:::steps
1. **Lege Entscheidungen fest.** Lege fest, wer handeln darf, welche Voraussetzungen gelten, welche Änderungen gemeinsam geschehen müssen und wann der Vorgang abgeschlossen ist.
2. **Lege Tabellen und Felder an.** Ergänze Relationen, sobald ihre Zieltabellen existieren. Ergänze danach Berechnungen.
3. **Speichere Preise und Steuern.** Speichere Preis- und Steuerdaten dort, wo spätere Änderungen an der Quelle den Geschäftsvorgang nicht ändern dürfen.
4. **Probiere Datensätze aus.** Teste fehlende Angaben, mehrere Positionen und einen abgelehnten Fall.
5. **Ergänze Formulare und Workflows.** Formulare erfassen Eingaben. Aktionen setzen Übergänge wie Ausgabe, Rückgabe, Genehmigung und Versand durch.
6. **Schütze Statusfelder.** Halte sie aus der normalen Bearbeitung in der App heraus. Prüfe **Tabelleneinstellungen → Datenintegrität → Datensatzänderungen**, um andere Schreibwege zu steuern.
7. **Baue die App.** Ergänze eine Aufgabenliste, Datensatzdetails, ein Erstellformular, Aktionen und Dokumente. Siehe [Erste Grids App erstellen](/app/grids/help/grids-build-custom-app).
8. **Prüfe den Zugriff und veröffentliche.** Prüfe die Vorabprüfung zur Veröffentlichung. Teste den veröffentlichten Ablauf mit einem Konto jeder vorgesehenen Zielgruppe.
:::

Zugriff **Ansehen** auf eine Base zeigt alle Datensätze. Persönliche Ansichten und ausgeblendete Navigation trennen Zielgruppen nicht. Teile für engeren Zugriff Grids Apps mit serverseitigen Abfragen und Verfügbarkeitsregeln für Listen, Details, Formulare und Aktionen. Teste die kopierte URL einer Verkaufschance eines anderen Kunden. Gib keinen direkten Zugriff auf die Base, nur damit ein Portal funktioniert.

Binde vor dem Veröffentlichen alle Pflichteingaben der Workflows. Feste Launcher nutzen gespeicherte Bindungen. `inputMode: prompt` verlangt App-Eingaben, öffnet aber keinen freien Dialog. In Inventar bindet die Zeilenaktion zum Hinzufügen einer Ausleihposition `item` an `ROW.id` und `loan` an `RECORD.id`. So braucht sie keine allgemeine Datensatzauswahl der Base.

## Übergaben und Versand sicher wiederholbar machen {icon="repeat"}

Erstelle je Gegenstand eine Ausleihposition. Die Ausgabe prüft eine genehmigte oder aktive Ausleihe, eine zulässige Position und einen verfügbaren Gegenstand. Danach speichert sie die Belegung und startet die Ausleihe. Die Rückgabe muss zur Ausgabe passen: Eine alte Ausleihe kann keinen neu verliehenen Gegenstand zurückgeben. Erfasse Schäden, bevor du Gegenstände wieder verfügbar machst. Schließe eine Ausleihe erst ab, wenn alle ihre Positionen abgeschlossen sind.

Inventar liefert Aktionen für Ausgabe und Rückgabe. Prüfe sie, bevor du sie anpasst. Ergänze Positionen, bevor du eine angefragte Ausleihe genehmigst. Sets beschreiben Ausstattung. Künftige Reservierungen setzen sie nicht durch.

Nutze `atomicRecords` für begrenzte Prüfungen und Änderungen, die gemeinsam gelingen müssen. Einzelne Änderungsschritte sind keine gemeinsame Transaktion. Konkurrierende Aktionen müssen sich über denselben bestehenden Datensatz abstimmen. Siehe [Workflows](/app/grids/help/grids-workflows).

Übernimm einen bereiten Versand, bevor du Dokumente erzeugst oder E-Mails sendest. Ein Wiederholungsschlüssel identifiziert einen Aufruf. Unabhängige Anfragen brauchen trotzdem eine gemeinsame Prüfung des Geschäftszustands. Schließe den Versand erst ab, wenn alle seine Schritte fertig sind.

:::warning Abbrechen macht Versendetes nicht rückgängig
Ein Abbruch macht gesendete E-Mails und erzeugte Dokumente nicht rückgängig. Hängt ein Versand, prüfe den ursprünglichen Lauf, die Dokumente und die E-Mail-Zustellung, bevor du es erneut versuchst.
:::

Wird ein Versand aus einer Vorlage unterbrochen, prüft eine Person mit Zugriff **Verwalten** auf die Base den ursprünglichen Lauf unter **Workflows**. Kläre die Zustellung dort, bevor du den Versandstatus in der Tabelle der Base zurücksetzt. Die App bietet bewusst keinen ungeprüften erneuten Versand an.

## Rechnungen bewahren {icon="file-invoice"}

Erzeugte Dokumente behalten ihren ursprünglichen Snapshot und ihre exakten Dateien. Änderungen an den Quellen schreiben sie nicht um. Eine wiederholbare Vorlage erzeugt ein weiteres Dokument. Eine Vorlage, die je finalisiertem Datensatz einmal läuft, liefert das vorhandene Dokument. Ein Rechnungskopf finalisiert verknüpfte Positionen nicht rekursiv. Objektlistenpositionen gehören zum Kopf und werden mit ihm eingefroren. Erfasse spätere Zahlungen in eigenen Datensätzen.

## Mit Rechnungswesen beginnen {icon="file-invoice"}

Die Vorlage **Rechnungswesen** bietet Rechnungen, Korrekturen und Provisionsgutschriften in EUR. Sie deckt unterschiedliche deutsche Geschäftspartner mit deutscher USt-IdNr. und 7 % oder 19 % USt ab. Andere Fälle brauchen ein anderes Modell oder einen anderen Renderer.

:::steps
1. Lass eine Person mit Zugriff **Verwalten** auf die Base unter **Base-Einstellungen → Dokumente** echte Unternehmens- und Bankdaten eintragen. Die Beispieldatensätze sind Entwürfe.
2. Erstelle eine Rechnung. Wähle oder erstelle ihren Partner und erfasse die Objektlistenpositionen.
3. Prüfe Summen, Leistungsdatum und Fälligkeitsdatum, bevor du ausstellst.
4. Wähle **Rechnung ausstellen** auf der gespeicherten Dokumentseite. Während Grids das PDF erstellt, kannst du weiterarbeiten.
5. Wähle nach einem Renderfehler **Erstellung fortsetzen**. Dokument, Unternehmensdaten und Nummer bleiben gleich.
6. Wähle am Beleg **Zahlungseingang erfassen**, **Auszahlung erfassen** oder **Erstattung erfassen**.
7. Trage im Dialog das tatsächliche Datum und den Betrag ein und sende einmal ab.
:::

`REF-…` ist eine interne Referenz, keine Rechnungsnummer. Das Erfassen einer Zahlung schreibt sie zugleich fest. Der Saldo aktualisiert sich sofort. Das Erfassen führt keine Überweisung aus. Bereits vorhandene ungeprüfte Einträge müssen weiterhin geprüft und bestätigt werden. Bis dahin ändern sie den Saldo nicht.

**Offene Zahlungen** gruppiert Zahlungen in **Überfällig**, **Heute oder später fällig** und **Überzahlungen prüfen**. Öffne einen fälligen Betrag, um eine Zahlung zu erfassen. Eine Überzahlung öffnet den ursprünglichen Beleg zur Prüfung. Nur bestätigte Zahlungen zählen in diesen Listen.

Wähle an einer finalisierten Rechnung **Als neue Rechnung übernehmen**, um einen neuen Entwurf mit Empfänger, Bestellreferenz und Positionen zu erstellen. Prüfe aktuelle Partnerangaben und Preise und wähle Leistungsdatum und Fälligkeit neu. Der neue Entwurf enthält keine Zahlungen, Korrekturen, internen Notizen oder ausgestellten Dateien.

Partner erhalten eine schreibgeschützte Kundennummer wie KD-00001, die innerhalb der Base eindeutig ist. Du findest sie in der Partnerliste, der Empfängerauswahl, den Partnerdetails und den Belegdetails. Eine Umbenennung behält die Nummer.

### Belege korrigieren und abrechnen

Bereite eine Korrektur von der ursprünglichen Rechnung aus vor. Reduziere für eine Teilkorrektur die kopierten Positionen. Prüfungen erhalten den verbleibenden Netto- und Steuerbetrag je Satz. Eine Provisionsgutschrift braucht eine Vereinbarungsreferenz und das Bankkonto des Empfängers. Erfasse ihre Positionen direkt und rechne dieselbe Verpflichtung nicht zweimal ab. **Entwurf verwerfen** verschiebt unfertige Belege in den Papierkorb. Für ausgestellte Belege gilt es nicht. Interne Notizen erscheinen nicht im PDF oder XML.

Eine Korrektur beginnt mit dem heutigen Belegdatum und ohne Fälligkeitsdatum. Prüfe beides vor der Ausstellung. Erfasse eine Kundenerstattung mit **Erstattung erfassen** an der ursprünglichen Rechnung, mit positivem Betrag. Die Bestätigung zieht die Erstattung von den Zahlungseingängen ab. Sie lehnt Beträge über der aktuellen Überzahlung ab, auch bei gleichzeitigen Bestätigungen. Eine Korrektur hat keinen eigenen Zahlungssaldo. Unbestätigte Zahlungen und Erstattungen kannst du verwerfen. Bestätigte bleiben unveränderlich.

HTML-Rechnungsvorlagen sind keine E-Rechnungen. Prüfe Währung, Steuer, Adresse und Korrekturumfang des installierten Renderers und beide Ausgabedateien. Der Aussteller bleibt verantwortlich. Eine Validierung ist keine steuerliche oder rechtliche Genehmigung. Buchhandlung versendet Bestellübersichten. Nutze Rechnungswesen für Rechnungen.

## Auslagen prüfen {icon="checklist"}

Lege bei Auslagen die angemeldete anspruchstellende Person im Formular fest. Lass Personen keine andere Identität wählen. Die Vier-Augen-Finalisierung verlangt eine andere Person als die, die die Finalisierung angefragt hat. Sie vergleicht kein separates Anspruchstellerfeld. Reicht jemand für die anspruchstellende Person ein, musst du trotzdem durchsetzen, dass sie ihren eigenen Antrag nicht genehmigt.

Eine Prüfung gilt für eine genaue Datensatzversion. Änderungen an ihren Werten, Relationen oder Dateien machen ihre offene Anfrage ungültig. Änderungen verknüpfter Positionen tun das nicht. Lege fest, welche Datensätze und Belegversionen eine Einreichung enthält, und verlange nach Änderungen eine neue Prüfung. Eine Genehmigung des Kopfs genehmigt keine späteren Positionsänderungen. [Tabellen und Felder](/app/grids/help/grids-tables-fields) beschreibt den Zugriff und die dauerhaften Einstellungen für Verlauf und Finalisierung.

Ein Bezahlt-Kontrollkästchen überweist nichts. Eine Zahlungsausführung braucht ein angebundenes System, stabile Referenzen und eine Behandlung doppelter oder ungewisser Anfragen. Kläre ungewisse HTTP-Wirkungen in diesem System, bevor du es erneut versuchst. Private Finanzen erfasst Transaktionen und Belegversand. Erstattungen an Antragstellende nach einer Genehmigung deckt die Vorlage nicht ab.

## Den gesamten Ablauf prüfen {icon="checklist"}

:::steps
1. Teste eine leere Liste, eine normale Einreichung, eine veraltete Bearbeitung und fehlende oder unzugängliche Datensatz-IDs.
2. Wiederhole den Ablauf nach dem Neuladen und über eine kopierte Detail-URL.
3. Probiere zwei unabhängige Anfragen für Ausgabe, Versand oder Zahlung aus.
4. Prüfe einen unterbrochenen Vorgang.
5. Teste bei Auslagen die Selbstgenehmigung und Belege oder Positionen, die sich nach der Prüfung ändern.
:::

Halte Ergebnisse, Unsicherheiten, den App-Link, die zuständige Person und die Wiederherstellungsschritte fest. Ein gültiger Entwurf beweist weder Isolation noch sichere Wiederholungen oder korrekte Zahlungen.

Weiter mit [Erste Grids App erstellen](/app/grids/help/grids-build-custom-app), [Workflows](/app/grids/help/grids-workflows), [Dokumente und PDFs](/app/grids/help/grids-documents-pdfs) und [Tabellen und Felder](/app/grids/help/grids-tables-fields).
