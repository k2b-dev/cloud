---
id: pulse-operate
title: Empfang prüfen und eine Base wiederherstellen
icon: ti ti-lifebuoy
kind: reference
description: Prüfe den Quellenstatus, wiederhole Datenaufnahme sicher und repariere fehlgeschlagene oder gesperrte Bases.
order: 140
---
Öffne **Quellen**, wenn erwartete Daten fehlen. Prüfe die Quelle, bevor du die Base änderst oder leerst.

## Lies den Quellenstatus

:::reference
- **Neueste Daten:** Der letzte von der Quelle empfangene Zeitstempel. Vergleiche ihn mit der erwarteten Zeit.
- **Drosselung:** Grenzen für Werte oder Bytes haben den Empfang kürzlich gestoppt. Verkleinere den Batch oder warte die Wiederholungsfrist ab.
- **Abgelehnte Histogramme:** Eine Familie hat die Prüfung nicht bestanden. Prüfe ihre Buckets, Anzahl und Summe am Endpunkt.
- **Übersprungene Summaries:** Pulse speichert keine Prometheus-Summary-Messwerte. Wähle stattdessen unterstützte Metrikfamilien.
- **Fehler:** Prüfe den letzten Fehler und seinen Zeitpunkt. Der Abrufverlauf ergänzt Erfolg, empfangene Anzahlen, Dauer und Abschlusszeit.
:::

Bei einem internen Endpunkt lässt die Cloud-Administration dessen Host, Host:Port oder CIDR unter **Verwaltung → Pulse → Interne Ziele** zu.
Eine Änderung von Schema, Host oder Port löscht das gespeicherte Bearer-Token, sofern du keinen Ersatz angibst.

## Lege den erwarteten Datenempfang fest

Bei einer sendenden Quelle öffnest du **Bearbeiten → Erwartete Daten**. Wähle einen regelmäßigen Abstand in Sekunden, eine tägliche Uhrzeit oder **Keine Erwartung**. Tägliche Uhrzeiten gelten in der Zeitzone der Base. Die Erwartung bezieht sich auf den neuesten Datenzeitpunkt, nicht auf den letzten Kontakt. Sie kann nicht belegen, dass die Daten eines ganzen Tages vollständig sind.

Ändert jemand die Quelle während deiner Bearbeitung, behält Pulse deine Eingaben und sperrt weiteres Speichern. Schließe und öffne die Quelle erneut, um den aktuellen Stand zu prüfen. Bleibt das Ergebnis einer Neuanlage unklar, wähle **Quellen prüfen**, bevor du die Quelle erneut anlegst.

## Lade die Übersicht erneut

**Erneut versuchen** lädt eine fehlgeschlagene Übersicht neu. Bei einem Speicherausfall bleiben vorhandene Werte mit ihrem Zeitpunkt sichtbar; ein nicht verfügbarer Wert ist nicht null. Wurde dein Zugriff entfernt, bitte die Base-Administration um Zugriff. Ein erneuter Ladeversuch stellt ihn nicht wieder her.

## Erhalte Alarmmeldungen

Pulse prüft fällige Alarmregeln und die Aktualität der Quellen jede Minute, auch wenn niemand die Base geöffnet hat. Ein ausgelöster oder verschärfter Alarm, fehlende Daten, ein Prüfungsfehler oder die Rückkehr zum Normalzustand können Personen mit Zugriff **Verwalten** auf die Base benachrichtigen. Browser- und E-Mail-Zustellung richten sich nach deinen Cloud-Benachrichtigungseinstellungen. Wer den Zugriff **Verwalten** verliert, erhält auch keine bereits vorgemerkten Base-Alarme mehr.

Benachrichtigungen verwenden die Installationssprache zum Zeitpunkt des Ereignisses. Browsertext, E-Mail und spätere Zustellversuche behalten diese Sprache. Eine Änderung der Installationssprache gilt für neue Ereignisse.

## Wiederhole HTTP-Datenaufnahme sicher

Sende Batches an `POST /api/pulse/ingest` mit dem Quellentoken als Bearer-Zugang.
Sende einen `Idempotency-Key` ab dem ersten Versuch. Behalte Inhalt und Schlüssel für Wiederholungen unverändert.

