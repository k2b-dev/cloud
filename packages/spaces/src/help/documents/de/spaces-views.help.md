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

## Überfällige Aufgaben und Aufgaben ohne Datum in der Tagesansicht {icon="calendar-due"}

:::reference
- **Was sie zeigt:** In der Ansicht **Tag** des Kalenders zeigt eine Zeile unter dem Tag offene Aufgaben, deren Fälligkeitsdatum vor heute lag, die jüngsten zuerst, und offene Aufgaben ohne Fälligkeitsdatum, die dir zugewiesen sind, die dringendsten zuerst. Jeder Teil zeigt bis zu fünf Aufgaben; **Alle anzeigen** öffnet die Liste mit allen.
- **Damit arbeiten:** Wähle eine Aufgabe, um sie zu öffnen, oder hake sie ab, wenn du den Space bearbeiten darfst; die Bestätigung bietet **Rückgängig**. Eine Aufgabe, die offene Aufgaben noch blockieren, zeigt ein Schloss statt eines Kästchens.
- **Darstellung:** Die Zeile behält Platz und Größe, egal was sie enthält. Der Tag darüber verschiebt sich daher nie. Während ein anderer Tag oder Filter lädt, bleibt die Zeile leer, bis ihre Aufgaben da sind. Passen nicht alle Aufgaben hinein, scrollt die Zeile seitwärts. Ein Screenreader und **Tab** erreichen sie wie auf dem Bildschirm direkt nach dem Tag. Hakst du eine Aufgabe mit der Tastatur ab, springt der Fokus zur nächsten Aufgabe der Zeile.
- **Filter:** Die Filter für Umfang, Priorität, Status und Tags im Kalender gelten auch für die Zeile; lässt ein Filter sie leer, sagt sie das. Zeigt der Umfang nur Termine, ist die Zeile ausgeblendet.
- **Alte Links:** Spaces hat keine Zeitleiste im Kalender mehr. Ein gespeicherter Link auf die Zeitleiste öffnet den Monat, in dem sein Tag liegt.
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

## Planen in der Monatsansicht {icon="calendar-month"}

:::reference
- **Werkzeugleiste:** Die Filter **Umfang**, **Priorität**, **Status** und **Tags** und die Zahl der angezeigten Einträge stehen direkt hinter dem Monatsnamen, in jeder Kalenderansicht. Ist der Kalender schmaler, zeigen die Filter nur ihr Symbol oder rücken in eine eigene Zeile.
- **Tage auswählen:** Ein Klick oder Tippen wählt einen Tag aus und verlässt den Monat nie. Ziehe über mehrere Tage oder halte die **Umschalttaste** beim Klicken oder bei den Pfeiltasten, um mehrere auszuwählen. Die Pfeiltasten verschieben die Auswahl, **Bild auf** und **Bild ab** wechseln den Monat, **Esc** hebt die Auswahl auf.
- **Auf der Auswahl erstellen:** Nach einem Klick wartet neben dem Tag ein kleines Formular **Neuer Eintrag**, ohne die Tastatur zu übernehmen: Tippe einfach los oder drücke **Tab**, um es auszufüllen. Nach dem Ziehen über Tage, einem Doppelklick, der **Eingabetaste** oder **N** öffnet es sich bereit für den Titel, auf dem Handy mit einem zweiten Tippen auf den ausgewählten Tag. Wähle **Termin**, **Ganztägig** oder **Aufgabe**; die Zeile daneben sagt, wann. Die **Eingabetaste** legt an, **Mit Details** öffnet das volle Formular, **Esc** oder ein Klick daneben bricht ab. Ziehen über mehrere Tage legt einen ganztägigen Termin über alle an. **Neuer Termin** in der Werkzeugleiste öffnet das volle Formular für die ausgewählten Tage.
- **Menü:** Ein Rechtsklick, auf dem Handy langes Drücken, oder **Umschalt+F10** auf einen Tag oder die ausgewählten Tage bietet **Neuer Termin**, **Neuer ganztägiger Termin** und **Neue Aufgabe mit Fälligkeit** für diese Tage an, danach **Tag öffnen** und **Woche öffnen**.
- **Einen Tag oder eine Woche öffnen:** Wähle einen Tag aus und dann **Tag** oder **Woche** in der Ansichtsauswahl, nutze **Tag öffnen** im Menü oder in der Tagesliste, oder klicke auf eine Kalenderwoche.
- **Lange Termine:** Ein Termin über mehrere Tage ist pro Wochenzeile ein Balken mit seinem Titel. Wo eine Wochenzeile ihn abschneidet, ist sein Ende abgerissen, und wenn Platz ist, steht dort, wo er weitergeht, zum Beispiel **bis 13.** oder **seit 7.** Die nächste Zeile führt ihn fort, und zeigst du auf einen Teil, leuchten die anderen mit.
- **Volle Tage:** Jeder Tag zeigt so viele Einträge, wie in seine Höhe passen; **+N weitere** zählt den Rest und öffnet den ganzen Tag, ebenso die **Leertaste** auf einem ausgewählten Tag.
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
