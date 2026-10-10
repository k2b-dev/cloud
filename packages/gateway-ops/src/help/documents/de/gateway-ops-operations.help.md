---
id: gateway-ops-operations
title: Systembetrieb
icon: ti ti-tool
description: Die passende Betriebsseite für Diagnose und Wartung finden.
order: 110
---

Die Administrationsseiten werden serverseitig gerendert. Filter, Suche und Seitenwechsel stehen in der URL, und kompakte Übersichten zeigen den Zustand.

## Gateway-Seiten nutzen {icon="point"}

:::reference
- **Apps:** Zeigt die registrierten Apps mit Online-Zustand, Basis-URL, Heartbeat, Laufzeit, Anfrageanzahl, Latenz, Fehleranzahl und unterstützten Plattformfunktionen.
- **Routen:** Zeigt, welche App welches Routenpräfix bedient, und die Routenzähler aus dem aktuellen Stand des Gateway-Routers.
- **Health-Webhooks:** Senden den Gateway-Zustand an HTTP-Endpunkte. Ein Webhook berücksichtigt **Alle Apps**, nur ausgewählte Apps (**Nur ausgewählte**) oder alle Apps außer den ausgewählten (**Ausgewählte ausschließen**). Er sendet GET-Pings oder POST-JSON-Nutzlasten.
- **Einstellungen:** Der Zeitplan für die Zustandsprüfung des Gateways ist als Einstellung gespeichert. Er bestimmt, wann die geplanten Webhook-Prüfungen laufen.
:::

## Seiten der Systembeobachtung nutzen {icon="layout-dashboard"}

:::reference
- **Protokolle:** Filtere strukturierte Protokolleinträge nach Quelle, Stufe, Suchtext und Seite. Die Seite zeigt die Aufbewahrungsdauer aus der Einstellung für die Protokollaufbewahrung.
- **Telemetrie:** Zeigt Gateway-Anfrageereignisse nach App, Route, Methode, Status, Dauer, langsamen Anfragen und Fehlern.
- **Metriken:** Stellt einen Prometheus-kompatiblen Metrikendpunkt bereit. Hier erstellst und widerrufst du Bearer-Token für Pulse oder externe Scraper.
- **Capabilities:** Zeigt den Verlauf ausgeführter Capability-Aufrufe nach App, Capability, Herkunft, Status, Nutzer, destruktivem Flag und Zeitraum. Jede Zeile enthält Korrelation, Zeiten und die Struktur von Eingabe und Ergebnis, nie deren Inhalte. Nach 90 Tagen werden die Zeilen gelöscht.
- **Benachrichtigungen:** Durchsuche Zustellungsdatensätze von Benachrichtigungen und filtere nach gesendeter, ausstehender oder fehlgeschlagener Zustellung.
:::

## Datendiagnosen lesen {icon="lifebuoy"}

:::reference
- **Postgres:** Zeigt Schemagröße, Tabellengröße, geschätzte Zeilenzahlen des Planners, tote Zeilen, Zeitpunkte der Analyse, installierte Erweiterungen und Tabellenwarnungen.
- **Redis:** Zeigt Größe des Keyspace, Ablaufabdeckung, durchschnittliche TTL, Präfixverteilung, begrenzte SCAN-Stichproben und Warnungen.
:::
