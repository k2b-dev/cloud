---
id: pulse-dashboard-dsl
title: Dashboard DSL
icon: ti ti-layout-dashboard
description: Steuerelemente, Abschnitte, Zeilen, Karten, Widgets, Markdown und Bedingungen.
order: 130
---
Dashboard DSL beschreibt das gesamte Dashboard. Schreibe den Inhalt als Text und zeige eine Vorschau an. So bleiben Layout, Abfragen, Notizen und visuelle Warnzustände gemeinsam in einem bearbeitbaren Dokument.

## Schrittweise aufbauen {icon="square-plus"}

:::steps
1. **Mit einem Abschnitt beginnen:** Gib dem Dashboard einen Namen und füge den kleinsten Abschnitt hinzu, der eine konkrete Frage beantwortet.
2. **Ein Widget hinzufügen:** Nutze je nach Abfrageausgabe `stat`, `gauge`, `line`, `bar`, `histogram`, `heatmap`, `map` oder `table`.
3. **Steuerelemente bei Wiederholungen ergänzen:** Nutze gemeinsame Steuerelemente für Werte wie `range`, `source`, `entity`, `entity_type`, `label` oder `text`, die mehrere Widgets verwenden.
4. **Zusammengehörige Widgets gruppieren:** Nutze Zeilen für nebeneinanderliegende Diagramme, Karten für zusammengehörige Gruppen und Abschnitte für größere Themen.
5. **Entscheidungen an Ort und Stelle erklären:** Nutze Beschreibungen und Markdown für Betriebshinweise, Annahmen und Links.
:::

## Mit dem kleinsten nützlichen Dashboard beginnen {icon="layout-dashboard"}

**Minimales Dashboard**

```text
dashboard "Ops" {
  section "Overview" {
    stat "Requests" {
      query metric http_requests_total rate every 1m since 1h
    }
  }
}
```

Das genügt für eine nützliche Darstellung: ein Wurzeldokument, ein Abschnitt, ein Widget und eine Abfrage. Ein leeres Dokument `dashboard "Name" {}` ist beim Erstellen eines Dashboards gültig, enthält aber noch nichts, das angezeigt werden kann.

## Dashboard DSL exakt schreiben {icon="braces"}

Bei Dashboard-Anweisungen und Namen visueller Darstellungen wird zwischen Groß- und Kleinschreibung unterschieden. Verwende die Schreibweise aus dieser Referenz, einschließlich `barGauge`.

Namen, Beschreibungen, Meldungen und andere Texte in Anführungszeichen verwenden doppelte Anführungszeichen. Innerhalb solcher Texte erzeugt `\n` einen Zeilenumbruch, `\t` einen Tabulator und ein umgekehrter Schrägstrich maskiert das folgende Zeichen. Markdown-Inhalte verwenden dreifache doppelte Anführungszeichen:

```text
description "Line one\nLine two"

markdown "Runbook" {
  """
  ## Recovery

  Follow the service runbook.
  """
}
```

Nutze `#` oder `//` für Zeilenkommentare an Stellen, an denen Leerraum erlaubt ist.

## Steuerelemente für wiederholte Werte hinzufügen {icon="point"}

**Steuerelemente und Variablen**

```text
dashboard "Ops" {
  controls {
    range "Range" variable range default 24h options 1h, 6h, 24h, 7d
    entity "Container" variable entity_id type container default container:app-core
  }

  section "Container" {
    line "Memory" {
      query metric docker.container.memory.usage avg every 5m since $range entity $entity_id
    }
  }
}
```

Steuerelemente erzeugen Variablen wie `$range` oder `$entity_id`. Fehlt `variable`, leitet Pulse die Variable aus der Bezeichnung ab. Aus `Resource type` wird zum Beispiel `$resource_type`. Fehlt `default`, verwendet Pulse die erste Option. Ein Zeitraum ohne Standardwert und Optionen verwendet `24h`; andere Steuerelemente verwenden einen leeren Wert.

Öffentliche Anzeigen verwenden die Standardwerte der Steuerelemente und zeigen keine interaktiven Steuerelemente. Wähle deshalb Standardwerte, die ohne Interaktion sinnvoll sind.

## Vollständige Struktur {icon="point"}

**Struktur**

```text
dashboard "Name" {
  description "Optional context."

  controls {
    range "Range" variable range default 24h options 1h, 6h, 24h, 7d
    source "Source" variable source_id default Src001
    entity "Entity" variable entity_id type container default container:app-core
    label "Region" variable region default eu options eu, us
    text "Search" variable search default ""
  }

  section "Section" {
    row height md {
      line "Chart title" {
        query metric orders.created increase every 1h since $range source $source_id where region=$region
        warn when value > 100
      }
    }

    table "Recent events" {
      query events deploy.finished since $range entity $entity_id limit 50
    }

    table "Current states" {
      query states service.online entity $entity_id limit 50
    }

    map "Recent engagement" {
      description "Approximate places where recent QR links were opened."
      query events qr.opened since $range where campaign=summer limit 500
      latitude attribute geo.latitude
      longitude attribute geo.longitude
      label attribute geo.city
      series dimension campaign
      size count
    }

    markdown "Notes" {
      """
      ## Markdown content
      Add context, links, and operating notes.
      """
    }
  }
}
```

