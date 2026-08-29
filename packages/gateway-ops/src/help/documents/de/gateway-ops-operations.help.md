---
id: gateway-ops-operations
title: Systembetrieb
icon: ti ti-tool
description: Zusammenspiel der Betriebsseiten bei üblichen Diagnosen und Wartungsarbeiten.
order: 110
---

Die Administrationsseiten werden serverseitig gerendert. Filter, Suche und Seitenwechsel sind in der URL gespeichert; kompakte Übersichten fassen den Zustand zusammen.

## Gateway-Seiten {icon="point"}

:::reference
- **Apps:** Zeigt registrierte Apps, Online-Zustand, Basis-URL, Heartbeat, Laufzeit, Anfrageanzahl, Latenz, Fehleranzahl und unterstützte Plattformfunktionen.
- **Routen:** Zeigt die Eigentümerschaft der Routenpräfixe und Routenzähler aus dem aktuellen Status des Gateway-Routers.
- **Health-Webhooks:** Senden den Gateway-Zustand an HTTP-Endpunkte. Webhooks können alle Apps, nur ausgewählte Apps oder alle außer ausgewählten Apps berücksichtigen und GET-Pings oder POST-JSON-Nutzlasten senden.
- **Einstellungen:** Der Zeitplan für Gateway-Zustandsprüfungen ist als Einstellung gespeichert und bestimmt, wann geplante Webhook-Auswertungen laufen.
:::

## Seiten unter Systembetrieb {icon="layout-dashboard"}

:::reference
- **Protokolle:** Filtert strukturierte Protokolleinträge nach Quelle, Stufe, Suchtext und Seite. Die Aufbewahrungsdauer stammt aus der Einstellung für die Protokollaufbewahrung.
- **Telemetrie:** Zeigt Gateway-Anfrageereignisse nach App, Route, Methode, Status, Dauer, langsamen Anfragen und Fehlern.
- **Metriken:** Stellt einen Prometheus-kompatiblen Metrikendpunkt bereit und verwaltet Bearer-Token für Pulse oder externe Scraper.
- **Benachrichtigungen:** Durchsucht Zustellungsdatensätze von Benachrichtigungen und filtert nach gesendeter, ausstehender oder fehlgeschlagener Zustellung.
:::

## Datendiagnosen {icon="lifebuoy"}

:::reference
- **Postgres:** Zeigt Schemagröße, Tabellengröße, geschätzte Zeilenzahl des Planners, tote Zeilen, Zeitpunkte der Analyse, installierte Erweiterungen und Tabellenwarnungen.
- **Redis:** Zeigt Größe des Keyspace, Ablaufabdeckung, durchschnittliche TTL, Präfixverteilung, begrenzte SCAN-Stichproben und Warnungen.
:::
