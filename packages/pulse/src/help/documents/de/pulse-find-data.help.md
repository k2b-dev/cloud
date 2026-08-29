---
id: pulse-find-data
title: Daten finden
icon: ti ti-database-search
description: Der passende Einstieg, wenn Quelle, Ressource, Signal oder Dashboard bekannt ist.
order: 110
---
Eine nützliche Abfrage entsteht am schnellsten, wenn du zuerst die passende Quelle, Ressource oder das Signal findest und dann einen eingegrenzten Ausschnitt kopierst.

## Den passenden Browser wählen {icon="table"}

:::reference
- **Bei fehlenden Daten mit Quellen beginnen:** Quellen zeigen, ob Pulse vor Kurzem Daten empfangen hat. Prüfe das, bevor du Abfragen oder Dashboards änderst.
- **Bei einem bekannten Objekt mit Ressourcen beginnen:** Ressourcen gruppieren Metriken, Zustände und Ereignisse für ein beobachtetes Objekt. Das ist der klarste Weg für Hosts, Container, Geräte, Kundenobjekte und Bestellungen.
- **Bei einem bekannten Namen mit Metriken, Ereignissen oder Zuständen beginnen:** Signalseiten zeigen Varianten, aktuelle Werte, Dimensionen und Abfrageaktionen für eine Metrik, ein Ereignis oder einen Zustand.
- **Das Inventar als Nachschlagewerk verwenden:** Öffne Referenz und wähle dann Inventar. Filtere den aktuellen Katalog nach Quelle oder Entity, prüfe die beobachteten Feldrollen und kopiere eingegrenzte Ausschnitte in den Abfrage-Explorer oder Dashboard DSL.
- **Wiederverwendbare Abfragen speichern:** Der Abfrage-Explorer bewahrt den Verlauf der letzten Ausführungen. Speichere eine stabile Abfrage, wenn sie dauerhaft mit Name und Beschreibung verfügbar sein soll.
:::

## In dieser Reihenfolge eingrenzen {icon="search"}

:::steps
1. **Nach Quelle filtern:** Nutze `source`, wenn derselbe Signalname in mehreren Systemen oder Ingest-Pipelines vorkommt.
2. **Nach Ressource filtern:** Nutze `entity` oder `entity_type`, wenn es um ein beobachtetes Objekt oder eine Ressourcenklasse geht.
3. **Nach Dimensionen filtern:** Nutze `where` für Bezeichnungen wie Route, Region, Kanal, `compose_service`, Einhängepunkt oder Gerät.
4. **Die Aggregation zuletzt ändern:** Zeigt die Abfrage auf die richtigen Daten, aber das Diagramm wirkt falsch, prüfe `avg`, `latest`, `rate` oder `increase`.
:::

:::note Warum Varianten wichtig sind
Eine Metrik mit 50 Varianten ist normalerweise nicht dupliziert. Häufig haben 50 Container, Einhängepunkte, Routen, Regionen, Produkte oder andere bezeichnete Teilmengen denselben Signalnamen veröffentlicht.
:::