**Beispiel**

```text
dashboard "Solar overview" {
  description "Live power, battery state, and grid interaction."

  section "Today" {
    description "Operational view for the current day."

    card "Battery" {
      description "Shows current charge and recent charge/discharge trend."

      gauge "Charge" {
        description "Latest state of charge reported by the inverter."
        query metric solar.battery.charge_percent latest since 10m
        warn when value < 20 message "Battery is low"
        critical when value < 10 message "Battery is critical"
      }
    }

    markdown "Notes" {
      """
      ## Operating notes

      - Values update every minute.
      - Grid import above 2 kW usually means the battery is empty.
      - Check inverter status if output drops while irradiance is high.
      """
    }
  }
}
```

## Anweisungsreferenz {icon="book-2"}

| Anweisung | Bereich | Bedeutung | Beispiel |
| --- | --- | --- | --- |
| `dashboard "Name" { ... }` | root | Definiert ein Dashboard. Bearbeite dieses Dokument, um Inhalt und Layout zu ändern. | `dashboard "Ops" { stat "Status" { query metric service.online latest since 10m } }` |
| `description "Text"` | dashboard, section, card, widget, markdown | Ergänzt Kontext für die lesende Person, ohne Datenabfragen zu ändern. | `description "Live operational view."` |
| `controls { ... }` | dashboard | Deklariert wiederverwendbare Variablen, die über dem Dashboard angezeigt werden. | `controls { range "Range" variable range default 24h options 1h, 24h }` |
| `range/source/entity/entity_type/label/text "Label"` | controls | Erstellt ein Steuerelement. Nutze `variable`, `default`, `options` und `type`, wenn sie benötigt werden. Fehlt `default`, wird die erste Option verwendet. | `entity "Container" variable entity_id type container default container:app-core` |
| `section "Name" { ... }` | dashboard, section | Gruppiert zusammengehörige Zeilen und verschachtelte Abschnitte. | `section "Today" { line "Orders" { query metric orders.created increase since 24h } }` |
| `row height sm\|md\|lg { ... }` | dashboard, section, card | Ordnet mehrere Widgets in einer Zeile an. Fehlt `height`, wird `md` verwendet. | `row height lg { line "CPU" { query metric system.cpu.usage avg since 6h } }` |
| `card "Name" [span n] { ... }` | dashboard, section, row | Umrahmt zusammengehörige untergeordnete Widgets und optionales Markdown. Karten dürfen keine verschachtelten Karten oder Abschnitte enthalten. `span` ist eine optionale ganze Zahl von 1 bis 12. | `card "Battery" span 6 { gauge "Charge" { query metric battery.charge latest since 10m } }` |
| `markdown ["Name"] [span n] { """ ... """ }` | dashboard, section, row, card | Ergänzt Markdown-Notizen, Erklärungen, Runbooks oder Links. Markdown-Inhalte müssen in dreifachen Anführungszeichen stehen. | `markdown "Notes" { """## Notes\n- Check importer health.""" }` |
| `line/bar/stat/gauge/barGauge/histogram/heatmap/table "Name"` | dashboard, section, row, card | Ergänzt ein Widget für eine Metrik, ein zusammengefasstes Ereignis, Ereigniszeilen oder Zustände. Metrik- und zusammengefasste Ereignisabfragen nutzen numerische Darstellungen; Ereigniszeilen nutzen Tabellen; Zustände nutzen Tabellen oder Statusanzeigen. | `gauge "Charge" { query metric battery.charge latest since 10m }` |
| `map "Name" [span n] { ... }` | dashboard, section, row, card | Stellt Ereignisorte dar. Erfordert eine Abfrage für Ereigniszeilen sowie Selektoren für Breiten- und Längengrad. | `map "Scans" { query events qr.opened since 24h latitude attribute geo.latitude longitude attribute geo.longitude }` |
| `latitude\|longitude dimension\|attribute <path>` | map | Wählt Koordinaten in Dezimalgrad aus einer Dimension oder einem Attribut aus. Verschachtelte Attributpfade verwenden Punkte. Vertrauliche Felder können nicht ausgewählt werden. | `latitude attribute geo.latitude` |
| `label\|series dimension\|attribute <path>` | map | Ergänzt optional Punktbeschriftungen oder trennt Punkte in farbige Reihen. | `series dimension campaign` |
| `size count\|sum` | map | Bestimmt die Punktgröße anhand der Anzahl passender Ereignisse oder der Summe numerischer Ereigniswerte. Standard ist `count`. | `size count` |
| `visual <type>` | widget | Überschreibt die visuelle Darstellung, die das äußere Widget-Schlüsselwort festlegt. Akzeptiert dieselben Namen für visuelle Darstellungen. Nutze in manuell geschriebener DSL bevorzugt das direkte Widget-Schlüsselwort. | `line "Current value" { visual stat query metric service.online latest since 10m }` |
| `query <Query DSL>` | widget | Verwendet Query DSL für Metriken, Ereignisse oder Zustände. Dashboard-Steuerelemente können als `$variables` referenziert werden. Zusammengefasste Ereignisse können numerische Widgets versorgen. | `query events order.created count every 1h since $range group by channel` |
| `warn\|critical when value <op> <value>` | metric widget | Wendet einen visuellen Zustand nur auf Metrikwerte an. Operatoren sind `>`, `>=`, `<`, `<=`, `=` und `!=`. Ein optionaler Meldungstext kann die Bedingung erklären. | `critical when value > 95 message "Capacity almost full"` |
| `# comment or // comment` | überall, wo Leerraum erlaubt ist | Ergänzt einen Zeilenkommentar, der das dargestellte Dashboard nicht verändert. | `# explain why this section exists` |

