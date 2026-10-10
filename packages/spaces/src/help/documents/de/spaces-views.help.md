---
id: spaces-views
title: Ansichten und Filter nutzen
icon: ti ti-filter
description: Wähle zwischen den Ansichten Liste, Tabelle, Kanban und Kalender, filtere die Einträge und plane in der Tages- und Monatsansicht.
order: 110
---

Ansichten stellen dieselben Einträge passend zur aktuellen Aufgabe dar. Eine gute Ansicht verringert den Aufwand beim Überfliegen und blendet keine wichtigen Zusammenhänge aus.

## Ansicht wählen {icon="layout-list"}

:::reference
- **Liste:** Eignet sich für eine schnelle Einordnung, persönliche Arbeitsvorräte und kurze operative Listen.
- **Tabelle:** Eignet sich, um bei vielen Einträgen zuständige Personen, Fälligkeitsdaten, Status, Prioritäten und Tags zu vergleichen.
- **Kanban:** Eignet sich, wenn der Statusverlauf wichtig ist und der Arbeitsfortschritt zwischen Spalten sichtbar sein soll.
- **Kalender:** Eignet sich für Termine, Fälligkeitsdaten, Planungszeiträume und überwiegend zeitgebundene Arbeit.
:::

## Aufgaben in der Liste abhaken {icon="checkbox"}

:::reference
- **Aufgabe abhaken:** Wähle das Kästchen vor der Aufgabe. Unter dem Zeiger oder mit dem Tastaturfokus zeigt ein offenes Kästchen zuerst einen blassen Haken. Hakst du es ab, füllt sich das Kästchen sofort, und der Titel wird durchgestrichen.
- **Wenn die Aufgabe die Liste verlässt:** Blenden die Filter erledigte Aufgaben aus, bleibt die Aufgabe einen Moment an ihrem Platz. Dann schließt sich ihre Zeile. War sie die letzte Aufgabe ihrer Gruppe, schließt sich die Gruppe mit ihr. Die Bestätigung unten bietet **Rückgängig**, auch wenn die Zeile schon weg ist. **Rückgängig** öffnet die Aufgabe wieder, mit ihrem vorherigen Status und an ihrer vorherigen Position, und die Aktivität zeigt die Aufgabe als wieder geöffnet. Solange die Zeile noch da ist, kannst du das Kästchen auch wieder leeren.
- **Mehrere Aufgaben:** Hake eine Aufgabe nach der anderen ab, ohne zu warten. Während du abhakst oder den Zeiger über die Liste bewegst, verschiebt sich keine Zeile. Hältst du einen Moment inne, schließen sich die Zeilen der abgehakten Aufgaben gemeinsam.
- **Auf einem Touchscreen:** Tippst du knapp neben das Kästchen, hakst du die Aufgabe auch ab. Tippst du auf den Titel, öffnet sich die Aufgabe.
- **Übernahmen:** Wenn du eine Aufgabe abschließt, endet ihre Übernahme. **Rückgängig** stellt die Übernahme nicht wieder her.
:::

## Überfällige Aufgaben und Aufgaben ohne Datum in der Tagesansicht bearbeiten {icon="calendar-due"}

:::reference
- **Was sie zeigt:** In der Ansicht **Tag** des Kalenders zeigt eine Zeile unter dem Tag zwei Arten offener Aufgaben. Zuerst Aufgaben, deren Fälligkeitsdatum vor heute lag, die jüngsten zuerst. Dann Aufgaben ohne Fälligkeitsdatum, die dir zugewiesen sind, die dringendsten zuerst. Jeder Teil zeigt bis zu fünf Aufgaben. **Alle anzeigen** öffnet die Ansicht **Liste** mit allen.
- **Damit arbeiten:** Wähle eine Aufgabe, um sie zu öffnen. Wenn du den Space bearbeiten kannst, kannst du sie auch abhaken. Sie bleibt einen Moment in der Zeile, dann schließt sich die Lücke. Die Bestätigung bietet **Rückgängig**. Ziehe eine Aufgabe in freie Zeit des Tages, um sie dort einzuplanen. Eine Aufgabe, die offene Aufgaben noch blockieren, zeigt ein Schloss statt eines Kästchens.
- **Darstellung:** Die Zeile behält Platz und Größe, egal was sie enthält. Der Tag darüber verschiebt sich daher nie. Während ein anderer Tag oder Filter lädt, bleibt die Zeile leer, bis ihre Aufgaben da sind. Passen nicht alle Aufgaben hinein, scrollt die Zeile seitwärts. Ein Screenreader und **Tab** erreichen sie wie auf dem Bildschirm direkt nach dem Tag. Hakst du eine Aufgabe mit der Tastatur ab, springt der Fokus zur nächsten Aufgabe der Zeile.
- **Filter:** Die Filter für Umfang, Priorität, Status und Tags im Kalender gelten auch für die Zeile. Lässt ein Filter die Zeile leer, sagt sie das. Zeigt der Umfang nur Termine, ist die Zeile ausgeblendet.
- **Alte Links:** Spaces hat keine Zeitleiste im Kalender mehr. Ein gespeicherter Link auf die Zeitleiste öffnet den Monat, in dem sein Tag liegt.
:::

