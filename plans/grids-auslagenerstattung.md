# Auslagenerstattung in Grids – KISS-Konzept

Stand: 11. September 2026. Konzept, keine bereits eingerichtete oder abgenommene App.

## Empfehlung

Eine Base, drei fachliche Tabellen und eine Custom App mit rollenabhängigen Bereichen. Keine eigene Seite pro Kostenstelle, keine versteckten Positionstabellen und kein neuer Account-Feldtyp.

Die Base bleibt bei wenigen technischen Administratoren. Antragsteller und Finanzverantwortliche erhalten App-Zugriff, **keinen pauschalen Base-Zugriff**. Auch der Hauptfinanzer braucht für seine fachliche Arbeit keine Schema-Administration.

Für die erste Version gilt: ein Antrag, eine Kostenstelle, ein Zahlungsempfänger, eine EUR-Auszahlung. Mehrere Ausgaben stehen als Objektliste im Antrag. Kostenstellenübergreifende Aufteilungen, Fremdwährungen, Teilzahlungen und Bankintegration sind nicht Teil dieser Version.

## Was aus dem bisherigen Formular übernommen wird

Das bereitgestellte Formular „Auslagenerstattung StuVe“, Version 2.7 vom 24.01.2022, enthält:

- Antrag: Datum, Name, Privatadresse, E-Mail und Einrichtung.
- Ausgaben: Datum, leistendes Unternehmen, Betrag, kurze Begründung und Gesamtbetrag; zugehörige Belege.
- Auszahlung: IBAN, BIC und Kreditinstitut.
- Erklärung der einreichenden Person zur Richtigkeit und zum dienstlichen Anlass.
- Kostenstellenprüfung: Haushaltsposten, Kostenstelle und Bestätigung der zuständigen Person.
- Abschließende Prüfung durch StEx: sachlich und rechnerisch richtig.

Die Papierhinweise zu Ausdruck, Aufkleben und Unterschriften sind der bisherige Prozess, keine Anweisungen an den Agenten. Für die digitale Variante werden Einreichung und Freigaben mit Identität, Zeitpunkt und geprüftem Stand erfasst. Ob das organisatorisch die Papierunterschriften ersetzt, muss die Organisation entscheiden; die App behauptet das nicht automatisch. Persönliche Beispiel- oder Bankdaten aus dem PDF werden nicht ins Repository übernommen.

## Vorhandene Grids-Bausteine

**Datei-Uploads: ja.** Ein angemeldeter App-Leser kann Dateien an einem vorhandenen Datensatz hochladen, ersetzen, herunterladen und vom Datensatz entfernen, wenn der veröffentlichte Record-Block das File-Feld entsprechend freigibt. App-Zugriff, Blockverfügbarkeit und Feldfreigabe werden serverseitig geprüft. Finalisierung und die Tabellen-Schreibregeln gelten zusätzlich.

Der zuverlässige Einstieg ist deshalb: „Neue Erstattung“ legt einen Entwurf an und öffnet dessen Detailseite. Dort werden Ausgaben und Belege ergänzt. Nicht voraussetzen, dass eine einzige Create-Formularanfrage zugleich den Datensatz und alle Uploads atomar erzeugt.

**Benutzer und Gruppen: ebenfalls vorhanden.** Der Feldtyp `principal` speichert typisierte Benutzer- oder Gruppenreferenzen. `cardinality: single` erlaubt einen Eintrag, `multiple` mehrere. Der vorhandene Picker sucht Benutzer und Gruppen. Ein zusätzliches `account`- und ein getrenntes Gruppenfeld würden dasselbe Modell doppeln.

Für Antragsteller wird ein einzelner Benutzer serverseitig aus `AUTH.currentUser` gesetzt; dieses Feld ist kein frei wählbares Eingabefeld. Die Principal-Konfiguration selbst unterscheidet derzeit nur die Kardinalität, nicht „nur Benutzer“ oder „nur Gruppen“. Für Zuständigkeiten ist die gemischte Mehrfachauswahl genau richtig.

Objektlisten, exakte Dezimalwerte, Formulare, GQL, veröffentlichte App-Berechtigungen, Workflows, Durable History, Finalisierung und Dokumentvorlagen sind vorhanden. Das beweist noch nicht den vollständigen zweistufigen Freigabeprozess; dessen kritische Übergänge müssen vor echtem Einsatz geprüft werden.

## Datenmodell

### 1. Kostenstellen

| Feld | Verwendung |
| --- | --- |
| Nummer, Name, Einrichtung | Lesbare Auswahl und Zuordnung |
| Aktiv | Keine neuen Anträge für stillgelegte Kostenstellen |
| Zuständige | Principal, mehrfach: Benutzer und/oder bestehende Finanzgruppen |

