---
id: pulse-find-data
title: Daten finden
icon: ti ti-database-search
description: Wähle den passenden Einstieg, wenn du Quelle, Ressource, Signal oder Dashboard kennst.
order: 110
---
Eine nützliche Abfrage entsteht am schnellsten so: Finde zuerst die passende Quelle, Ressource oder das Signal. Kopiere dann einen eingegrenzten Ausschnitt.

## Den passenden Einstieg wählen {icon="table"}

:::reference
- **Bei fehlenden Daten mit Quellen beginnen:** **Quellen** zeigen, ob Pulse vor Kurzem Daten empfangen hat. Prüfe das, bevor du Abfragen oder Dashboards änderst.
- **Bei einem bekannten Objekt mit Ressourcen beginnen:** **Ressourcen** gruppieren Metriken, Zustände und Ereignisse eines beobachteten Objekts. Das ist der klarste Weg für Hosts, Container, Geräte, Kundenobjekte und Bestellungen.
- **Bei einem bekannten Namen mit Metriken, Ereignissen oder Zuständen beginnen:** Eine Signalseite zeigt Varianten, aktuelle Werte, Dimensionen und Abfrageaktionen für eine Metrik, ein Ereignis oder einen Zustand.
- **Namen im Inventar nachschlagen:** Öffne **Referenz** und wähle dann **Inventar**. Filtere den aktuellen Katalog nach Quelle oder Ressource und prüfe die beobachteten Feldrollen. Kopiere dann eingegrenzte Ausschnitte in den **Abfrage-Explorer** oder in die Dashboard-DSL.
- **Wiederverwendbare Abfragen speichern:** Der **Abfrage-Explorer** bewahrt den Verlauf der letzten Ausführungen. Speichere eine stabile Abfrage, wenn du sie dauerhaft mit Name und Beschreibung behalten willst.
:::

## In dieser Reihenfolge eingrenzen {icon="search"}

:::steps
1. **Nach Quelle filtern:** Nutze `source`, wenn derselbe Signalname in mehreren Systemen oder Ingest-Pipelines vorkommt.
2. **Nach Ressource filtern:** Nutze `resource` oder `resource_type`, wenn es um ein beobachtetes Objekt oder eine Ressourcenklasse geht.
3. **Nach Dimensionen filtern:** Nutze `where` für Bezeichnungen wie Route, Region, Kanal, `compose_service`, Einhängepunkt oder Gerät.
4. **Die Aggregation zuletzt ändern:** Stimmen die Daten, wirkt das Diagramm aber falsch, prüfe `avg`, `latest`, `rate` oder `increase`.
:::

:::note Warum Varianten wichtig sind
Eine Metrik mit 50 Varianten ist meist nicht dupliziert. Häufig haben 50 Container, Einhängepunkte, Routen, Regionen, Produkte oder andere bezeichnete Teilmengen denselben Signalnamen veröffentlicht.
:::
