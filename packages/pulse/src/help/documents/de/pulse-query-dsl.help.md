---
id: pulse-query-language
title: Query DSL
icon: ti ti-terminal-2
description: Syntax für Metrik-, Ereignis- und Zustandsabfragen mit Aggregationen und Beispielen.
order: 120
---
Query DSL beantwortet jeweils eine Datenfrage. Entscheide, ob du einen Metrikverlauf, einzelne oder zusammengefasste Ereignisse oder aktuelle Zustände benötigst. Grenze die Abfrage anschließend mit Filtern für Quelle, Ressource und Dimensionen ein.

## Die Anweisung nach der Frage wählen {icon="point"}

- **Wie hat sich eine Zahl verändert?** Nutze `metric` und ergänze eine Aggregation wie `avg`, `latest`, `rate` oder `increase`.
- **Was ist zuletzt passiert?** Nutze `events`. Gib einzelne Zeilen zur Prüfung aus oder ermittle Anzahl, Summe und eindeutige Akteure oder Sitzungen im Zeitverlauf.
- **Was gilt jetzt?** Nutze `states`. Zustände geben den letzten bekannten Wert für Fakten wie Online-Status, Version, Konfiguration, Bestand oder aktuellen Zustand zurück.

## Eine Abfrage in vier Schritten erstellen {icon="search"}

:::steps
1. **Das Signal benennen:** Wähle die Metrik, Ereignisart oder den Zustandsschlüssel in der Oberfläche oder im Inventar aus.
2. **Die Form wählen:** Metriken benötigen eine Aggregation. Ereignisse können Zeilen zurückgeben oder mit `count`, `sum` oder `unique` aggregiert werden.
3. **Den Zeitraum festlegen:** Nutze `since` für den Zeitraum und `every` für Zeitfenster von Metriken oder zusammengefassten Ereignissen.
4. **Den Bereich eingrenzen:** Ergänze Filter für `source`, `entity`, `entity_type` oder `where`, wenn das Ergebnis zu viele Varianten oder Zeilen enthält.
:::

## Anweisungstypen {icon="book-2"}

**Metriken**

```text
metric <metric> <aggregation>
  [every <duration>]
  [reduce <sum|avg|min|max>]
  [group by <resource|dimension>]
  [since <duration>]
  [source <source-id>]
  [entity <id>]
  [entity_type <type>]
  [where <key>=<value>, ...]
```

**Ereignisse**

```text
events [<kind>|*]
  [count|sum|unique actor|unique session]
  [every <duration>]
  [group by <dimension>, ...]
  [since <duration>]
  [source <source-id>]
  [entity <id>]
  [entity_type <type>]
  [where <key>=<value>, ...]
  [limit <rows>]
```

**Zustände**

```text
states [<key>|*]
  [since <duration>]
  [source <source-id>]
  [entity <id>]
  [entity_type <type>]
  [where <key>=<value>, ...]
  [limit <rows>]
```

Gemeinsame Klauseln dürfen in beliebiger Reihenfolge auf die anweisungsspezifischen Felder folgen. Schreibe jede Klausel höchstens einmal. Bei Metriken akzeptiert `group by` eine Ressourcen- oder Dimensionsgruppe. Die Ereignisaggregation muss direkt auf die Ereignisart folgen. Zusammengefasste Ereignisse akzeptieren bis zu vier Dimensionsgruppen.

## Beispiele {icon="point"}

**Aktueller Wert eines Geräts**

```text
metric battery.charge_percent latest every 5m since 24h where device="garage-battery"
```

Nutze `latest`, wenn der neueste Messwert wichtiger als der durchschnittliche Verlauf ist.

**Zeitlicher Verlauf**

```text
metric solar.output_watts avg every 15m since 7d where inverter=main
```

Nutze `avg`, um schwankende Messwerte zu glätten, ohne die Einheit zu ändern.

**Durchsatz eines Zählers**

```text
metric http_requests_total rate every 1m since 1h where route=/api
```

Nutze `rate`, wenn ein Zähler fortlaufend steigt und du den Durchsatz pro Sekunde benötigst.

Pulse berechnet `rate` für jede passende Variante und bildet anschließend standardmäßig den Durchschnitt der Varianten. Nutze `reduce sum` für den Gesamtdurchsatz und `group by resource` für eine Reihe pro Ressource.

```text
metric http_requests_total rate every 1m reduce sum group by resource since 1h
```

**Geschäftsvolumen im Zeitverlauf**

```text
metric orders.created increase every 1h since 7d where channel=web
```

Nutze `increase`, wenn du wissen möchtest, wie viele neue Vorgänge in jedem Zeitfenster stattgefunden haben.

Pulse berechnet `increase` für jede passende Variante und bildet anschließend standardmäßig den Durchschnitt der Varianten. Ergänze `reduce sum`, wenn die Varianten zusammen eine Gesamtsumme bilden.

**CPU-Auslastung einer Flotte nach Ressource**

```text
metric system.cpu.usage avg every 5m group by resource since 24h
```

**Dateisystemauslastung nach Einhängepunkt-Dimension**