## Gezielt filtern {icon="search"}

:::reference
- **Suche:** Nutze die Suche, wenn du dich an ein Wort im Titel, in den Notizen oder in sichtbaren Angaben zum Eintrag erinnerst.
- **Filter-Chips:** Nutze Filter-Chips für eindeutige Merkmale wie Typ, Status, Aktivität, zuständige Person, Priorität, Fälligkeitsdatum, Tags, Kanban-Spalte, Sortierung oder Gruppierung.
- **Gruppen:** In der **Übersicht** geht eine Gruppe auf der nächsten Seite weiter, und die Zahl daneben zählt alle passenden Einträge der Gruppe, auch die auf anderen Seiten. Innerhalb einer Gruppe folgen die Einträge der Sortierung. Eine Aufgabe mit mehreren Tags steht unter jedem ihrer Tags. Die **Tabelle** gruppiert nicht, ihre Zeilen folgen also nur der Sortierung.
- **Inaktive Arbeit:** Der Aktivitätsfilter findet offene Aufgaben, deren letzte Aktivität mindestens 30 Tage zurückliegt. Kommentare und Änderungen an der Checkliste zählen als Aktivität. Spaces verschiebt oder schließt Aufgaben nie automatisch.
- **URL-Zustand:** Suche und Filter stehen in der URL. Geteilte Links und neu geladene Seiten behalten deshalb dieselbe Ansicht.
:::

## Mit dem Kanban-Board arbeiten {icon="layout-kanban"}

:::reference
- **Filter:** Die Leiste über dem Board durchsucht und filtert alle Spalten nach Zuständigkeit, Priorität, Fälligkeitsdatum, Aktivität und Tags. **Mir zugewiesen** zeigt nur deine Arbeit. Solange ein Filter aktiv ist, zeigt jede Spalte, wie viele ihrer Einträge passen, zum Beispiel **2/7**. Eine neue Aufgabe, die nicht zum Filter passt, erhöht nur die Anzahl ihrer Spalte, bis du den Filter zurücksetzt. Filter stehen wie in den anderen Ansichten in der URL. Das Board anderer Personen ändern sie nie.
- **Spalte einklappen:** Mit der Schaltfläche im Spaltenkopf klappst du eine Spalte ein, die du gerade nicht brauchst. Sie wird zu einem schmalen Streifen mit Name und Anzahl. Wähle den Streifen, um die Spalte wieder auszuklappen. Auch auf eine eingeklappte Spalte kannst du Karten ziehen; sie landen oben. Dieser Browser merkt sich eingeklappte Spalten für diesen Space und nur für dich.
- **Tastenkürzel:** Die Tastatur-Schaltfläche am Ende der Leiste öffnet eine Liste der Kürzel des Boards.
- **Aktivität:** Ziehst du eine Karte in einen erledigten Status, zeigt die Aktivität die Aufgabe als erledigt. Ziehst du sie zurück in einen offenen Status, zeigt die Aktivität sie als wieder geöffnet.
- **Spalten Blockiert und Überfällig:** Mit Zugriff **Bearbeiten** schaltest du in den Space-Einstellungen unter **Status** zwei automatische Spalten ein. **Blockiert** sammelt offene Aufgaben, die auf unerledigte Aufgaben warten. **Überfällig** sammelt offene Aufgaben, deren Frist vor heute lag. Eine solche Aufgabe erscheint nur dort, mit ihrem Status als kleinem Badge. Die Anzahl ihrer Statusspalte zählt sie nicht mit. Eine Aufgabe, die blockiert und überfällig ist, bleibt unter **Blockiert** und zeigt ein Badge **Überfällig**. Für neue und bestehende Spaces sind beide Spalten aus.
- **In einer automatischen Spalte arbeiten:** In **Blockiert** und **Überfällig** kannst du keine Karte ablegen; sie füllen sich von selbst. Zieh eine Karte heraus, um ihren Status zu ändern. Abschließen verschiebt sie in die erledigte Spalte. Jeder andere Status lässt sie mit dem neuen Status-Badge an ihrem Platz, bis sie nicht mehr blockiert oder überfällig ist. Ziehst du eine Karte aus einer erledigten Spalte zurück in einen offenen Status, kommt sie wieder unter **Blockiert** oder **Überfällig**, wenn sie noch blockiert oder überfällig ist. Pfeiltasten, **M** und **D** funktionieren dort wie in jeder Spalte.
- **Spalten umsortieren:** Mit Zugriff **Bearbeiten** ziehst du einen Spaltenkopf mit Maus oder Stift an eine neue Stelle. Oder du verschiebst die Spalte über das Menü **⋯** im Kopf nach links oder rechts. Auf einem Touchscreen scrollt eine Wischbewegung über den Kopf das Board; nutze dort das Menü **⋯**. Die Reihenfolge ändert sich für alle im Space und umfasst die automatischen Spalten. Die Liste unter **Status** in den Einstellungen zeigt dieselbe Reihenfolge.
:::

