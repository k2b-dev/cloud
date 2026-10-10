---
id: pulse-start
title: Mit Pulse beginnen
icon: ti ti-activity-heartbeat
description: Erfahre, wo du für jede Aufgabe beginnst, und gehe den ersten Weg von einer neuen Basis zum Dashboard.
order: 100
---
Pulse verwandelt eingehende Daten in durchsuchbare Fakten, Abfrageergebnisse und Dashboards. Die Pulse-Übersicht zeigt alle Basen, auf die du zugreifen kannst. Dort erstellst oder öffnest du eine Basis, bevor du eine Quelle oder ein Signal auswählst. Beginne mit deiner Frage. Die Oberfläche zeigt dir dann die Quelle, die Ressource, das Signal und die Filter, die du brauchst.

## Von der Aufgabe ausgehen {icon="square-plus"}

:::reference
- **Prüfen, ob Daten ankommen:** Öffne zuerst **Quellen**. Dort siehst du für jede Verbindung die letzten Aktualisierungen, Fehler, empfangenen Daten und die Nutzung von API-Schlüsseln.
- **Ein beobachtetes Objekt verstehen:** Öffne **Ressourcen**, wenn es um einen bestimmten Host, Container, ein Gerät, Kundenobjekt, eine Bestellung, Filiale oder App geht. So bleiben Metriken, Zustände und Ereignisse im selben Zusammenhang.
- **Einen benannten Fakt prüfen:** Öffne **Metriken**, **Ereignisse** oder **Zustände**, wenn du den Namen bereits kennst, zum Beispiel `system.memory.usage` oder `order.created`.
- **Eine Abfrage erstellen:** Teste im **Abfrage-Explorer** eine Metrik-, Ereignis- oder Zustandsabfrage. Kopiere Filter aus dem **Inventar**, statt Bezeichnungen auswendig zu lernen.
- **Ein Dashboard erstellen:** Nutze die Dashboard-DSL, sobald die Abfrage stabil ist. Dashboards sind Textdokumente mit Steuerelementen, Abschnitten, Zeilen, Karten, Widgets und Notizen.
:::

## Von einer neuen Basis zum Dashboard {icon="route"}

:::steps
1. **Basis erstellen:** Nutze jeweils eine Basis für ein Produkt, eine Umgebung, einen Geschäftsbereich oder einen Berichtskontext.
2. **Quelle verbinden:** Füge einen Metrikendpunkt oder eine Quelle für HTTP-Datenaufnahme hinzu. Warte, bis Pulse empfangene Daten meldet.
3. **Vorhandene Daten durchsuchen:** Nutze **Ressourcen**, wenn du das Objekt kennst. Nutze **Metriken**, **Ereignisse** oder **Zustände**, wenn du den Signalnamen kennst.
4. **Abfrage öffnen:** Beginne mit einem kopierten Abfrageausschnitt. Grenze ihn mit `source`, `resource`, `resource_type` oder `where` ein.
5. **Abfrage speichern:** Speichere stabile Abfragen, die du wiederverwenden willst.
6. **Dashboard schreiben:** Kopiere nützliche, stabile Abfragen in die Dashboard-DSL. Ergänze Beschreibungen, wenn ein Diagramm erklärt werden muss.
:::

:::note Eine Regel für Namen
Signalnamen beschreiben den Fakt, zum Beispiel `orders.created` oder `system.cpu.usage`. Quelle, Ressource und Dimensionen beschreiben, woher dieser Fakt stammt. Deshalb funktioniert dasselbe Modell für Server, Verkäufe, Websites, Energiesysteme und App-Abläufe.
:::
