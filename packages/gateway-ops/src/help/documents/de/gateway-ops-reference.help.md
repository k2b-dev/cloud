---
id: gateway-ops-reference
title: Referenz
icon: ti ti-book
description: Bedeutung der Felder, Verhalten der Webhooks und Grenzen der Diagnosen.
order: 120
---

Gateway Ops fasst Signale der Plattform zusammen. Es zeigt keine rohen Redis-Schlüssel an und verwendet die vorhandenen Dienst-APIs für Protokolle, Telemetrie, Einstellungen, Metriken und Health-Webhooks.

## Zustände {icon="point"}

:::reference
- **OK:** Die berücksichtigten Apps sind online und ihr Zustand ist für die Gateway-Zustandsprüfung aktuell genug.
- **Warnung:** Eine App ist erreichbar, meldet aber veraltete Zustandsinformationen oder einen anderen beeinträchtigten Zustand.
- **Fehler:** Mindestens eine berücksichtigte App ist offline oder so beeinträchtigt, dass die Zustandsprüfung für den gewählten Umfang fehlschlägt.
:::

## Webhook-Zustellung {icon="send"}

:::reference
- **Auslöser:** Webhooks können bei OK, Warnung, Fehler, Wiederherstellung oder jeder geplanten Prüfung senden. Wenn kein Auslöser ausgewählt ist, werden Fehler und Wiederherstellung verwendet.
- **Wiederholungsintervall:** Nicht behobene Warnungen oder Fehler werden erst nach dem eingerichteten Intervall erneut gesendet. Das Intervall wird auf mindestens eine Minute und höchstens dreißig Tage begrenzt.
- **Zeitüberschreitung:** Die Zeitüberschreitung für die Zustellung wird auf mindestens eine und höchstens dreißig Sekunden begrenzt. Fehlgeschlagene Zustellungen aktualisieren den letzten Fehler und den Fehlerzähler des Webhooks.
- **Nutzlast:** Eine GET-Zustellung sendet eine Ping-Anfrage. Eine POST-Zustellung sendet JSON mit dem Modus und dem Gateway-Zustandsbericht für den gewählten Umfang.
:::

:::info Grenzen der Diagnosen
Redis-Präfixe stammen aus einer begrenzten Stichprobe und nicht aus einer vollständigen Ansicht aller Rohschlüssel. Zeilenzahlen in Postgres sind Schätzungen des Planners und keine exakten Werte aus vollständigen Tabellenscans.
:::