:::reference
- **Batchgröße:** Höchstens 500 Metriken, 500 Ereignisse und 500 Zustände; insgesamt 1.500 Einträge und 5 MiB codiertes Batch-JSON.
- **Anfrageschlüssel:** Pulse reserviert ihn vor dem Schreiben. Derselbe Schlüssel und Batch liefern 24 Stunden lang dasselbe erfolgreiche Ergebnis.
- **Ausstehender Batch:** Wiederhole ihn mit demselben Schlüssel, um dieselben Zeilen zu schreiben. Anderer Inhalt mit diesem Schlüssel ergibt 409.
- **Ohne Schlüssel:** Ein fehlgeschlagener Batch kann bereits teilweise gespeichert sein; der Fehler nennt das. Beim erneuten Senden können diese Teile doppelt gespeichert werden. Ein nachträglich ergänzter Schlüssel verhindert diese Duplikate nicht. Sende jeden Batch ab dem ersten Versuch mit einem `Idempotency-Key`, damit du ihn sicher wiederholen kannst.
- **Quote:** Werte und Bytes teilen sich ein Kontingent pro Base über Quellen und Replikate hinweg. Ein Batch über dem Minutenkontingent kann bei vollem Kontingent angenommen werden. Sein voller Verbrauch verzögert weitere Batches, bis genügend Kontingent nachgefüllt ist. Eine 429-Antwort enthält `Retry-After`.
- **Speicherausfall:** Eine 503-Antwort enthält `Retry-After`. Abrufe protokollieren den Fehler; die Cloud-Administration erhält eine Benachrichtigung pro Ausfall.
:::

Warte die angegebene Frist ab, bevor du einen Batch mit Schlüssel wiederholst. Ein Fehler wegen zukünftiger Zeitstempel nennt den betroffenen Eintrag.
Der CLI-Befehl zur Datenaufnahme hat keinen Schlüsselschalter. Nutze den HTTP-Endpunkt mit Quellentoken, wenn du sichere Wiederholungen brauchst.
`cld pulse source-tokens create --output-file <path>` speichert ein Token in einer neuen privaten Datei und gibt es nie aus.

## Stelle Kapazität oder eine Base wieder her

Die Base-Administration ändert Quellen, Zugriff und Aufbewahrung. Die Cloud-Administration verbindet den Speicher und setzt Base-Richtlinien, Grenzen und interne Ziele.
Der Betreiber stellt eine eigene ClickHouse-Instanz bereit. Ohne sie erscheint **Pulse ist noch nicht eingerichtet**; andere Cloud-Apps bleiben verfügbar.

:::reference
- **Base-Speicher voll:** Neue Werte ergeben 409; Lesen bleibt möglich. Verkürze die Aufbewahrung oder lass die Cloud-Administration den Grenzwert erhöhen.
- **Instanz mit weniger als 10% freiem Speicher:** Neue Werte ergeben 503 mit einer Wiederholungsfrist. Lesen bleibt möglich; die Cloud-Administration erhält eine Benachrichtigung.
- **Kürzere Aufbewahrung:** Prüfe Stichtag, betroffene Zeilen und geschätzte Bytes vor der Bestätigung. Sensible Felder werden geleert; ihre Ereigniszeilen bleiben.
- **Stundenwerte hängen hinterher:** Dieser Hinweis unter **Verwaltung → Pulse → Bases** bedeutet verzögerte Berechnung oder Versiegelung. Prüfe diese Jobs vor dem Leeren.
- **Fehlgeschlagener Vorgang:** Eine neue Base muss zuerst aktiv werden. Wähle nach fehlgeschlagener Einrichtung, Leerung oder Löschung **Erneut versuchen**.
- **Gesperrtes Schreiben:** Eine fehlende Datenbank oder ein abweichender Prüfpunkt braucht eine passende Wiederherstellung und **Erneut prüfen** durch die Cloud-Administration. Leeren bleibt solange gesperrt.
:::

:::warning Leeren und Neuanlegen verwerfen Messwerte
Leeren behält Quellen, Tokens, Einstellungen und Zugriff. **Leer neu anlegen** durch die Cloud-Administration beginnt ebenfalls mit leeren Messdaten.
Löschen widerruft Tokens und Datenbank-Lesezugriff und entfernt dann die Base. Du kannst diese Vorgänge in Pulse nicht rückgängig machen.
:::

Eine Base bleibt während der Löschung auf der Übersicht ihrer Administration, bis die Löschung abgeschlossen ist.
Prüfe den Vorgangszustand, bevor du eine angenommene Anfrage als abgeschlossene Arbeit behandelst.
