---
id: pulse-start
title: Überblick
icon: ti ti-activity-heartbeat
description: Grundbegriffe und der erste Weg durch eine Pulse-Basis.
order: 100
---
Pulse verwandelt eingehende Daten in durchsuchbare Fakten, Abfrageergebnisse und Dashboards. Der Pulse-Überblick zeigt alle Basen, auf die du zugreifen kannst. Dort kannst du eine Basis erstellen oder öffnen, bevor eine Quelle oder ein Signal ausgewählt ist. Beginne mit deiner Frage. Die Oberfläche führt dich dann zu den benötigten Quellen, Ressourcen, Signalen und Filtern.

## Von der Aufgabe ausgehen {icon="square-plus"}

:::reference
- **Prüfen, ob Daten ankommen:** Öffne zuerst Quellen. Dort siehst du für jede Verbindung die letzten Aktualisierungen, Fehler, empfangenen Daten und die Nutzung von API-Schlüsseln.
- **Ein beobachtetes Objekt verstehen:** Öffne Ressourcen, wenn es um einen bestimmten Host, Container, ein Gerät, Kundenobjekt, eine Bestellung, Filiale oder App geht. So bleiben Metriken, Zustände und Ereignisse im selben Zusammenhang.
- **Einen benannten Fakt prüfen:** Öffne Metriken, Ereignisse oder Zustände, wenn du den Namen bereits kennst, zum Beispiel `system.memory.usage` oder `order.created`.
- **Eine Abfrage erstellen:** Teste im Abfrage-Explorer eine Metrik-, Ereignis- oder Zustandsabfrage. Kopiere Filter aus dem Inventar, statt Bezeichnungen auswendig zu lernen.
- **Ein Dashboard erstellen:** Nutze Dashboard DSL, sobald die Abfrage stabil ist. Dashboards sind Textdokumente mit Steuerelementen, Abschnitten, Zeilen, Karten, Widgets und Notizen.
:::

## Der erste sinnvolle Ablauf {icon="route"}

:::steps
1. **Eine Basis erstellen:** Nutze jeweils eine Basis für ein Produkt, eine Umgebung, einen Geschäftsbereich oder einen Berichtskontext.
2. **Eine Quelle verbinden:** Füge einen Metrik-Endpunkt oder eine HTTP-Ingest-Quelle hinzu und warte, bis Pulse empfangene Daten meldet.
3. **Vorhandene Daten durchsuchen:** Nutze Ressourcen, wenn du das Objekt kennst. Nutze Metriken, Ereignisse oder Zustände, wenn du den Signalnamen kennst.
4. **Eine Abfrage öffnen:** Beginne mit einem kopierten Abfrageausschnitt und grenze ihn dann mit `source`, `entity`, `entity_type` oder `where` ein. Speichere stabile Abfragen, die du wiederverwenden möchtest.
5. **Das Dashboard schreiben:** Übernimm nützliche, stabile Abfragen in Dashboard DSL. Ergänze Beschreibungen, wenn ein Diagramm erklärt werden muss.
:::

:::note Eine Regel für Namen
Signalnamen beschreiben den Fakt, zum Beispiel `orders.created` oder `system.cpu.usage`. Quelle, Ressource und Dimensionen beschreiben, woher dieser Fakt stammt. Deshalb funktioniert dasselbe Modell für Server, Verkäufe, Websites, Energiesysteme und App-Abläufe.
:::