```text
metric system.filesystem.usage max every 5m group by mount since 24h
```

**Letzte Ereignisse**

```text
events deploy.finished since 7d where env=prod limit 100
```

Nutze einzelne Ereignisse für Zeilen, die du prüfen oder nachvollziehen möchtest.

**Täglich eindeutige Besucher**

```text
events page.viewed unique actor every 1d since 30d where channel=web
```

Nutze `actorId` für die Anzahl eindeutiger Besucher, statt für jede Person einen Dimensionswert anzulegen.

**Aktuelle Zustände**

```text
states integration.enabled entity "webshop" limit 50
```

Nutze Zustände für den aktuell gültigen Wert. Ergänze `since` nur, wenn veraltete Werte nicht erscheinen sollen.

## Klauselreferenz {icon="search"}

| Klausel | Gilt für | Bedeutung | Beispiel |
| --- | --- | --- | --- |
| `metric <metric> <aggregation>` | Metrik | Wählt ein numerisches Signal aus und legt fest, wie Messwerte reduziert werden. Metriken verwenden standardmäßig `every 5m since 24h`. | `metric orders.created increase` |
| `reduce <sum\|avg\|min\|max>` | Metrik | Kombiniert die Werte der Varianten innerhalb jeder Ausgabegruppe. Standard ist `avg`. | `reduce sum` |
| `group by <resource\|dimension>` | Metrik | Gibt eine Ausgabereihe pro Ressource oder Dimensionswert zurück. Ohne diese Klausel bilden alle passenden Varianten eine Ausgabegruppe. | `group by resource` |
| `events [<kind>\|*]` | Ereignisse | Gibt Ereigniszeilen nach Art zurück. Lasse die Art weg oder nutze `*` für alle Ereignisse. Standard ist `since 24h limit 500`. | `events deploy.finished` |
| `count \| sum \| unique actor \| unique session` | Ereignisse | Fasst passende Ereignisse im Zeitverlauf zusammen, statt einzelne Zeilen zurückzugeben. | `events page.viewed unique actor every 1d since 30d` |
| `group by <dimension>, ...` | zusammengefasste Ereignisse | Teilt eine Ereigniszusammenfassung nach einer bis vier Dimensionen auf. | `group by campaign, country` |
| `states [<key>\|*]` | Zustände | Gibt aktuelle Zustandszeilen nach Schlüssel zurück. Lasse den Schlüssel weg oder nutze `*` für alle Zustände. Standard ist `limit 500` ohne Filter für veraltete Werte. | `states host.online` |
| `every <duration>` | Metrik, zusammengefasste Ereignisse | Gruppiert Metrikwerte oder zusammengefasste Ereignisse in feste Zeitfenster. Nutze kompakte Zeitangaben wie `5m`, `1h` oder `7d`. | `every 15m` |
| `since <duration>` | Metrik, Ereignisse, Zustände | Begrenzt den Zeitraum. Zeitangaben verwenden `m`, `h` oder `d` und dürfen 90 Tage nicht überschreiten. Bei Zuständen blendet `since` veraltete aktuelle Werte aus. | `since 7d` |
| `source <source-id>` | alle | Beschränkt die Ergebnisse auf eine Quelle. Der Wert muss eine gültige, aus Pulse kopierte Quellen-ID sein. | `source Src001` |
| `entity <id>` | alle | Beschränkt die Ergebnisse auf eine Ressourcenkennung. Die Oberfläche nennt sie Ressource, Query DSL nennt sie Entity. | `entity container:app-core` |
| `entity_type <type>` | alle | Beschränkt die Ergebnisse auf eine Ressourcenklasse wie Host, Container, Dienst, Gerät, Bestellung oder Kundenobjekt. | `entity_type container` |
| `where <key>=<value>` | alle | Filtert Dimensionen nach exakter Gleichheit. Trenne mehrere Filter mit Kommas. Eine Abfrage akzeptiert bis zu 32 Filter. | `where env=prod, region=eu` |
| `limit <rows>` | Ereignisse, Zustände | Begrenzt die Anzahl zurückgegebener Zeilen. Nutze eine positive ganze Zahl bis höchstens 1000. | `limit 100` |

## Namen, Anführungszeichen und exakte Übereinstimmung {icon="brackets"}

Bei Schlüsselwörtern für Anweisungen und Klauseln spielt die Groß- und Kleinschreibung keine Rolle. Metrikaggregationen verwenden die in dieser Referenz gezeigte Kleinschreibung. Signalnamen, Ressourcenkennungen, Dimensionsschlüssel und Werte behalten ihre Schreibweise und müssen exakt mit den beobachteten Daten übereinstimmen.

Setze Namen und Werte mit Leerzeichen, Kommas oder Gleichheitszeichen in einfache oder doppelte Anführungszeichen:

```text
events "checkout error" where message="payment, provider=offline" limit 50
states "integration label" entity 'service:web shop'
```

Innerhalb eines Werts in Anführungszeichen maskiert ein umgekehrter Schrägstrich das nächste Zeichen:

```text
events app.error where message="customer said \"retry\""
```

