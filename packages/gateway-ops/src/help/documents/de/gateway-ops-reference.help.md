---
id: gateway-ops-reference
title: Referenz
icon: ti ti-book
description: Zustände, Regeln für die Webhook-Zustellung und Grenzen der Diagnosen nachschlagen.
order: 120
---

Gateway Ops fasst Signale der Plattform zusammen. Es zeigt keine rohen Redis-Schlüssel. Für Protokolle, Telemetrie, Einstellungen, Metriken und Health-Webhooks nutzt es die vorhandenen Dienst-APIs.

## Zustände lesen {icon="point"}

:::reference
- **OK:** Die berücksichtigten Apps sind online, und ihr Zustand ist für die Zustandsprüfung des Gateways aktuell genug.
- **Warnung:** Eine App ist erreichbar, meldet aber veraltete Zustandsinformationen oder einen anderen beeinträchtigten Zustand.
- **Fehler:** Mindestens eine berücksichtigte App ist offline oder so beeinträchtigt, dass die Zustandsprüfung für den gewählten Umfang fehlschlägt.
:::

## Webhook-Zustellung verstehen {icon="send"}

:::reference
- **Senden bei:** Ein Webhook kann bei **OK**, **Warnung**, **Fehler**, **Wiederherstellung** oder **Jede Prüfung** senden, also bei jeder geplanten Prüfung. Wählst du keinen Auslöser, nutzt er Fehler und Wiederherstellung.
- **Wiederholungsintervall:** Eine nicht behobene Warnung oder ein nicht behobener Fehler wird erst nach dem eingestellten Intervall erneut gesendet. Cloud begrenzt das Intervall auf mindestens eine Minute und höchstens dreißig Tage.
- **Zeitüberschreitung:** Cloud begrenzt die Zeitüberschreitung für die Zustellung auf mindestens eine und höchstens dreißig Sekunden. Eine fehlgeschlagene Zustellung aktualisiert den letzten Fehler und den Fehlerzähler des Webhooks.
- **Nutzlast:** Eine GET-Zustellung sendet eine Ping-Anfrage. Eine POST-Zustellung sendet JSON mit dem Modus und dem Zustandsbericht des Gateways für den gewählten Umfang.
:::

:::info Grenzen der Diagnosen kennen
Redis-Präfixe stammen aus einer begrenzten Stichprobe, nicht aus einer vollständigen Ansicht aller Rohschlüssel. Zeilenzahlen in Postgres sind Schätzungen des Planners, keine exakten Werte aus vollständigen Tabellenscans.
:::

## PostgreSQL-Verbindungen lesen {icon="point"}

PostgreSQL-Verbindungen und ihr Limit beziehen sich auf den Datenbankserver. PgBouncer-Clients, Pool-Limits und Wartezeiten im Pool sind nicht enthalten; überwache PgBouncer separat. Bei Transaction-Pooling stehen die Sitzungen für gemeinsam genutzte PostgreSQL-Backends. Eine fehlgeschlagene Sitzungs- oder Indexabfrage erscheint als Ladefehler, nicht als leere Liste.
