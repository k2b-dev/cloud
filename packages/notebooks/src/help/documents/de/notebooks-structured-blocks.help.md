---
id: notebooks-structured-blocks
title: "Strukturierte Blöcke"
icon: "ti ti-braces"
description: "Tabellen, Listen, Aufgaben, Daten und Abschnitte mit @ref für Skripte lesbar machen."
order: 130
---

Benannte Blöcke verbinden lesbare Notizen mit Daten, die Skripte lesen können. Setze einen stabilen `@ref` direkt über den Block, der Teil der öffentlichen Notizstruktur werden soll.

## Automatische Seitenlisten und Inhaltsverzeichnisse

Tippe im Editor `:::` und wähle **query** oder **toc**. Im Rich-Modus zeigt jeder Block eine serverseitig gerenderte Vorschau. Bewege den Cursor in den Block oder wähle **Quelltext anzeigen**, um seine Einstellungen zu ändern. Ungültige Einstellungen werden an ihrer Quellzeile markiert. Die Buchansicht zeigt dieselben Ergebnisse ohne Editor.

Diese Abfrage listet Notizen mit dem Tag `handbook`, zuletzt geänderte zuerst:

```text
:::query
source: notes
where:
  - field: $tags
    op: contains-all
    value: [handbook]
sort:
  field: $updated
  direction: desc
limit: 25
:::
```

Abfragen bleiben im aktuellen Notizbuch. Mit `scope: children` oder `scope: descendants` beschränkst du die Liste auf Seiten unterhalb der aktuellen Notiz. Filter können auch eigene benannte Daten wie `profile.owner` verwenden; ein vorgegebenes Metadatenschema ist nicht nötig. Die Vorschau greift auf gespeicherte Notizdaten zu. Das Bearbeiten eines Abfrageentwurfs speichert ihn nicht und verändert keine Ergebnisse.

Ein leerer `:::toc`-Block, abgeschlossen mit `:::`, listet die Überschriften der Seite. Mit `min-depth` und `max-depth` zwischen 1 und 6 wählst du die Überschriftenebenen.

Gespeicherte Änderungen aktualisieren Abfragevorschauen. Hat sich der gespeicherte Quelltext eines schreibgeschützten Editors geändert, lade die Seite neu, um den neuen Quelltext mit passender Vorschau zu sehen.

**@ref**

## Der Vertrag eines Blocks {icon="contract"}

:::reference
- **Stabile Namen:** Verwende kurze kleingeschriebene Namen wie @plants oder @tasks. Benenne sie mit Bedacht um, da Skripte diese Namen aufrufen.
- **Ein Name, eine Bedeutung:** Verwende denselben Namen nicht für verschiedene Begriffe. Automatisierungen sollten nicht erraten müssen, welcher Block gemeint ist.
- **Sichtbare Daten:** Halte Quelldaten in Markdown sichtbar, damit andere Personen das Skript verstehen können, ohne zuerst den Code zu lesen.
- **Zugriff durch Skripte:** Skripte lesen Blöcke mit Hilfsfunktionen wie current.table("plants"), current.todo("tasks") und current.data("recipe").
:::

**Strukturierte Daten**

## Tabellen {icon="table"}

Tabellen eignen sich für kleine strukturierte Listen, etwa Pflanzen, Rezepte, Kontakte, Bücher, Aufgaben oder Ausgaben.

**Benannte Tabelle mit Formeln**

```text
@plants
| Plant | Bed | Status | Progress | Notes |
|---|---|---|---|---|
| Tomato Harzfeuer | Bed A | planted | =PROGRESS(2,4) | keep rain off leaves |
| Bush bean | Bed B | next | =PROGRESS(0.25) | sow into warm soil |
| Chives | Bed C | harvest | =PROGRESS(1) | leave some flowers |
```

**Weitere Blöcke**

## Listen, Aufgaben, Daten und Abschnitte {icon="braces"}

:::reference
- **Tabelle:** Zeilen und Spalten. Skripte erhalten Spalten und Zeilenobjekte.
- **Liste:** Aufzählungspunkte. Nützlich für kleine benannte Sammlungen.
- **Aufgabenliste:** Aufgabeneinträge mit `done`-, `content`- und `line`-Metadaten.
- **Datenblock:** YAML-ähnlicher Datenblock, der als Objekt geparst wird.
- **Abschnitt:** Benannter Markdown-Abschnitt, den Skripte lesen oder ergänzen können.
:::

**Datenquellen für Skripte**

```text
@recipe
:::data
servings: 4
time: 35 min
tags:
  - bavarian
  - weeknight
:::

@shopping
- flour
- eggs
- mountain cheese

@tasks
- [ ] Grate cheese
- [x] Slice onions
```