## Gestaltungsregeln {icon="book-2"}

:::info Dashboards setzen Abfrageausgaben zusammen
`query`-Zeilen in Widgets verwenden dieselbe Query DSL. Metriken und zusammengefasste Ereignisse zeigen Werte und Diagramme. Tabellen-Widgets zeigen einzelne Ereignisse und aktuelle Zustände. `group by resource` und `group by <dimension>` erzeugen für Metriken getrennte Diagrammreihen.
:::

:::info Karten fassen Ereignisorte zusammen
Nutze eine Karte für Ereignisse mit Feldern für Breiten- und Längengrad in Dezimalgrad. Pulse gruppiert passende Ereignisse im ausgewählten Zeitraum nach Ort, optionaler Beschriftung und optionaler Reihe. Ungültige Koordinaten und Koordinaten außerhalb des gültigen Bereichs werden ignoriert. Eine Karte zeigt höchstens 1.000 zusammengefasste Punkte. Nutze Filter für Quelle, Entity und Dimensionen, wenn eine breite Abfrage nützliche Details verdecken würde. Auf einem öffentlichen Dashboard sind auch die von der Karte gezeigten zusammengefassten Koordinaten, Beschriftungen und Reihen öffentlich.
:::

:::info Steuerelemente definieren Variablen
Deklariere Steuerelemente einmal und verwende ihre Variablen anschließend in Widget-Abfragen. So bleiben Dashboards bearbeitbar, ohne Filter zu duplizieren.
:::

:::info Öffentliche Anzeigen verwenden Standardwerte
Öffentliche Links stellen jedes Steuerelement mit seinem Standardwert dar. Wähle nützliche Standardwerte, damit öffentliche Dashboards deterministisch bleiben.
:::

:::info Aktualisierung ist eine Dashboard-Einstellung
Die automatische Aktualisierung wird außerhalb von Dashboard DSL konfiguriert. Wähle 1, 5, 10 oder 60 Sekunden oder deaktiviere die automatische Aktualisierung. Neue Dashboards verwenden standardmäßig fünf Sekunden. Beim Bearbeiten der DSL bleibt die vorhandene Aktualisierungseinstellung erhalten.
:::

:::warning Bedingungen sind visuell
Nutze `warn when value > 80` oder `critical when value = false`, um Metrik-Widgets visuell zu kennzeichnen. Die Zustellung von Warnungen und Webhooks ist eine getrennte, zukünftige Ebene.
:::

## Grenzen {icon="ruler"}

- Dashboard DSL ist auf 40.000 Zeichen begrenzt.
- Titel sind auf 160 Zeichen begrenzt. Dashboard-Beschreibungen sind auf 1.000 Zeichen begrenzt, Beschreibungen von Abschnitten, Karten, Widgets und Markdown auf 500 Zeichen.
- Ein Markdown-Block ist auf 8.000 Zeichen begrenzt.
- Ein Dashboard unterstützt bis zu 24 Steuerelemente und 24 Abschnitte auf oberster Ebene.
- Ein Abschnitt unterstützt bis zu 24 Zeilen und 12 verschachtelte Abschnitte. Verschachtelte Abschnitte enden nach drei untergeordneten Ebenen.
- Eine Zeile unterstützt bis zu 12 Zellen. `span` muss eine ganze Zahl von 1 bis 12 sein.
- Ein Widget unterstützt bis zu acht visuelle Bedingungen.