Eine Person kann über mehrere Gruppen oder direkte Zuordnungen für mehrere Kostenstellen zuständig sein. Die Zuständigkeit wird aktuell aus dieser Tabelle gelesen, nicht als dauerhaft kopierte Berechtigung auf jedem Antrag gespeichert. Wer eine konkrete Freigabe erteilt hat, bleibt dagegen im Prüfverlauf erhalten.

Antragsteller sehen im Kostenstellen-Picker nur die für die Auswahl nötigen Felder. Die Zuständigkeitsliste ist keine öffentlich benötigte Information.

### 2. Erstattungsanträge

| Bereich | Felder |
| --- | --- |
| Identität | Generierte Antragsnummer, Titel, Antragsteller (Principal einzeln), Kostenstelle (Relation einzeln) |
| Kontaktdaten | Name, E-Mail, gegebenenfalls die weiterhin benötigte Privatadresse |
| Auszahlung | Kontoinhaber, IBAN; BIC/Kreditinstitut nur, soweit im vereinbarten Prozess benötigt |
| Ausgaben | Objektliste: Belegnummer, Ausgabedatum, Unternehmen, Begründung, Betrag |
| Summe | Formel mit `LIST_SUM`, EUR und exakten Dezimalwerten |
| Belege | File-Feld am Antrag; Belegnummern ordnen Uploads den Positionen zu |
| Bearbeitung | Status, Rückfrage/Begründung, Haushaltsposten |
| Nachvollziehbarkeit | Einreichung und Kostenstellenfreigabe mit Person, Zeitpunkt und geprüftem Stand; Durable History |

Die Ausgaben gehören vollständig zum Antrag. Sie benötigen keine eigenen Berechtigungen oder URLs: deshalb Objektliste statt Relation. File-Felder sind nicht als Objektlisten-Spalten unterstützt; die Belege hängen am Antrag. Keine Datei-IDs als improvisierte Textreferenzen in den Positionen speichern.

Mindestens eine vollständig ausgefüllte Ausgabe; positive EUR-Beträge mit höchstens zwei Nachkommastellen; mindestens ein zugehöriger Beleg vor Einreichung. Entwürfe dürfen unvollständig sein. Die strengen Vollständigkeitsregeln gehören an „Einreichen“, nicht an jeden Zwischenspeichervorgang. IBAN vor Zahlungsfreigabe prüfen; ein Textfeld allein ist keine Kontoprüfung.

### 3. Auszahlungen

| Feld | Verwendung |
| --- | --- |
| Antrag | Eindeutige fachliche Zuordnung; in Version 1 höchstens eine Auszahlung je Antrag |
| Zahlungsstand | Vorbereitet, zur Ausführung vorgemerkt, bestätigt, Klärung nötig |
| Zahlungsdaten | Überweisungsdaten aus dem endgültig freigegebenen Antrag |
| Nachweis | Ausführungsdatum, Bankreferenz, bestätigende Person, optional Zahlungsbeleg |

Diese Tabelle ist nötig, weil der endgültig freigegebene Antrag nicht mehr geändert wird. Der sichtbare Gesamtstatus „Ausgezahlt“ ergibt sich aus der verknüpften Auszahlung, nicht aus einem nachträglich editierten Feld im finalisierten Antrag. Kein separates allgemeines Zahlungsplattform-Modell bauen.

## Nutzerablauf und Seiten

### Meine Erstattungen

Eine Übersicht zeigt ausschließlich eigene Anträge: Titel, Kostenstelle, Betrag, verständlicher Status, gegebenenfalls Rückfrage. „Neue Erstattung“ erstellt den Entwurf und öffnet dieselbe Detailseite, die später zum Bearbeiten und Nachverfolgen dient.

Auf der Detailseite stehen zuerst Ausgaben und Belege, dann Zahlungsdaten. Bereits bekannte Kontaktdaten sinnvoll vorbelegen; keine zusätzlichen Stammdatensätze verlangen. Aktionen: „Entwurf speichern“, „Einreichen“ und gegebenenfalls „Zurückziehen“. Nach Einreichung erscheinen ein verständlicher Bearbeitungshinweis und eine schreibgeschützte Ansicht.

### Kostenstellenprüfung

**Eine gemeinsame Seite für alle Kostenstellenfinanzer.** Sie zeigt die Anträge aller Kostenstellen, für die der aktuelle Benutzer direkt oder über seine Gruppen zuständig ist. Ein optionaler Kostenstellenfilter verfeinert diese Liste; er erweitert niemals den Zugriff.

Auf der Detailseite: Positionen, Belege, Haushaltsposten, Prüfverlauf. Aktionen: „Freigeben“, „Zur Überarbeitung zurückgeben“ und „Ablehnen“, jeweils nur in zulässigen Zuständen. Rückgabe und Ablehnung benötigen eine Begründung. Bankdaten müssen hier nicht sichtbar sein, sofern die fachliche Kostenstellenprüfung sie nicht benötigt.