## In der Monatsansicht planen {icon="calendar-month"}

:::reference
- **Werkzeugleiste:** In jeder Kalenderansicht stehen die Filter **Umfang**, **Priorität**, **Status** und **Tags** und die Zahl der angezeigten Einträge direkt hinter dem Monatsnamen. In der Monatsansicht zählt die Zahl nur die Einträge dieses Monats, nicht die auf den blassen Tagen des Vor- und Folgemonats. Ist der Kalender schmaler, zeigen die Filter nur ihr Symbol oder rücken in eine eigene Zeile.
- **Tage auswählen:** Wähle einen Tag, um ihn auszuwählen. Dabei verlässt du den Monat nie. Um mehrere Tage auszuwählen, ziehe mit der Maus über sie. Oder halte die **Umschalttaste**, während du Tage wählst oder die Pfeiltasten nutzt. Auf dem Handy wählt eine Berührung genau einen Tag aus. Die Pfeiltasten verschieben die Auswahl, **Bild auf** und **Bild ab** wechseln den Monat, **Esc** hebt die Auswahl auf.
- **Auf der Auswahl erstellen:** Wählst du einen Tag mit der Maus, wartet neben dem Tag ein kleines Formular **Neuer Eintrag**. Der Fokus bleibt auf dem Tag: Tippe los oder drücke **Tab**, um das Formular auszufüllen. Nach dem Ziehen über Tage, einem Doppelklick, der **Eingabetaste** oder **N** öffnet es sich bereit für den Titel. Auf dem Handy berührst du dafür den ausgewählten Tag ein zweites Mal. Wähle **Termin**, **Ganztägig** oder **Aufgabe**; die Zeile daneben sagt, wann. Die **Eingabetaste** legt den Eintrag an, und **Mit Details** öffnet das volle Formular. Drücke **Esc** oder wähle eine Stelle außerhalb des Formulars, um abzubrechen. Ziehen über mehrere Tage oder **Neuer Termin** im Menü mehrerer Tage legt einen ganztägigen Termin über alle an. **Neuer Termin** in der Werkzeugleiste öffnet das volle Formular für die ausgewählten Tage.
- **Menü:** Öffne es mit einem Rechtsklick, auf dem Handy mit langem Drücken oder mit **Umschalt+F10** auf einem Tag oder den ausgewählten Tagen. Das Menü bietet **Neuer Termin**, **Neuer ganztägiger Termin** und **Neue Aufgabe mit Fälligkeit** für diese Tage an, danach **Tag öffnen** und **Woche öffnen**.
- **Einen Tag oder eine Woche öffnen:** Wähle einen Tag aus und dann **Tag** oder **Woche** in der Ansichtsauswahl. Oder nutze **Tag öffnen** im Menü oder in der Tagesliste. Oder wähle eine Kalenderwoche.
- **Lange Termine:** Ein Termin über mehrere Tage ist pro Wochenzeile ein Balken mit seinem Titel. Wo eine Wochenzeile ihn abschneidet, ist sein Ende abgerissen. Wenn Platz ist, steht dort, wo er weitergeht, zum Beispiel **bis 13.** oder **seit 7.** Die nächste Zeile führt ihn fort. Zeigst du auf einen Teil, leuchten die anderen Teile mit.
- **Volle Tage:** Jeder Tag zeigt so viele Einträge, wie in seine Höhe passen. **+N weitere** zählt den Rest und öffnet den ganzen Tag. Die **Leertaste** auf einem ausgewählten Tag tut dasselbe.
:::

## In der Tages- und Wochenansicht planen {icon="calendar-time"}

