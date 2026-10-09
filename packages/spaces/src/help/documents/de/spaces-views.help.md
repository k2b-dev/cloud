---
id: spaces-views
title: Ansichten und Filter
icon: ti ti-filter
description: Liste, Tabelle, Kanban, Kalender, Suche und Filterzustand.
order: 110
---

Ansichten stellen dieselben Einträge passend zur aktuellen Aufgabe dar. Eine gute Ansicht verringert den Aufwand beim Überfliegen, ohne wichtige Zusammenhänge auszublenden.

## Ansichten {icon="layout-list"}

:::reference
- **Liste:** Eignet sich für eine schnelle Einordnung, persönliche Arbeitsvorräte und kurze operative Listen.
- **Tabelle:** Eignet sich, um bei vielen Einträgen zuständige Personen, Fälligkeitsdaten, Status, Prioritäten und Tags zu vergleichen.
- **Kanban:** Eignet sich, wenn der Statusverlauf wichtig ist und der Arbeitsfortschritt zwischen Spalten sichtbar sein soll.
- **Kalender:** Eignet sich für Termine, Fälligkeitsdaten, Planungszeiträume und überwiegend zeitgebundene Arbeit.
:::

## Zeitleiste im Kalender {icon="timeline"}

:::reference
- **Öffnen:** Wähle im Kalender **Zeitleiste** neben **Tag**, **Woche**, **Monat** und **Jahr**. Sie zeigt einen Space als durchgehenden Zeitstreifen. Der Link enthält Ansicht, Tag und Filter, daher öffnen ein Neuladen oder ein geteilter Link denselben Streifen.
- **Lesen:** Die Stunden von 06:00 bis 22:00 sind so lang, wie sie dauern. So siehst du die Dauer von Terminen, freie Zeit dazwischen und den Abend auf einen Blick. Jede Nacht von 22:00 bis 06:00 ist ein schmaler Streifen, und aufeinanderfolgende Tage ohne Einträge mit Uhrzeit sind zu einem zusammengefasst. Ganztägige Termine stehen in einer Zeile über den Stunden.
- **Aufgaben:** Eine Aufgabe erscheint als Markierung zu der Uhrzeit, zu der sie fällig ist. Ein Fälligkeitsdatum hat immer eine Uhrzeit, ohne eigene Wahl 17:00. Eine Aufgabe, deren Fälligkeitsdatum als ganzer Tag gesetzt wurde, steht in der Ganztagszeile. Wenn du den Space bearbeiten darfst, hat die Markierung ein Kästchen, das die Aufgabe erledigt; die Bestätigung bietet **Rückgängig**. Eine Aufgabe, die offene Aufgaben noch blockieren, hat kein Kästchen. Dringende und hohe Priorität und wie viele Aufgaben eine Aufgabe noch blockieren, stehen bei ihrem Titel, wenn Platz ist. Erledigte Einträge werden nicht angezeigt.
- **Farben:** Termine und Aufgaben tragen dieselben Farben wie in den anderen Kalenderansichten, daher ändert die Wahl unter **Farbe nach** in **Umfang** sie auch hier.
- **Überschneidungen:** Bis zu drei gleichzeitige Termine teilen sich den Streifen in Spuren. Weitere werden zu einem Eintrag **+n** zusammengefasst, der sie mit ihren Uhrzeiten auflistet.
- **Durch die Zeit bewegen:** Scrolle seitwärts mit dem Trackpad, einer Wischbewegung oder Umschalt und dem Mausrad. Wenn die Zeitleiste die Seite füllt, scrollt auch das Mausrad seitwärts. Sie beginnt am Abend vor dem gewählten Tag und lädt jeweils eine Woche, sobald du dich einem Ende näherst, insgesamt bis zu einem Jahr. Was du gerade ansiehst, bleibt dabei an seinem Platz. Bringt eine Woche nichts zum Ansehen, lädt der Streifen an diesem Ende erst weiter, wenn du wegscrollst und zurückkommst. **Heute** führt zurück zum aktuellen Tag, die Pfeile öffnen den Streifen einen Tag früher oder später.
- **Telefon:** Auf einem schmalen Bildschirm verläuft derselbe Streifen von oben nach unten.
- **Tastatur:** Die Zeitleiste ist ein einziger Halt für **Tab**. Die Pfeiltasten springen zum vorherigen oder nächsten Eintrag, **Bild↑** und **Bild↓** zum vorherigen oder nächsten Tag, **Pos1** und **Ende** zum ersten oder letzten Eintrag eines Tages und **T** zur aktuellen Uhrzeit. **Enter** öffnet einen Eintrag, und die **Leertaste** erledigt eine Aufgabe, wenn du den Space bearbeiten darfst.
- **Filter:** Die Filter für Umfang, Priorität, Status und Tags im Kalender gelten auch für die Zeitleiste.
:::

## Gezielt filtern {icon="search"}

:::reference
- **Suche:** Verwende die Suche, wenn du dich an ein Wort im Titel, in den Notizen oder in sichtbaren Angaben zum Eintrag erinnerst.
- **Filter-Chips:** Verwende Filter-Chips für eindeutige Merkmale wie Typ, Status, Aktivität, zuständige Person, Priorität, Fälligkeitsdatum, Tags, Kanban-Spalte, Sortierung oder Gruppierung.
- **Inaktive Arbeit:** Der Aktivitätsfilter findet offene Aufgaben, deren letzte Aktivität mindestens 30 Tage zurückliegt. Kommentare und Änderungen an der Checkliste zählen als Aktivität; Spaces verschiebt oder schließt Aufgaben niemals automatisch.
- **URL-Zustand:** Suche und Filter werden in der URL gespeichert. Geteilte Links und neu geladene Seiten behalten deshalb dieselbe Ansicht bei.
:::