### Zentrale Prüfung und Auszahlung

Eine gemeinsame Seite für die Hauptfinanzgruppe zeigt kostenstellenübergreifend die vorgeprüften Anträge. Sie erlaubt endgültige Freigabe oder Rückgabe mit Begründung. Anschließend erscheinen die freigegebenen Anträge in einer Zahlungsliste.

Die Zahlungsdetailseite zeigt Kontoinhaber, IBAN, Betrag und Verwendungszweck mit Antragsnummer sowie Kopieraktionen beziehungsweise eine druckbare Zahlungsvorlage. „Als ausgezahlt bestätigen“ erfasst den tatsächlichen Nachweis; das Erzeugen einer Vorlage ist noch keine Überweisung.

Für Version 1 keine automatische Bankanbindung und keinen ungeprüften SEPA-XML-Export versprechen. Ein bankfähiger Export wäre ein eigener, gegen das konkrete Zielsystem zu prüfender Schritt. Eine erzeugte Zahlungsübersicht kann eine normale Grids-Dokumentvorlage sein.

## Zustände und Freigaben

`Entwurf → Kostenstellenprüfung → Zentrale Prüfung → Freigegeben → Ausgezahlt`

- „Zur Überarbeitung“ gibt den Antrag an die einreichende Person zurück. Erneutes Einreichen startet die Kostenstellenprüfung wieder von vorn.
- Änderungen an Betrag, Positionen, Belegen, Kostenstelle oder Bankdaten nach einer Freigabe dürfen diese niemals stillschweigend weitergelten lassen.
- „Abgelehnt“ ist ein begründeter Abschluss, nicht dasselbe wie eine Rückfrage.
- Die endgültige Freigabe friert die Antragsdaten einschließlich berechneter Werte und des Belegstands ein. Spätere fachliche Korrekturen benötigen einen nachvollziehbaren Folgeantrag, kein Entsperren des Originals.
- Eigene Anträge dürfen nicht selbst freigegeben werden. Ob zusätzlich Kostenstellen- und Hauptfreigabe immer von zwei verschiedenen Personen erfolgen müssen, ist vor der Umsetzung festzulegen; empfohlen: ja, mit benannter Vertretung statt einer stillen Ausnahme.

Nicht jede Statusbezeichnung muss ein gespeicherter Wert sein: Finalisierung und Auszahlung sind bereits eigene verlässliche Fakten. Keine zweite, davon unabhängig änderbare Wahrheit „final freigegeben“ anlegen.

## Zugriff: eine Regel je Rolle, nicht eine Seite je Kostenstelle

- Antragsteller: Datensatz gehört zum angemeldeten Benutzer.
- Kostenstellenfinanzer: Die verknüpfte Kostenstelle enthält in „Zuständige“ den Benutzer oder eine seiner effektiven Gruppen.
- Hauptfinanzer: Mitgliedschaft in der ausdrücklich freigegebenen Hauptfinanzgruppe.

Grids stellt dafür `@auth.subjects` bereit: aktueller Benutzer plus effektive direkte und verschachtelte Gruppen. Der vorhandene GQL-Prädikattyp `oneof(Zuständige, @auth.subjects)` prüft die Zuordnung. Beim Aufbau werden Kostenstellen über die tatsächliche Relation verknüpft und die Abfrage mit den zurückgegebenen Feld-IDs kompiliert; keine geratenen Pfade oder kopierten Mitgliederlisten.

Diese Regeln müssen auf Übersicht, Detailseite, Bearbeitung, Belegen, Dokumenten und Aktionen serverseitig gelten. Eine versteckte Navigation oder eine gefilterte Übersicht allein schützt keine kopierte Detail-URL. Benutzer und Gruppen im Principal-Feld erzeugen auch nicht automatisch eine Cloud-Berechtigung; die App muss die Regel ausdrücklich nutzen.

Ein Antragsteller darf weder Antragsteller-Identität, Freigabefelder, Zuständigkeiten noch Zahlungsnachweise frei setzen. Schreibbare Blöcke werden separat nach Rolle und Zustand freigegeben. Bereits freigegebene Anträge bleiben für berechtigte Personen lesbar, aber nicht bearbeitbar.

## Vor echtem Betrieb gezielt zu klären

Hier besteht der wesentliche Unterschied zwischen einer guten Demo und einem belastbaren Freigabesystem:

