---
id: pulse-reference
title: Referenz
icon: ti ti-book
description: Schlage die Syntax für Abfragen und Dashboards nach und kopiere genaue Namen aus dem Inventar.
order: 135
---
Nutze diese Referenz, um Abfragen und Dashboards zu erstellen. Die Syntaxabschnitte zeigen die verfügbaren Anweisungen. Kopiere dann im **Inventar** die genauen Namen, Quellen-IDs, Ressourcen-IDs und Dimensionen aus der aktuellen Basis.

Pulse-Basen, Quellen, Dashboards und gespeicherte Abfragen verwenden stabile IDs aus sechs Zeichen. Beobachtete Ressourcen behalten ihre fachliche Identität. Ereignisse, Messwerte, Reihen und Ausführungsdatensätze sind Telemetriedaten, keine eigenen Ressourcen mit Kurz-ID.

## Wissen, was diese Referenz abdeckt {icon="layout-grid"}

:::info Abfrage-DSL
Rufe Metrikverläufe, einzelne oder zusammengefasste Ereignisse und aktuelle Zustände ab. Der Explorer und die Dashboard-Widgets verwenden dieselbe Sprache.
:::

:::success Dashboard-DSL
Beschreibe Dashboard-Steuerelemente, Abschnitte, Karten, Markdown-Notizen und visuelle Widgets als Text.
:::

:::info Inventar
Durchsuche die aktuelle Basis. Filtere nach Quelle oder Ressource und kopiere eingegrenzte Ausschnitte, statt Namen auswendig zu lernen.
:::

## Mit bekannten Daten arbeiten {icon="shield-lock"}

:::reference
- **Von der Aufgabe ausgehen:** Entscheide vor der Wahl der Syntax, ob die Frage einen Metrikverlauf, Ereigniszeilen, aktuelle Zustände oder eine Dashboard-Ansicht braucht.
- **Namen aus dem Inventar kopieren:** Metriken, Ereignisse, Zustände, Quellen, Ressourcen und Dimensionen sind beobachtete Daten. Leite sie nicht aus Beispielen ab.
- **Dieselbe Ressourcenkennung nutzen:** Die Oberfläche sagt Ressource, die Abfrage-DSL `resource`. Beide meinen dieselbe Kennung, zum Beispiel `container:app-core` oder `customer:acme`.
- **Den Text lesbar halten:** Nutze eindeutige Namen, enge Bereiche und Beschreibungen nahe bei den Diagrammen, die sie erklären.
:::

## Häufige Ausgangspunkte {icon="square-plus"}

**Durchsatz eines Zählers**

```text
metric http_requests_total rate every 1m since 1h where route=/api
```

**Bestellungen pro Stunde**

```text
metric orders.created increase every 1h since 7d where channel=web
```

**Letzte Fehler**

```text
events app.error since 24h where severity=critical limit 100
```

**Täglich eindeutige Besucher**

```text
events page.viewed unique actor every 1d since 30d where channel=web
```

**Aktuelle Integrationszustände**

```text
states integration.online since 10m where integration=webshop limit 200
```