:::reference
- **Tagesbeginn:** Ein Tag läuft von 06:00 bis 06:00 am nächsten Tag. Die Nacht nach 22:00 gehört zum Vortag. Ein Termin von 23:00 bis 01:30 bleibt also bei seinem Abend.
- **Nächte:** Eine Nacht ohne Einträge ist eine schmale Zeile. Eine Nacht mit Eintrag ist offen und halb so hoch. Wähle die Nachtleiste oder den Mond, um die Nacht ein- oder auszuklappen.
- **Tagesansicht:** Die Tage laufen in einem Stück nach unten. Jeder Tag behält seine Überschrift oben, solange er zu sehen ist. Leere Tage fallen zu einer Zeile **Nichts geplant** zusammen. Wähle die Zeile, um die Tage zu zeigen. Die Ansicht bremst an jedem Tagesbeginn. Hältst du knapp davor an, rückt die Ansicht auf den Tagesbeginn. Beim Scrollen laden weitere Tage.
- **Wochenansicht:** Die Tage laufen seitwärts in einem Streifen: sieben auf einem breiten Bildschirm, drei auf dem Handy. Scrolle seitwärts mit dem Trackpad, mit der **Umschalttaste** und dem Mausrad oder mit dem Finger. Der Streifen hält an einem Tagesbeginn. Die Pfeile springen um ganze Wochen. **Heute** kehrt zu dieser Woche zurück.
- **Einträge:** Ein Termin ist ein Band, so lang wie der Termin. Der laufende Termin füllt sich und zeigt die restliche Zeit, zum Beispiel **noch 27 Min**. Eine Aufgabe mit Fälligkeit ist eine gestrichelte Linie mit Kästchen. Wenn du den Space bearbeiten kannst, hakst du sie dort ab oder drückst auf ihr die **Leertaste**. Ziehe die Linie, um die Fälligkeit auf eine andere Zeit zu legen. Ein Termin über mehrere Tage ist ein Balken in der Ganztagszeile. Wo die Woche den Balken abschneidet, ist sein Ende abgerissen. Ist Platz, sagt der Balken, wo der Termin weitergeht, zum Beispiel **seit 20.** oder **bis 27.**
- **Freie Zeit:** Eine Lücke ab einer Stunde zeigt ihre Länge, zum Beispiel **1 Std. frei**. Wähle eine Lücke, um dort einen Termin anzulegen. In der Wochenansicht erscheint freie Zeit, wenn du auf einen Tag zeigst oder ihn auswählst. Ziehe über leere Zeit, um einen Termin dieser Länge anzulegen.
- **Aufgabe einplanen:** Ziehe eine Aufgabe aus der Zeile unter der Tagesansicht in freie Zeit. Die Lücke zeigt **passt** oder wie viel Zeit fehlt. Auf dem Handy hältst du die Aufgabe zuerst gedrückt. Die Aufgabe bekommt die Zeit, an der du sie ablegst, und verlässt die Zeile. Sie behält ihre Fälligkeit, auch wenn du sie später verschiebst.
- **Heute:** Der Pfeil auf **Heute** zeigt zu heute. Ist heute zu sehen, steht dort stattdessen ein Punkt.
- **Tastenkürzel:** **H** zeigt heute. **J** und **K** blättern vor und zurück, ebenso die Pfeiltasten nach rechts und links. **1** bis **4** wählen die Ansicht, **G** öffnet **Gehe zu**. **N** legt einen Termin an, **Umschalt+N** eine Aufgabe. Die Tastatur-Schaltfläche in der Werkzeugleiste listet die Kürzel, die Cloud-Hilfe ebenso. Im Monat beginnt ein Buchstabe, den du an einem ausgewählten Tag tippst, stattdessen den Titel eines neuen Eintrags.
- **Anzahl:** Die Zahl neben den Filtern zählt die Einträge der Tage, die du siehst.
:::

## Farben im Kalender wählen {icon="palette"}

:::reference
- **Farbe nach Tag:** Standardmäßig tragen Termine und Aufgaben die Farbe ihres ersten Tags. Ein Eintrag ohne Tag trägt die Farbe seines Status. Ein Eintrag, dessen Status keine Farbe hat, bleibt ruhig grau. Weitere Tags erscheinen als kleine Punkte hinter dem Titel, wenn Platz ist.
- **Termine und Aufgaben:** Ein Termin ist ein getöntes Band. Eine Aufgabe mit Fälligkeitsdatum ist ein Kästchen in ihrer Farbe vor dem Titel, ohne Band. Dringende und hohe Priorität zeigen eine kleine rote Fahne, egal was die Farben zeigen.
- **Wählen, was die Farbe zeigt:** Öffne **Umfang** und wähle unter **Farbe nach** **Tag**, **Status**, **Priorität** oder **Person**. **Status** nutzt die Statusfarben und **Priorität** die Prioritätsfarben. **Person** nutzt die Avatarfarbe der ersten zuständigen Person und zeigt weitere zuständige Personen als Punkte. Einträge ohne diesen Wert bleiben grau.
- **Im Link gespeichert:** Die Wahl steht wie die Filter in der URL. Ein Neuladen oder ein geteilter Link zeigt daher dieselben Farben. Sie ändert nur, wie der Kalender für dich aussieht, nie die Einträge. Ein geöffneter Eintrag bleibt offen. **Zurücksetzen** in **Umfang** setzt die Filter zurück und behält die Farbe.
:::

## Einträge mit der globalen Suche finden {icon="search"}

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