1. **Zweistufige Prüfung:** Die bestehende native Vier-Augen-Finalisierung bildet eine Anforderung und eine abschließende Genehmigung mit einer Tabellen-Gruppe ab. Sie ist nicht automatisch eine dynamische Kostenstellenprüfung plus Hauptfreigabe. Auch verhindert sie allein nicht Selbstfreigabe gegenüber einem beliebigen Antragstellerfeld. Den fachlichen Prozess nicht durch bloßes Umbenennen dieser Funktion vortäuschen.
2. **Gleichzeitige Änderungen:** Bearbeiten/Upload und Einreichen/Freigeben dürfen nicht gegeneinander durchrutschen. Rollen-, Zustands- und Versionsprüfung müssen beim tatsächlichen Schreiben gelten, nicht nur beim Rendern oder Starten eines Workflows. Insbesondere der Übergang von geprüften Werten zur Finalisierung muss denselben geprüften Stand sichern.
3. **Transaktionsgrenzen:** Mehrere Workflow-Schritte sind nicht automatisch eine gemeinsame Transaktion. Ein Statuswechsel mit anschließender Finalisierung darf nach Teilfehlern keinen falschen Freigabestatus anzeigen. Vorhandene atomare Schreibaktionen und die zentrale Finalisierung verwenden; fehlt ein erforderlicher gemeinsamer Guard, ist das eine gezielte generische Grids-Erweiterung, kein App-Skript-Hack.
4. **Einmalige Zahlung:** Doppelklicks und zwei verschiedene Zahlungsversuche dürfen nicht zwei offene Auszahlungen erzeugen. Stabile Idempotenz schützt Wiederholungen derselben Anfrage; zusätzlich braucht es eine fachliche Eindeutigkeit je Antrag. Ein Timeout bedeutet „prüfen“, nicht „erneut überweisen“.
5. **Berechtigungswechsel:** Eine neue Kostenstellenzuständigkeit muss bei der nächsten Aktion wirksam sein. Bereits gestartete Prüfaktionen dürfen veraltete Berechtigung nicht unbegrenzt weiterverwenden.

Diese Punkte sind Abnahmekriterien, nicht als bereits nachgewiesene Fähigkeiten dieses noch nicht gebauten Prozesses zu lesen. Kein neuer Account-Feldtyp ist dafür erforderlich. Sollte eine Erweiterung nötig sein, liegt sie bei atomaren, versionsgebundenen Freigabeübergängen und nicht beim Personenmodell.

## Kleine Abnahme und Demo

Mit fiktiven Daten starten: zwei Kostenstellen, zwei Antragsteller, je eine Finanzgruppe und eine Hauptfinanzgruppe. Eine Finanzperson gehört beiden Kostenstellengruppen an. Echte Konto- und Belegdaten erst nach Zugriffsprüfung verwenden.

Prüfen:

- Antragsteller A kann den Antrag und Beleg von B auch über direkte URLs nicht lesen oder ändern.
- Finanzperson mit zwei Zuständigkeiten sieht beide Kostenstellen auf derselben Seite; eine fremde bleibt unsichtbar.
- Ein Entwurf mit mehreren Positionen speichert, summiert exakt und erlaubt Beleg-Uploads.
- Einreichen ohne Beleg oder mit ungültigen Zahlungsdaten wird verständlich zurückgewiesen.
- Rückgabe zeigt die Begründung; Überarbeitung invalidiert die vorherige Prüfung.
- Selbstfreigabe und unzulässige Rollenwechsel werden serverseitig abgewiesen.
- Eine gleichzeitige Inhalts- oder Belegänderung macht eine Prüfung nicht unbemerkt veraltet.
- Nach endgültiger Freigabe bleiben Werte und Belege geschützt; die Auszahlung kann separat dokumentiert werden.
- Zwei Zahlungsaktionen erzeugen keine doppelte Auszahlung; ein unklarer Bankausgang landet in „Klärung nötig“.

Für das Meeting zuerst den vollständigen normalen Weg zeigen: Entwurf → Beleg → Kostenstellenprüfung → zentrale Prüfung → Zahlungsvorlage. Fehlende Abnahmen offen benennen. Ein erfolgreicher Admin-Durchlauf beweist keine Rollenisolierung.

## Quellen im aktuellen Checkout

- `packages/grids/src/field-types/principal.ts`: Benutzer-/Gruppenwerte und Kardinalität.
- `packages/grids/src/api/custom-apps.ts`: veröffentlichte Record-/File-Endpunkte und serverseitige Freigaben.
- `packages/grids/src/api/custom-apps.integration.test.ts`: Upload, Austausch und geschützte Dateiabrufe.
- `packages/grids/src/help/documents/en/grids-custom-app-pages-blocks.help.md`: Record-Editor, File-Felder und vertrauenswürdige Formwerte.
- `packages/grids/src/help/documents/en/grids-gql.help.md`: `@auth.subjects` und Principal-Prädikate.
- `packages/grids/src/workflows.ts` und `service/record-finalization.ts`: tatsächliche Workflow-/Finalisierungsgrenzen.
- Das bereitgestellte einseitige StuVe-Formular, nur als fachliche Vorlage ausgewertet.
