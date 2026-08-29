---
id: gateway-ops-incident
title: Eine Störung untersuchen
icon: ti ti-stethoscope
description: Ein wiederholbarer Diagnoseweg vom App-Zustand über Routen, Anfragetelemetrie, Protokolle und Speicher bis zu Benachrichtigungen und Webhooks.
order: 105
---

Beginne unter **Systembetrieb → Übersicht**. Sie zeigt appübergreifend, ob aktuell etwas gestört ist, und fasst Anfragefehler, Ratenbegrenzungen, hängende Jobs und Protokollfehler zusammen. Jede Kachel öffnet die zugehörige Seite mit bereits angewendetem Filter.

Grenze die Störung anhand eines Signals ein, bevor du alle Seiten unter Systembetrieb öffnest. Gateway Ops speichert die Filter in der URL. So kannst du eine hilfreiche Ansicht mit einer anderen Person mit Administratorrechten teilen.

## Diagnoseweg {icon="lifebuoy"}

:::steps
1. **Apps:** Prüfe, ob die betroffene App online, veraltet, beeinträchtigt oder offline ist. Notiere den letzten Heartbeat und das Routenpräfix.
2. **Routen:** Prüfe, ob das erwartete Präfix der erwarteten App gehört, und untersuche die Treffer- und Fehlerzähler.
3. **Telemetrie:** Filtere nach App, Route, Methode, Status, Dauer oder Fehlerart, um die fehlgeschlagenen Anfragen zu finden.
4. **Protokolle:** Suche für denselben Zeitraum anhand der App oder Dienstquelle sowie einer eingegrenzten Protokollstufe oder eines Suchbegriffs nach dem Anwendungskontext.
5. **Jobs:** Prüfe Hintergrundarbeit, wenn Daten veraltet sind oder fehlen, statt eine Anfrage fehlzuschlagen. Suche nach hängenden Läufen und überfälligen Zeitplänen. Ein Zeitplan, der nicht mehr ausgelöst wird, erzeugt selbst keine Fehler.
6. **Postgres oder Redis:** Prüfe die Speicherdiagnosen nur, wenn Anfrage- und Protokolldaten auf Speicherdruck, veraltete Daten oder Wachstum des Keyspace hindeuten. Bei Redis sind Verdrängungen und Trefferrate wichtiger als die Anzahl der Schlüssel.
7. **Benachrichtigungen und Webhooks:** Prüfe, ob die Plattform eine Benachrichtigung für die Administration gesendet hat oder deren Versand fehlgeschlagen ist.
:::

## Daten richtig einordnen {icon="point"}

- Eine registrierte App mit veraltetem Heartbeat kann laufen, aber möglicherweise keinen aktuellen Zustand melden.
- Routenzähler zeigen den Gateway-Datenverkehr im ausgewählten Zeitraum. Sie belegen nicht, dass eine Person den Ablauf erfolgreich abgeschlossen hat.
- Ein als hängend gezählter Job läuft nicht: Sein Span blieb offen, als ein Prozess beendet wurde. Nur „Läuft“ bedeutet, dass Arbeit gerade ausgeführt wird.
- Die Telemetrie erklärt Pfad und Laufzeit einer HTTP-Anfrage. Die Protokolle zeigen, was die Anwendung intern gemeldet hat.
- Zeilenzahlen in Postgres sind Schätzungen des Planners. Redis-Präfixe stammen aus einer begrenzten Stichprobe.

:::warning Eine Offline-Registrierung entfernen
Entferne eine Registrierung nur, wenn die App-Instanz voraussichtlich nicht wieder verfügbar sein wird. Das Entfernen bereinigt die Gateway-Registry. Es repariert oder startet die Anwendung nicht neu.
:::

## Eine hilfreiche Störungsansicht teilen {icon="shield-lock"}

Lass die Filter für App, Route, Status, Zeitraum und Suche in der URL. Teile die gefilterte Seite zusammen mit dem beobachteten Zeitraum und dem sichtbaren Symptom, niemals mit Zugangsdaten oder sensiblen Nutzlasten.
