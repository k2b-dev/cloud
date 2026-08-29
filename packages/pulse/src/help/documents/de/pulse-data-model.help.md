---
id: pulse-data-model
title: Datenmodell
icon: ti ti-stack-2
description: Wie Quellen, Ressourcen, Signale, Varianten und Dimensionen zusammenhängen.
order: 105
---
Pulse verwendet ein kompaktes Datenmodell, damit unterschiedliche Fachbereiche dieselbe Abfrage- und Dashboard-Sprache nutzen können. Lerne die Begriffe in der Reihenfolge kennen, in der sie beim Durchsuchen von Daten auftreten.

## Der Weg von der Quelle zum Diagramm {icon="layout-dashboard"}

:::reference
- **Basis:** Ein Arbeitsbereich mit eigenen Zugriffsrechten, Aufbewahrungsregeln, Quellen, Dashboards und gespeicherten Abfragen.
- **Quelle:** Eine Verbindung, die Daten an Pulse sendet, zum Beispiel ein Metrik-Endpunkt, eine HTTP-Ingest-Quelle oder eine andere App.
- **Ressource:** Das beobachtete Objekt: ein Host, Container, Gerät, Kundenobjekt, eine Bestellung, Filiale, ein Dienst, Akku oder ein beliebiges Fachobjekt.
- **Signal:** Eine benannte Metrik, ein Ereignis oder ein Zustand. Der Name beschreibt, was passiert ist oder gemessen wurde.
- **Variante:** Eine konkrete Signalform für eine Kombination aus Quelle, Ressource und Dimensionen. Varianten erklären, warum ein Signal in mehreren Zeilen oder Linien erscheinen kann.
- **Dimension:** Eine Bezeichnung, die Varianten unterscheidet, zum Beispiel Region, Route, Gerät, `compose_service`, Kanal oder `customer_tier`. Verwende hier wiederverwendbare Kategorien statt eindeutiger Anfrage- oder Personenwerte.
:::

## Wiederholte Zeilen richtig lesen {icon="table"}

:::reference
- **Dasselbe Signal, unterschiedliche Ressourcen:** `docker.container.cpu.usage` kann einmal pro Container erscheinen. Öffne das Signal, um seine Varianten zu sehen, oder die Ressource, um nur einen Container zu sehen.
- **Dieselbe Ressource, unterschiedliche Dimensionen:** Eine Dateisystemmetrik kann einmal pro Einhängepunkt erscheinen. Die Dimensionen zeigen, für welchen Einhängepunkt, welche Schnittstelle, Route, Region oder welchen Kanal die Zeile gilt.
- **Dieselbe Quelle, unterschiedliche Fachbereiche:** Eine Quelle kann heute Infrastrukturdaten und morgen Geschäftsereignisse veröffentlichen. Pulse setzt kein festes Fachvokabular voraus.
:::

## Den passenden Signaltyp wählen {icon="route"}

:::reference
- **Metrik: eine Zahl im Zeitverlauf:** Nutze Metriken für wiederholte Messungen wie CPU-Auslastung, Leistung, Latenz oder Umsatz. Halte Dimensionen stabil, damit die Variantenliste nützlich bleibt.
- **Ereignis: etwas ist passiert:** Nutze Ereignisse für Besuche, QR-Aufrufe, Bestellungen, Anfragen, Deployments und andere zeitpunktbezogene Fakten. Ereignisse können Details mit vielen möglichen Werten enthalten, ohne für jeden Wert eine Metrikvariante zu erzeugen.
- **Zustand: was jetzt gilt:** Nutze Zustände für den Online-Status, die aktuelle Version, den Betriebsmodus oder einen anderen letzten Wert. Pulse ergänzt den Verlauf nur, wenn sich der Wert tatsächlich ändert.
:::

## Ereignisfelder einordnen {icon="table"}

:::reference
- **Dimensionen filtern und gruppieren:** Nutze Bezeichnungen mit einer stabilen Wertemenge, zum Beispiel Kampagne, Kanal, Land, Ergebnis oder Umgebung. Query DSL verwendet Dimensionen für `where` und `group by`.
- **Attribute bewahren detaillierten Kontext:** Nutze Attribute für vollständige URLs, Anfrage-IDs, Referrer, User-Agents und unregelmäßige Ereignisdetails, die bei einzelnen Ereignissen sichtbar bleiben sollen.
- **Vertrauliche Felder laufen unabhängig ab:** Nutze vertrauliche Felder für IP-Adressen, genaue Geodaten und andere geschützte Ereignisdaten. Normale Ereignisergebnisse zeigen diese Felder nicht. Pulse kann sie früher als den Rest des Ereignisses entfernen.
- **Payload hält ergänzende Daten zusammen:** Nutze Payload für verschachtelte Fachdaten, die du als ein Objekt prüfen, aber nicht filtern oder gruppieren möchtest.
- **Das Inventar beschreibt verfügbare Felder:** Es zeigt beobachtete Namen, Rollen, Werttypen, Anzahlen und Zeitstempel von Dimensionen, Attributen und vertraulichen Feldern. Es listet nicht jeden gespeicherten Feldwert auf.
- **Identitäten verbinden Aktivitäten:** Nutze `actorId`, `sessionId` und `correlationId` für Personen, Sitzungen und zusammengehörige Aktivitäten. Pulse kann eindeutige Akteure und Sitzungen zählen, ohne sie als Dimensionen anzulegen.
- **Ressourcen bleiben stabil:** Lege Ressourcen für durchsuchbare Objekte wie eine Kampagne, einen QR-Code, Host oder Dienst an. Ein Besuch, eine Sitzung, Anfrage, ein Zeitstempel oder eine IP-Adresse ist keine Ressource.
:::

:::note Ressource in der Oberfläche, Entity in der DSL
Die Oberfläche verwendet Ressource, weil der Begriff leichter verständlich ist. Query DSL verwendet `entity` für dieselbe Kennung und `entity_type` für die Ressourcenklasse. `entity container:app-core` bezeichnet zum Beispiel eine Ressource; `entity_type container` bezeichnet alle Container-Ressourcen.
:::
