---
id: pulse-start
title: Mit Pulse beginnen
icon: ti ti-activity-heartbeat
kind: start
description: Erstelle eine Base, verbinde eine Quelle und prüfe den Empfang.
order: 100
---
Pulse sammelt Metriken, Ereignisse und Zustände in Bases. Öffne eine Base, um Quellen einzurichten und eingehende Daten zu prüfen.

Öffne **Pulse** über das App-Menü. In der App-Leiste ist Pulse standardmäßig ausgeblendet. Wenn du Pulse dort eingeblendet oder angeheftet hast, bleibt deine Auswahl erhalten.

## Lies eine Base

Eine Base öffnet **Quellen**. Der Kopf hat vier Tabs: **Quellen**, **Daten**, **Nutzung** und **SQL**. Am Ende des Kopfs stehen **Mit Gustav auswerten**, **…** und **Quelle anlegen**. **Quelle anlegen** siehst du nur mit Zugriff **Bearbeiten**.

- **Quellen** sagt dir, ob Daten ankommen. Die erste Zeile sagt „Alle 4 Quellen empfangen“ oder wie viele Quellen Aufmerksamkeit brauchen. Darunter stehen Quellen mit abgelehnten Anfragen, Fehlern, Drosselung oder verspäteten Daten und ausgelöste Alarme. Danach folgen alle Quellen mit Zustand und letztem Eingang. Wähle eine Zeile, um ihre Details rechts zu öffnen.
- **Daten** zeigt die Datenarten der Base: Ereignisse, Messwerte und Zustände. Wähle eine Datenart, um ihre Felder mit Typ, Beispiel und Füllgrad und die fünf neuesten Einträge zu sehen. Vertrauliche Ereignisdaten zeigt Pulse hier nie.
- **Nutzung** zeigt die Code-Seiten und Automationen, die die Base in den letzten 30 Tagen gelesen haben und die du öffnen darfst. Die übrigen erscheinen nur als Zahl. Wer die Base verwaltet, sieht auch die Dienstkonten und Quellen-Schlüssel, die über die API zugreifen.
- **SQL** führt eine Abfrage aus und zeigt Tabelle und Zeitdiagramm. **Mit Gustav auswerten** beginnt dann mit deinem SQL.

Die Details einer Quelle beginnen mit **Was nicht ankommt**, wenn Pulse Anfragen ablehnt oder ein Abruf fehlschlägt. Der Grund steht in Worten da. **Eingang** zeigt die neuesten Daten und was Pulse erwartet. Schlüssel sehen nur Personen, die die Base verwalten.

Eine Alarm-Zeile öffnet den Alarm: Bedingung in Worten, Wert und seit wann er ausgelöst ist. **Mit Gustav anpassen** öffnet einen nicht gesendeten Entwurf mit dem SQL des Alarms.

Ist der Datenspeicher nicht erreichbar, sagt es die erste Zeile. Pulse prüft alle 30 Sekunden erneut, solange die Seite sichtbar ist. Die Zeilen zeigen den letzten bekannten Stand.

**…** enthält die Einstellungen der Base. Bis zum nächsten Release enthält es auch **Übersicht** und **Dashboards**.

## Verbinde eine Quelle

Pulse braucht einen verbundenen Datenspeicher. Wenn **Pulse ist noch nicht eingerichtet** erscheint, wende dich an die Cloud-Administration.

:::steps
1. Wähle **Neue Basis** und gib einen Namen für dein Produkt, deine Umgebung oder deinen Geschäftsbereich ein.
2. Öffne die Base und wähle **Quelle anlegen**.
3. Wähle einen Metrik-Endpunkt oder eine HTTP-Ingest-Quelle und speichere sie.
4. Öffne die Quelle, um den neuesten Datenzeitpunkt, Fehler und den Abrufverlauf zu prüfen.
:::

Eine Metrikquelle ruft einen Prometheus-Endpunkt im eingestellten Intervall ab.
Eine HTTP-Ingest-Quelle nimmt Batches mit einem API Key der Quelle an.
Erstelle benannte Schlüssel unter **API Keys** in den Quellendetails. Bewahre sie im Geheimnisspeicher deines Datenlieferanten auf.

## Wähle die Metriken für den Abruf

Bei Metrikquellen nimmt **Nur diese Metriken (leer = alle)** Familiennamen oder Präfixe mit abschließendem `*` an.
Trenne Einträge mit Kommas oder Zeilenumbrüchen. Ein leeres Feld schließt alle Familien ein.
Ausgeschlossene Familien zählen nicht gegen die Grenzen für Messwerte oder Reihen.

Die Quelle zeigt abgelehnte Histogramme, übersprungene Summary-Messwerte und kürzliche Drosselung.
Nutze diese Angaben, um den Endpunkt zu korrigieren oder weniger Metriken auszuwählen.

## Lies Messdaten mit SQL

Zugriff **Ansehen** erlaubt Abfragen in einer Base. Zugriff **Bearbeiten** erlaubt das Speichern und Löschen von Abfragen.
Nutze `cld pulse sql --base <base> --file query.sql`, um SQL auszuführen.
Nutze `cld pulse queries list --base <base>`, um gespeicherte Abfragen zu finden.
Lies `cld pulse reference sql.md` für Parameter und Exportformate.

Übergib Werte mit `--param name=value`. Halte SQL-Text und Werte getrennt.
Strg-C bricht eine laufende Abfrage ab. Wenn Pulse ausgelastet ist, warte die angegebene Zeit vor dem nächsten Versuch.
Ein Ergebnis mit 10.000 Zeilen hat die Grenze erreicht. Es kann weitere Zeilen geben.
Verkürze den Zeitraum oder gruppiere die Daten, um eine vollständige Antwort zu erhalten.

Öffne **SQL** in einer Base, um eine Abfrage auszuführen, Tabelle und Zeitdiagramm zu sehen oder eine gespeicherte Abfrage zu öffnen. **Mit Gustav auswerten** öffnet einen nicht gesendeten Entwurf mit Base, SQL und Parameterwerten. Die Einstellungen unter **…** öffnen ein Modal mit Allgemein, Mitglieder, Aufbewahrung, Nutzung und Grenzen sowie Leeren und löschen.
