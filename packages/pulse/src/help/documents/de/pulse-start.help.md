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

Eine Base öffnet **Quellen**. Die Seitenleiste enthält **Quellen**, **SQL** und **Einstellungen**.

**Quellen** zeigt alle Quellen mit Zustand und neuesten Daten. Die Liste aktualisiert sich alle 5 Sekunden; Fokus und Scrollposition bleiben. Wähle eine Zeile, um ihre Details rechts zu öffnen. **Quelle** legt eine neue Quelle an; dafür brauchst du Zugriff **Bearbeiten**.

Über den Quellen steht **Braucht Aufmerksamkeit**, wenn Alarme ausgelöst sind oder sich nicht prüfen lassen. Kritische Alarme stehen zuerst, dann Warnungen, dann Alarme ohne Prüfung. Jede Zeile nennt die Bedingung in Worten, den Wert und seit wann der Alarm ausgelöst ist. **Mit Gustav anpassen** öffnet einen nicht gesendeten Entwurf mit dem SQL des Alarms. **SQL öffnen** öffnet das SQL des Alarms in der Konsole, ohne es auszuführen.

Ist der Datenspeicher nicht erreichbar, steht das über den Quellen. Pulse prüft alle 30 Sekunden erneut, solange die Seite sichtbar ist. Die Liste zeigt den letzten bekannten Stand.

Ein alter Dashboard-Link öffnet die Base mit dem Hinweis **Dashboards gibt es nicht mehr**. **Verstanden** schließt den Hinweis. Um anderen Zahlen oder Diagramme zu zeigen, bitte Gustav um eine Code-Seite, die diese Base liest. Die Seite zeigt Daten nur Personen, die die Base lesen dürfen.

## Verbinde eine Quelle

Pulse braucht einen verbundenen Datenspeicher. Wenn **Pulse ist noch nicht eingerichtet** erscheint, wende dich an die Cloud-Administration.

:::steps
1. Wähle **Neue Basis** und gib einen Namen für dein Produkt, deine Umgebung oder deinen Geschäftsbereich ein.
2. Öffne die Base und wähle **Quelle**.
3. Wähle einen Metrik-Endpunkt oder eine HTTP-Ingest-Quelle und speichere sie.
4. Öffne die Quelle, um den neuesten Datenzeitpunkt, Fehler und den Abrufverlauf zu prüfen.
:::

Eine Metrikquelle ruft einen Prometheus-Endpunkt im eingestellten Intervall ab.
Eine HTTP-Ingest-Quelle nimmt Batches mit einem API Key der Quelle an.
Unter **Neue Quelle** hilft **Mit KI fragen**, einen Adapter für deinen Shop oder einen anderen Dienst vorzubereiten.
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

Öffne **SQL** in einer Base, um eine Abfrage auszuführen, Tabelle und Zeitdiagramm zu sehen oder eine gespeicherte Abfrage zu öffnen. **Mit KI fragen** öffnet einen nicht gesendeten Entwurf mit Base, SQL und Parameterwerten. **Einstellungen** öffnet ein Modal mit Allgemein, Mitglieder, Aufbewahrung, Nutzung und Grenzen sowie Leeren und löschen.
