---
id: gateway-ops-incident
title: Eine Störung untersuchen
icon: ti ti-stethoscope
description: Einem wiederholbaren Weg vom App-Zustand über Routen, Anfragetelemetrie, Protokolle und Speicher bis zu Benachrichtigungen und Webhooks folgen.
order: 105
---

Beginne unter **Systembeobachtung → Übersicht**. Sie zeigt appübergreifend, ob gerade etwas gestört ist: Anfragefehler, Ratenbegrenzungen, hängende Jobs und Protokollfehler. Jede Kachel öffnet die zugehörige Seite mit bereits angewendetem Filter.

Grenze die Störung anhand eines Signals ein, bevor du alle Seiten der Systembeobachtung öffnest. Gateway Ops speichert die Filter in der URL. So kannst du eine hilfreiche Ansicht mit einer anderen Person mit der Rolle **Admin** teilen.

## Dem Diagnoseweg folgen {icon="lifebuoy"}

:::steps
1. **Apps:** Prüfe, ob die betroffene App online, veraltet, beeinträchtigt oder offline ist. Notiere den letzten Heartbeat und das Routenpräfix.
2. **Routen:** Prüfe, ob das erwartete Präfix der erwarteten App gehört. Prüfe seine Treffer- und Fehlerzähler.
3. **Telemetrie:** Filtere nach App, Route, Methode, Status, Dauer oder Fehlerart, um die fehlgeschlagenen Anfragen zu finden.
4. **Protokolle:** Filtere nach der Quelle der App oder des Dienstes und grenze nach Stufe oder Suchbegriff ein. Suche den Kontext der App aus demselben Zeitraum.
5. **Jobs:** Prüfe die Hintergrundarbeit, wenn das Symptom veraltete oder fehlende Daten sind, nicht eine fehlschlagende Anfrage. Suche nach hängenden Läufen und überfälligen Zeitplänen. Ein Zeitplan, der nicht mehr auslöst, erzeugt selbst keine Fehler.
6. **Postgres** oder **Redis**: Prüfe die Speicherdiagnosen nur, wenn Anfragen und Protokolle auf Speicherdruck, veraltete Daten oder wachsenden Keyspace hindeuten. Bei Redis sind Verdrängungen und Trefferrate wichtiger als die Anzahl der Schlüssel.
7. **Benachrichtigungen** und **Webhooks**: Prüfe, ob die Plattform eine Benachrichtigung für den Betrieb gesendet hat oder ob der Versand fehlgeschlagen ist.
:::

## Die Daten richtig einordnen {icon="point"}

- Eine registrierte App mit veraltetem Heartbeat kann laufen, ohne ihren aktuellen Zustand melden zu können.
- Routenzähler zeigen den Gateway-Verkehr im ausgewählten Zeitraum. Sie zeigen nicht, ob eine Person den Ablauf erfolgreich abgeschlossen hat.
- Ein als **Hängt** gezählter Job läuft nicht: Sein Span blieb offen, als ein Prozess beendet wurde. Nur **Läuft** bedeutet, dass gerade Arbeit ausgeführt wird.
- Die Telemetrie erklärt Pfad und Laufzeit einer HTTP-Anfrage. Die Protokolle zeigen, was die App intern gemeldet hat.
- Zeilenzahlen in Postgres sind Schätzungen des Planners. Redis-Präfixe stammen aus einer begrenzten Stichprobe.

:::warning Entferne nur die Registrierung einer Instanz, die nicht zurückkommt
Entferne eine Registrierung nur, wenn du nicht erwartest, dass die App-Instanz wieder verfügbar wird. Das Entfernen bereinigt die Gateway-Registry. Es repariert die App nicht und startet sie nicht neu.
:::

## Eine hilfreiche Störungsansicht teilen {icon="shield-lock"}

Lass die Filter für App, Route, Status, Zeitraum und Suche in der URL. Teile die gefilterte Seite zusammen mit dem beobachteten Zeitraum und dem Symptom, das Personen sehen. Teile nie Zugangsdaten oder sensible Nutzlasten.
