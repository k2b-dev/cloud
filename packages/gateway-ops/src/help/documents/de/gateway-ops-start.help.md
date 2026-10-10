---
id: gateway-ops-start
title: Erste Schritte
icon: ti ti-route-scan
description: Gateway-Apps, Routen, Zustand, Protokolle, Telemetrie, Metriken, Datendiagnosen, Benachrichtigungen und Webhooks prüfen.
order: 100
---

Gateway Ops ist die Administrationsoberfläche für das Cloud-Gateway. Hier siehst du, welche Apps registriert sind, welche Routenpräfixe das Gateway bereitstellt, wie sich Anfragen verhalten und welche Zustandssignale der Plattform Aufmerksamkeit brauchen.

## Die Bereiche kennen {icon="layout-grid"}

:::reference
- **App-Registry:** Apps registrieren sich beim Gateway. Sie melden Metadaten wie Name, Routenpräfix, Navigationsunterstützung, Administrationsseiten, Suchunterstützung und Zustand.
- **Routen:** Jedes Routenpräfix zeigt, welche App den Pfad gerade bedient, wie oft die Route aufgerufen wurde und wie viele Gateway-Fehler erfasst wurden.
- **Zustand:** Der Gateway-Zustand berücksichtigt aktive App-Registrierungen, veraltete App-Zustände, Offline-Apps, Routenstatistiken, nicht zugeordnete Anfragen und Gateway-Instanzen.
- **Systembeobachtung:** Fasst Protokolle, Telemetrie, Prometheus-Metriken, Redis-Diagnosen, Postgres-Diagnosen, Benachrichtigungen und Webhooks für Warnungen zusammen.
:::

## Eine Aufgabe beginnen {icon="route"}

:::reference
- **Plattformzustand prüfen:** Beginne unter **Apps**, um Dienste zu sehen, die online, beeinträchtigt oder offline sind. Entferne eine Offline-Registrierung nur, wenn du nicht erwartest, dass die App zurückkommt.
- **Routing verfolgen:** Öffne **Routen**, um Routenpräfixe, die Gesamtzahl der Treffer und die erfassten Fehler für jedes Präfix des Gateways zu prüfen.
- **Ein Anfrageproblem untersuchen:** Nutze **Telemetrie** für Anfrageereignisse, langsame Anfragen, Statuscodes, Routenpräfixe, Methoden und Fehlerarten. Prüfe die **Protokolle**, wenn die App strukturierte Protokolleinträge geschrieben hat.
- **Plattformspeicher prüfen:** Nutze die Diagnosen unter **Postgres** und **Redis**, um Tabellenwachstum, tote Zeilen, installierte Erweiterungen, Schlüsselanzahl, Präfixverteilung, TTL-Abdeckung und Warnungen zu prüfen.
:::

:::info Gateway Ops ist für die Administration
Die API-Routen von Gateway Ops verlangen die Rolle **Admin**. Für destruktive Aktionen, etwa das Entfernen von Offline-Apps oder das Löschen von Webhooks, nutzt die Oberfläche dieselbe Administrations-API.
:::