Kommas zwischen `where`-Filtern und zwischen Schlüsseln von `group by` sind optional. Sie verbessern die Lesbarkeit, ändern aber nicht die Abfrage.

## Aggregationen {icon="point"}

Wähle die Aggregation nach der Form der Daten, nicht nach dem gewünschten Diagramm. Messwerte beschreiben einen Wert zu einem Zeitpunkt, Zähler steigen nur, und Latenzverteilungen benötigen Perzentile.

| Aggregation | Bedeutung | Geeignet für | Beispiel |
| --- | --- | --- | --- |
| `avg` | Bildet für jede Variante den Durchschnitt der Messwerte in jedem Zeitfenster. | Messwerte wie Auslastung, Temperatur, Leistung oder Qualitätswerte. | `metric solar.output_watts avg every 15m since 7d` |
| `latest` | Verwendet für jede Variante den neuesten Messwert in jedem Zeitfenster. | Aktuelle Messwerte und Statuszahlen. | `metric battery.charge_percent latest every 5m since 24h` |
| `min / max` | Verwendet den kleinsten oder größten Wert in jedem Zeitfenster. | Einbrüche, Spitzen und Kapazitätsprüfungen. | `metric inventory.stock_level max every 1h since 30d` |
| `sum` | Addiert die Messwerte jeder Variante in jedem Zeitfenster. | Werte, deren zeitliche Summe aussagekräftig ist. | `metric sales.revenue sum every 1h since 7d` |
| `count` | Zählt die Messwerte jeder Variante, nicht ihre Werte. | Prüfungen auf vorhandene Messwerte und Datenerfassung. | `metric website.visitors count every 1h since 7d` |
| `rate` | Berechnet die Änderung pro Sekunde und Variante und ignoriert Zählerrücksetzungen. | Anfragen pro Sekunde, Bytes pro Sekunde und Durchsatz. | `metric http_requests_total rate every 1m since 1h` |
| `increase` | Berechnet den Anstieg pro Variante und ignoriert Zählerrücksetzungen. | Bestellungen, Besucher, Anfragen oder Bytes pro Zeitfenster. | `metric sales.orders increase every 1h since 7d` |
| `p50 / p90 / p95 / p99` | Ermittelt ein Perzentil in jedem Zeitfenster. | Latenzen und Verteilungsmetriken. | `metric http_request_duration_seconds p95 every 5m since 24h` |
| `events count / sum` | Zählt Ereignisse oder summiert ihren numerischen Wert in jedem Zeitfenster. | Besuche, Bestellungen, Fehler, Umsatz und andere zeitpunktbezogene Fakten. | `events order.created sum every 1h since 7d group by currency` |
| `events unique actor / session` | Zählt unterschiedliche `actorId`- oder `sessionId`-Werte in jedem Zeitfenster. | Besucher, aktive Personen, Sitzungen und Interaktionen ohne eindeutige Identitäten in Dimensionen. | `events page.viewed unique actor every 1d since 30d` |

## Wichtige Regeln {icon="book-2"}

:::info Metriken fassen Werte zusammen
`metric` erfordert eine Metrik und eine Aggregation. Wähle mit `every` die Zeitfenster und lege mit `since` den Zeitraum fest.
:::

:::note Metrikabfragen verwenden zwei Reduktionsstufen
Pulse wendet die Metrikaggregation zuerst unabhängig auf jede passende Variante an. Anschließend kombiniert es diese Werte mit `reduce`; Standard ist `avg`. Ergänze `group by resource` oder `group by <dimension>`, um mehrere Ausgabereihen zu erzeugen. Nutze `reduce sum` für Flottensummen oder für Zähler, die auf mehrere Schnittstellen verteilt sind.
:::

:::success Ereignisse geben Zeilen oder Punkte zurück
`events` beginnt mit einer Tabellenausgabe. Ergänze `count`, `sum`, `unique actor` oder `unique session`, um einen zeitlichen Verlauf anzuzeigen. `states` gibt aktuelle Zeilen zurück. Grenze sie mit `source`, `entity`, `entity_type`, `where` und `limit` ein.
:::

:::info Namen und Werte
Nutze `*` oder lasse den Namen weg, um alle Ereignisse oder Zustände auszuwählen. `source` akzeptiert eine Quellen-ID aus sechs Zeichen, `entity` die exakte Ressourcenkennung aus Pulse.
:::

:::warning Leistungsgrenzen
Abfragetext ist auf 2.000 Zeichen begrenzt. Metrikabfragen brechen ab, wenn mehr als 250 Varianten übereinstimmen, der angeforderte Zeitraum mehr als 2.000 Zeitfenster erzeugt oder die gruppierte Ausgabe 100.000 Punkte überschreiten würde. Ergänze Filter für `source`, `entity` oder `where`, verkürze `since` oder vergrößere `every`. Ereignis- und Zustandsergebnisse sind auf 1.000 Zeilen begrenzt. Ereigniszusammenfassungen akzeptieren höchstens vier Gruppierungsschlüssel und geben höchstens 1.000 Punkte zurück.
:::
