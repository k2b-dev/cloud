---
id: gateway-ops-start
title: Erste Schritte
icon: ti ti-route-scan
description: Gateway-Apps, Routen, Zustand, Protokolle, Telemetrie, Metriken, Datendiagnosen, Benachrichtigungen und Webhooks.
order: 100
---

Gateway Ops ist die Administrationsoberfläche für das Cloud-Gateway. Hier siehst du, welche Apps registriert sind, welche Routenpräfixe bereitgestellt werden, wie sich Anfragen verhalten und welche Zustandssignale der Plattform geprüft werden müssen.

## Überblick {icon="layout-grid"}

:::reference
- **App-Registry:** Apps registrieren sich beim Gateway und stellen Metadaten wie Name, Routenpräfix, Navigationsunterstützung, Administrationsseiten, Suchunterstützung und Zustand bereit.
- **Routen:** Routenpräfixe zeigen, welche App einen Pfad derzeit bedient, wie oft die Route aufgerufen wurde und wie viele Gateway-Fehler erfasst wurden.
- **Zustand:** Der Gateway-Zustand berücksichtigt aktive App-Registrierungen, veraltete App-Zustände, Offline-Apps, Routenstatistiken, nicht zugeordnete Anfragen und Gateway-Instanzen.
- **Systembetrieb:** Protokolle, Telemetrie, Prometheus-Metriken, Redis-Diagnosen, Postgres-Diagnosen, Benachrichtigungen und Webhooks für Warnungen sind unter Systembetrieb zusammengefasst.
:::

## Häufige Aufgaben {icon="route"}

:::reference
- **Plattformzustand prüfen:** Prüfe unter Apps, welche Dienste online, beeinträchtigt oder offline sind. Entferne eine Offline-Registrierung nur, wenn die App voraussichtlich nicht wieder verfügbar sein wird.
- **Routing-Verhalten verfolgen:** Öffne Routen, um die Routenpräfixe, die Gesamtzahl der Treffer und die erfassten Fehler für jedes vom Gateway bereitgestellte Präfix zu prüfen.
- **Ein Anfrageproblem untersuchen:** Verwende Telemetrie für Anfrageereignisse, langsame Anfragen, Statuscodes, Routenpräfixe, Methoden und Fehlerarten. Prüfe die Protokolle, wenn die Anwendung strukturierte Protokolleinträge ausgegeben hat.
- **Plattformspeicher prüfen:** Verwende die Postgres- und Redis-Diagnosen, um Tabellenwachstum, tote Zeilen, installierte Erweiterungen, Schlüsselanzahl, Präfixverteilung, TTL-Abdeckung und Warnungen zu prüfen.
:::

:::info Zugriff
Gateway Ops ist eine Administrationsoberfläche. API-Routen erfordern Administratorzugriff. Für destruktive Aktionen wie das Entfernen von Offline-Apps oder das Löschen von Webhooks verwendet die Oberfläche dieselbe Admin-API.
:::