## Kanban-Board {icon="layout-kanban"}

:::reference
- **Filter:** Die Leiste über dem Board durchsucht und filtert alle Spalten nach Zuständigkeit, Priorität, Fälligkeitsdatum, Aktivität und Tags. **Mir zugewiesen** zeigt nur deine Arbeit. Solange ein Filter aktiv ist, zeigt jede Spalte, wie viele ihrer Einträge passen, zum Beispiel **2/7**. Eine neue Aufgabe, die nicht zum Filter passt, erhöht nur die Anzahl ihrer Spalte, bis du den Filter zurücksetzt. Filter stehen wie in der Liste in der URL; das Board anderer Personen ändern sie nicht.
- **Spalte einklappen:** Mit der Schaltfläche im Spaltenkopf klappst du eine Spalte, die du gerade nicht brauchst, zu einem schmalen Streifen mit Name und Anzahl ein. Wähle den Streifen, um sie wieder auszuklappen. Auch auf eine eingeklappte Spalte kannst du Karten ziehen; sie landen oben. Eingeklappte Spalten merkt sich dieser Browser für diesen Space und nur für dich.
- **Tastenkürzel:** Die Tastatur-Schaltfläche am Ende der Leiste öffnet eine Liste der Kürzel des Boards.
- **Spalten Blockiert und Überfällig:** Personen mit Schreibzugriff schalten in den Space-Einstellungen unter **Status** zwei automatische Spalten ein. **Blockiert** sammelt offene Aufgaben, die auf unerledigte Aufgaben warten; **Überfällig** sammelt offene Aufgaben, deren Frist vor heute lag. Eine solche Aufgabe erscheint nur dort, ihr Status als kleines Badge, und die Anzahl ihrer Statusspalte zählt sie nicht mit. Eine Aufgabe, die blockiert und überfällig ist, bleibt unter **Blockiert** und zeigt ein Badge **Überfällig**. Für neue und bestehende Spaces sind beide Spalten aus.
- **Arbeiten in einer automatischen Spalte:** In **Blockiert** und **Überfällig** kannst du keine Karte ablegen; sie füllen sich von selbst. Zieh eine Karte heraus, um ihren Status zu ändern: Abschließen verschiebt sie in die erledigte Spalte, jeder andere Status lässt sie mit dem neuen Status-Badge an ihrem Platz, bis sie nicht mehr blockiert oder überfällig ist. Ziehst du eine Karte aus einer erledigten Spalte zurück in einen offenen Status, kommt sie wieder unter **Blockiert** oder **Überfällig**, wenn sie noch blockiert oder überfällig ist. Pfeiltasten, **M** und **D** funktionieren dort wie in jeder Spalte.
- **Spalten umsortieren:** Personen mit Schreibzugriff ziehen einen Spaltenkopf mit Maus oder Stift an eine neue Stelle oder verschieben die Spalte über das Menü **⋯** im Kopf nach links oder rechts. Auf einem Touchscreen scrollt eine Wischbewegung über den Kopf das Board; nutze dort das Menü **⋯**. Die Reihenfolge ändert sich für alle im Space und umfasst die automatischen Spalten; die Liste unter **Status** in den Einstellungen zeigt dieselbe Reihenfolge.
:::

## Farben im Kalender {icon="palette"}

:::reference
- **Farbe nach Tag:** Standardmäßig tragen Termine und Aufgaben die Farbe ihres ersten Tags. Ein Eintrag ohne Tag trägt die Farbe seines Status, und ein Eintrag, dessen Status keine Farbe hat, bleibt ruhig grau. Weitere Tags erscheinen als kleine Punkte hinter dem Titel, wenn Platz ist.
- **Termine und Aufgaben:** Ein Termin ist ein getöntes Band. Eine Aufgabe mit Fälligkeitsdatum ist ein Kästchen in ihrer Farbe vor dem Titel, ohne Band. Dringende und hohe Priorität zeigen eine kleine rote Fahne, egal was die Farben zeigen.
- **Wählen, was die Farbe zeigt:** Öffne **Umfang** und wähle unter **Farbe nach** **Tag**, **Status**, **Priorität** oder **Person**. **Status** nutzt die Statusfarben, **Priorität** die Prioritätsfarben und **Person** die Avatarfarbe der ersten zuständigen Person, weitere zuständige Personen als Punkte; Einträge ohne diesen Wert bleiben grau.
- **In der Adresse gespeichert:** Die Wahl steht wie die Filter in der URL, daher zeigen ein Neuladen oder ein geteilter Link dieselben Farben. Sie ändert nur, wie der Kalender für dich aussieht, nie die Einträge, und ein geöffneter Eintrag bleibt offen. **Zurücksetzen** in **Umfang** setzt die Filter zurück und behält die Farbe.
:::

## Beispiele für die globale Suche {icon="search"}

**Aufgaben finden**

```text
#task launch checklist
```

**Termine finden**

```text
#event planning
```

**Dringende Aufgaben finden**

```text
#todo urgent
```
