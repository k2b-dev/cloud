---
id: pulse-data-model
title: Datenmodell verstehen
icon: ti ti-stack-2
description: Sieh, wie Basen, Quellen, Ressourcen, Signale, Varianten und Dimensionen zusammenhängen.
order: 105
---
Pulse verwendet ein kompaktes Datenmodell. So können unterschiedliche Fachbereiche dieselbe Abfrage- und Dashboard-Sprache nutzen. Lerne die Begriffe in der Reihenfolge kennen, in der sie dir beim Durchsuchen von Daten begegnen.

## Der Weg von der Quelle zum Diagramm {icon="layout-dashboard"}

:::reference
- **Basis:** Ein Arbeitsbereich mit eigenem Zugriff, eigener Aufbewahrung, eigenen Quellen, Dashboards und gespeicherten Abfragen.
- **Quelle:** Eine Verbindung, die Daten an Pulse sendet, zum Beispiel ein Metrikendpunkt, eine Quelle für HTTP-Datenaufnahme oder eine andere App.
- **Ressource:** Das beobachtete Objekt: ein Host, Container, Gerät, Kundenobjekt, eine Bestellung, Filiale, ein Dienst, Akku oder ein beliebiges Fachobjekt.
- **Signal:** Eine benannte Metrik, ein Ereignis oder ein Zustand. Der Name beschreibt, was passiert ist oder gemessen wurde.
- **Variante:** Eine konkrete Signalform für eine Kombination aus Quelle, Ressource und Dimensionen. Varianten erklären, warum ein Signal in vielen Zeilen oder Linien erscheinen kann.
- **Dimension:** Eine Bezeichnung, die Varianten unterscheidet, zum Beispiel Region, Route, Gerät, `compose_service`, Kanal oder `customer_tier`. Verwende hier wiederverwendbare Kategorien, keine eindeutigen Anfrage- oder Personenwerte.
:::

## Wiederholte Zeilen lesen {icon="table"}

:::reference
- **Dasselbe Signal, unterschiedliche Ressourcen:** `docker.container.cpu.usage` kann einmal pro Container erscheinen. Öffne das Signal, um seine Varianten zu sehen, oder die Ressource, um nur einen Container zu sehen.
- **Dieselbe Ressource, unterschiedliche Dimensionen:** Eine Dateisystemmetrik kann einmal pro Einhängepunkt erscheinen. Die Dimensionen zeigen, für welchen Einhängepunkt, welche Schnittstelle, Route, Region oder welchen Kanal die Zeile gilt.
- **Dieselbe Quelle, unterschiedliche Fachbereiche:** Eine Quelle kann heute Infrastrukturdaten und morgen Geschäftsereignisse veröffentlichen. Pulse setzt kein festes Fachvokabular voraus.
:::

## Den passenden Signaltyp wählen {icon="route"}

:::reference
- **Metrik: eine Zahl im Zeitverlauf:** Nutze Metriken für wiederholte Messungen wie CPU-Auslastung, Leistung, Latenz oder Umsatz. Halte Dimensionen stabil, damit die Variantenliste nützlich bleibt.
- **Ereignis: etwas ist passiert:** Nutze Ereignisse für Besuche, QR-Aufrufe, Bestellungen, Anfragen, Deployments und andere Fakten zu einem Zeitpunkt. Ereignisse können Details mit vielen möglichen Werten enthalten, ohne für jeden Wert eine Metrikvariante zu erzeugen.
- **Zustand: was jetzt gilt:** Nutze Zustände für den Online-Status, die aktuelle Version, den Betriebsmodus oder einen anderen letzten Wert. Pulse ergänzt den Verlauf nur, wenn sich der Wert tatsächlich ändert.
:::

## Ereignisfelder einordnen {icon="table"}

:::reference
- **Dimensionen filtern und gruppieren:** Nutze Dimensionen für Bezeichnungen mit einer stabilen Wertemenge, zum Beispiel Kampagne, Kanal, Land, Ergebnis oder Umgebung. Die Abfrage-DSL verwendet Dimensionen für `where` und `group by`.
- **Attribute bewahren detaillierten Kontext:** Nutze Attribute für vollständige URLs, Anfrage-IDs, Referrer, User-Agents und unregelmäßige Ereignisdetails, die du bei einzelnen Ereignissen sehen willst.
- **Vertrauliche Felder laufen eigenständig ab:** Nutze vertrauliche Felder für IP-Adressen, genaue Geodaten und andere geschützte Ereignisdaten. Normale Ereignisergebnisse zeigen diese Felder nicht. Pulse kann sie früher als den Rest des Ereignisses entfernen.
- **Payload hält ergänzende Daten zusammen:** Nutze die Payload für verschachtelte Fachdaten, die du als ein Objekt prüfen, aber nicht filtern oder gruppieren willst.
- **Das Inventar beschreibt verfügbare Felder:** Das **Inventar** zeigt die beobachteten Namen von Dimensionen, Attributen und vertraulichen Feldern mit Rollen, Werttypen, Anzahlen und Zeitstempeln. Es listet nicht jeden gespeicherten Feldwert auf.
- **Identitäten verbinden Aktivitäten:** Nutze `actorId`, `sessionId` und `correlationId` für Personen, Sitzungen und zusammengehörige Aktivitäten. Pulse kann eindeutige Akteure und Sitzungen zählen, ohne sie als Dimensionen anzulegen.
- **Ressourcen bleiben stabil:** Lege Ressourcen für durchsuchbare Objekte an, etwa eine Kampagne, einen QR-Code, Host oder Dienst. Ein Besuch, eine Sitzung, Anfrage, ein Zeitstempel oder eine IP-Adresse ist keine Ressource.
:::

:::note Explizite Ressourcen
Sende `resource: {type, id, label?}`, um ein Signal einem Objekt zuzuordnen. Ohne diese Angabe bleibt das Signal ohne Ressource. Pulse leitet keine Objekte aus allgemeinen Ingest-Dimensionen ab. Ressourcentypen sind Slugs in Kleinbuchstaben. Abfragen wählen mit `resource` den vollständigen Schlüssel `type:id` oder mit `resource_type` eine Klasse. Metriken und Zustände aus unterschiedlichen Quellen bleiben getrennte Varianten.
:::
