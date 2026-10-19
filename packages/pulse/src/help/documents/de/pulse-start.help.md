---
id: pulse-start
title: Mit Pulse beginnen
icon: ti ti-activity-heartbeat
kind: start
description: Erstelle eine Base, verbinde eine Quelle und prüfe den Empfang.
order: 100
---
Pulse sammelt Metriken, Ereignisse und Zustände in Bases. Öffne eine Base, um Quellen einzurichten und eingehende Daten zu prüfen.

## Verbinde eine Quelle

Pulse braucht einen verbundenen Datenspeicher. Wenn **Pulse ist noch nicht eingerichtet** erscheint, wende dich an die Cloud-Administration.

:::steps
1. Wähle **Neue Basis** und gib einen Namen für dein Produkt, deine Umgebung oder deinen Geschäftsbereich ein.
2. Öffne die Base und wähle **Quellen → Neue Quelle**.
3. Wähle einen Metrik-Endpunkt oder eine HTTP-Ingest-Quelle und speichere sie.
4. Öffne die Quelle, um den neuesten Datenzeitpunkt, Fehler und den Abrufverlauf zu prüfen.
:::

Eine Metrikquelle ruft einen Prometheus-Endpunkt im eingestellten Intervall ab.
Eine HTTP-Ingest-Quelle nimmt Batches mit einem API-Schlüssel der Quelle an.
Erstelle benannte Schlüssel unter **API-Schlüssel** in den Quellendetails. Bewahre sie im Geheimnisspeicher deines Datenlieferanten auf.

## Wähle die Metriken für den Abruf

Bei Metrikquellen nimmt **Nur diese Metriken (leer = alle)** Familiennamen oder Präfixe mit abschließendem `*` an.
Trenne Einträge mit Kommas oder Zeilenumbrüchen. Ein leeres Feld schließt alle Familien ein.
Ausgeschlossene Familien zählen nicht gegen die Grenzen für Messwerte oder Reihen.

Die Quelle zeigt abgelehnte Histogramme, übersprungene Summary-Messwerte und kürzliche Drosselung.
Nutze diese Angaben, um den Endpunkt zu korrigieren oder weniger Metriken auszuwählen.

## Stelle Fragen, sobald SQL verfügbar ist

**Dashboards und Fragen kommen zurück** erklärt, dass SQL-Fragen und neue Dashboards mit dem nächsten Update kommen.
Wähle **Zu den Quellen**, um jetzt den Empfang zu prüfen.
