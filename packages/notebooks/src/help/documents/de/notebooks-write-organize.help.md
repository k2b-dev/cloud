---
id: notebooks-write-organize
title: "Schreiben und ordnen"
icon: "ti ti-markdown"
description: "Lesbare Markdown-Notizen schreiben, Seiten diskutieren, mit Links und Tags verbinden und Dateien anhängen."
order: 120
---

Schreibe Notizen als lesbares Markdown. Nutze dann Links, Tags, Anhänge und die Seitenleiste, damit man sich im Notizbuch leicht zurechtfindet.

**Zusammenarbeit**

## Eine Seite diskutieren {icon="message-circle"}

Nutze **Kommentare** in den Notizdetails für Fragen, Feedback und Entscheidungen. Kommentare gehören neben die Seite, ändern aber nicht ihr Markdown.

:::reference
- **Ansichten:** Mit Zugriff **Bearbeiten** oder **Verwalten** verfolgst du Diskussionen in den Ansichten **Bearbeiten** oder **Schreibgeschützt**. Buch hat keinen Detailbereich und keine Diskussionen.
- **Hinzufügen:** Mit Zugriff **Bearbeiten** schreibst du Markdown-Kommentare. Andere Personen mit geöffnetem Detailbereich sehen neue Kommentare sofort.
- **Korrigieren:** Du kannst deinen eigenen Kommentar zehn Minuten lang nach dem Veröffentlichen bearbeiten oder löschen.
- **Gesperrte Notizen:** Eine Sperre friert den Notiztext ein, nicht die Diskussion. Mit Zugriff **Bearbeiten** kommentierst du auch eine gesperrte Notiz.
:::

Dauerhaftes Handbuchwissen gehört in die Notiz selbst. Nutze Kommentare, um diesen Inhalt vor oder nach einer Änderung zu besprechen.

**Mit KI bearbeiten** öffnet Assistant mit der Seite und ihrer Diskussion. Nach einer Prüfung kann Assistant auch deine neuen Kommentare korrigieren oder löschen. Es gelten dieselben Regeln für Autor und zehn Minuten. Assistant kann Entwürfe für Abfragen und Inhaltsverzeichnisse prüfen, ohne sie zu speichern. Diese Prüfung deckt nicht alle Markdown-Funktionen oder Tabellenformeln ab.

## Eine gespeicherte Version wiederherstellen {icon="history"}

Öffne die Notizdetails und wähle **Versionsverlauf**. Wähle eine Version, um ihren Inhalt oder die Änderungen anzusehen.

**Diese Version wiederherstellen** macht sie zum aktuellen Inhalt für alle, die in der Notiz arbeiten. Danach öffnet sich die Notiz in der Ansicht **Bearbeiten**. Der vorherige Inhalt bleibt im Verlauf. Wähle **Rückgängig** in der Bestätigung, um ihn zurückzuholen.

**Als Kopie wiederherstellen** erstellt eine neue Notiz direkt unter dem Original auf derselben Ebene. Das Original bleibt unverändert.

Zum Wiederherstellen brauchst du Zugriff **Bearbeiten**. Eine gesperrte Notiz kannst du nur als Kopie wiederherstellen.

**Markdown**

## Eine nützliche Notiz schreiben {icon="pencil"}

:::reference
- **Überschriften:** Gliedere die Notiz mit #, ## und tieferen Überschriften. Die erste H1 ist der Notiztitel in Navigation und Suche. Ohne H1 ist die erste sichtbare Zeile der Titel.
- **Listen und Aufgaben:** Verwende - für Listen. Verwende - [ ] oder - [x] für Aufgaben. Verwende 1. für nummerierte Listen. Sie zählen ab ihrer ersten Nummer weiter. Verschachtelte nummerierte Listen zeigen a., b. und dann i., ii. im Editor, in der Buchansicht und im PDF.
- **Text formatieren:** Nutze die Werkzeugleiste oder die Tasten unten. Ohne Auswahl gilt das Format für das Wort am Cursor. Leerzeichen am Rand der Auswahl bleiben außerhalb des Formats. Drücke dieselben Tasten noch einmal, um das Format zu entfernen. Wenn du nur einen Teil von formatiertem Text markierst, verliert nur dieser Teil das Format. In Code, Linkadressen und Tags sowie über Absätze und Listeneinträge hinweg wirkt das Format nicht.
- **Slash-Menü:** Nutze das Einfügemenü des Editors für häufige Blöcke wie Notizlinks, Dateien und Tabellen. Tippe ::: für Daten, Abfragen, Inhaltsverzeichnisse und Hinweisblöcke.
- **Markdown-Zeichen:** Der Rich-Modus zeigt Zeichen wie `**` oder `#`, wenn dein Cursor darin steht. Wenn du mit der Maus Text auswählst, erscheinen sie erst nach dem Loslassen der Taste. Der Text bleibt beim Ziehen an seiner Stelle.
:::

**Normale Notiz**

```text
# Reisenotizen

Schreibe kurze Absätze. Behandle in jedem Abschnitt nur ein Thema.

## Gepäck
- [x] Reisepass
- [ ] Ladegerät
- [ ] Regenjacke

## Ideen
- Früh in die Altstadt gehen
- Einen Abend freihalten
```

## Text formatieren {icon="typography"}

Die Werkzeugleiste zeigt den aktuellen Textstil und aktive Formate. Schaltflächen und Tasten schalten ein Format ein und aus.

| Taste | Was passiert |
| --- | --- |
| **Strg/⌘+B** | Schaltet fett ein oder aus. |
| **Strg/⌘+I** | Schaltet kursiv ein oder aus. |
| **Strg/⌘+Umschalt+S** | Schaltet durchgestrichen ein oder aus. |
| **Strg/⌘+Umschalt+H** | Markiert Text: `==Text==`. Noch einmal entfernt die Markierung. |
| **Strg/⌘+E** | Schaltet Code im Text ein oder aus. |
| **Strg/⌘+K** | Fügt einen Link ein; ausgewählter Text wird seine Beschriftung. |
| **Strg/⌘+Alt+K** | Öffnet die Auswahl, um eine andere Notiz zu verlinken. |
| **Strg/⌘+Umschalt+1/2/3** | Schaltet Überschrift 1/2/3 ein. Noch einmal ergibt normalen Text. |
| **Strg/⌘+Umschalt+7/8/9** | Schaltet eine nummerierte Liste, Aufzählung oder Checkliste ein oder aus. |
| **Strg/⌘+Z** / **Strg/⌘+Umschalt+Z** | Macht rückgängig oder wiederholt. Jede Aktion der Werkzeugleiste und jedes Enter ist ein eigener Schritt. |

Für Überschriften und Listen gelten die Zifferntasten auf jedem Tastaturlayout. Auf einem Mac nutzt macOS **⌘+Umschalt+3** für Bildschirmfotos; wähle Überschrift 3 dann im Stilmenü.

:::reference
- `/` am Zeilenanfang oder nach einem Leerzeichen öffnet das Einfügemenü. Tippe einen Befehlsnamen, um es zu filtern.
- `[[` öffnet Notizvorschläge. Die Auswahl ersetzt die getippten Klammern durch einen Markdown-Link zur Notiz.
- `![[` öffnet Anhangsvorschläge. Die Auswahl bettet ein Bild ein; bei einer anderen Datei fügt sie einen Download-Link ein.
- `==Text==` markiert Text farbig. Die Markierung bleibt innerhalb einer Zeile.
- Auf Touchscreens stehen **Rückgängig** und **Wiederholen** am Anfang der Werkzeugleiste.
- Am Smartphone bleibt die Werkzeugleiste beim Tippen über der Tastatur. So kannst du formatieren, einrücken und ausrücken, ohne die Tastatur zu schließen.
:::

## Listen {icon="keyboard"}

Listen im Notizeditor folgen ihrer Struktur. Die Tasten wirken gleich für Aufzählungen, nummerierte Listen und Checklisten.

| Taste | Was passiert |
| --- | --- |
| **Enter** | Fügt den nächsten Eintrag an. Am Anfang des Textes fügt es einen leeren Eintrag darüber ein. Bei einem Eintrag mit Untereinträgen wird der neue Eintrag sein erster Untereintrag. |
| **Enter** auf einem leeren Eintrag | Rückt den Eintrag eine Ebene aus. Auf oberster Ebene endet die Liste, und du schreibst normalen Text. Ein Eintrag der obersten Ebene mit Untereinträgen bleibt. |
| **Rücktaste** am Anfang eines Eintrags | Rückt den Eintrag eine Ebene aus. Auf oberster Ebene wird der Eintrag zu normalem Text. Ein Eintrag der obersten Ebene mit Untereinträgen bleibt. |
| **Tab** oder **Strg/⌘+]** | Ordnet den Eintrag dem Eintrag darüber unter. Seine Untereinträge wandern mit. |
| **Umschalt+Tab** oder **Strg/⌘+[** | Rückt den Eintrag eine Ebene aus. |
| **Alt+Pfeil nach oben/unten** | Verschiebt den Eintrag samt Untereinträgen am Eintrag darüber oder darunter vorbei. Am Listenrand bleibt er stehen. |
| **Strg/⌘+Umschalt+7**, **8**, **9** | Macht aus den markierten Zeilen eine nummerierte Liste, eine Aufzählung oder eine Checkliste. Die Tiefe bleibt. Noch einmal auf einem Eintrag der obersten Ebene ergibt normalen Text. Gemeint sind die Zifferntasten 7, 8 und 9, auf jedem Tastaturlayout. |
| **Strg/⌘+Enter** | Hakt die Aufgabe am Cursor ab oder entfernt den Haken, auch aus einer weiteren Zeile der Aufgabe. |
| `- `, `1. ` oder `[] ` am Zeilenanfang | Beginnt eine Aufzählung, eine nummerierte Liste oder eine Checkliste. |

**Umschalt+Enter** beginnt eine neue Zeile im selben Eintrag. **Rücktaste** direkt nach `# ` macht aus einer Überschrift normalen Text.

:::reference
- **Text und Code:** **Tab** fügt an der Cursorposition zwei Leerzeichen ein oder rückt die markierten Zeilen ein. **Umschalt+Tab** entfernt bis zu zwei Leerzeichen Einzug. Die Notiz speichert normale Leerzeichen.
- **Ohne Tab:** **Strg/⌘+]** und **Strg/⌘+[** funktionieren auch, wenn Tab den Fokus bewegt. Nutze am Smartphone **Einrücken** und **Ausrücken** in der Werkzeugleiste des Editors.
- **Listeneinträge verschieben:** Am Mac nutzt du **Wahltaste+Pfeil nach oben/unten**. Unter Windows und Linux geht das auch mit **Strg+Umschalt+Pfeil nach oben/unten**. Am Mac markiert **⌘+Umschalt+Pfeil nach oben/unten** weiterhin bis zum Anfang oder Ende der Notiz. Reicht deine Auswahl über mehr als einen Eintrag, werden die markierten Zeilen verschoben.
- **Nummerierte Listen:** Wenn du Einträge hinzufügst, entfernst, einrückst oder verschiebst, wird die geänderte Liste im Markdown neu nummeriert. Sie behält ihre erste Nummer, auch wenn du den ersten Eintrag entfernst. Andere Listen behalten ihre Nummern. Einmal Rückgängig stellt die Änderung samt vorherigen Nummern wieder her.
- **Werkzeugleiste:** Aufzählung, Nummerierte Liste und Checkliste stehen direkt in der Werkzeugleiste, auch am Smartphone.
- **Tabellen:** **Tab** markiert die nächste Zelle, **Umschalt+Tab** die vorherige.
- **Vorschläge:** Ist eine Vorschlagsliste offen, setzen **Tab** und **Enter** den markierten Vorschlag ein.
- **Editor verlassen:** Drücke **Esc** und dann **Tab**, um zum nächsten Bedienelement zu wechseln. Drücke **Esc** und dann **Umschalt+Tab**, um zurückzugehen.
- **Tab für den Fokus behalten:** Öffne **Einstellungen → Notizbuch → Ansicht und Verhalten** und schalte **Tab-Taste bewegt den Fokus statt einzurücken** ein. Dieser Browser speichert die Wahl, und sie gilt sofort.
:::

## Notizen in der Seitenleiste finden {icon="layout-sidebar"}

Die Seitenleiste zeigt die Notizen des Notizbuchs als Baum, mit der Startseite zuerst. Filter machen daraus eine Liste.

:::reference
- **Name des Notizbuchs:** Wähle den Namen oben, um zu einem anderen Notizbuch zu wechseln oder **Alle Notizbücher** zu öffnen.
- **Suche und neue Notizen:** Wähle **Notizen durchsuchen** oder drücke **Cmd/Strg+Umschalt+K**. Mit Zugriff **Bearbeiten** oder **Verwalten** erstellst du mit dem Stift neben dem Namen oder mit **Cmd/Strg+Alt+N** eine Notiz. Das letzte Wort deiner Eingabe findet auch Wortanfänge: *Bespr* findet *Besprechungen*. Notizen, deren Titel deiner Eingabe entspricht oder damit beginnt, stehen oben.
- **Favoriten, Zuletzt und Tags:** Diese Filter zeigen statt des Baums eine Liste, die zuletzt geänderte Notiz zuerst. **Zuletzt** zeigt die 12 zuletzt geänderten Notizen. Jede Notiz zeigt, wann sie sich geändert hat, und ihre ersten zwei Tags. Wähle den Filter erneut oder **×** über der Liste, um wieder den Baum zu sehen.
- **Die Liste bleibt ruhig:** Solange die Liste offen ist, verschieben Änderungen von dir oder anderen ihre Notizen nicht. Eine Notiz, die neu zum Filter passt, kommt ans Ende. Um die Liste neu zu sortieren, wähle den Filter zweimal.
- **Deine Favoriten:** Wähle im Menü einer Notiz **Zu Favoriten hinzufügen**. Nur du siehst deine Favoriten.
- **Menü einer Notiz:** Wähle **⋯** neben der Notiz, öffne ihr Kontextmenü mit der rechten Maustaste oder wähle sie aus und drücke **Umschalt+F10**.
- **Der Filter bleibt:** Er bleibt, wenn du eine Notiz aus der Liste öffnest und wenn du die Seite neu lädst. Öffnest du eine andere Notiz über einen Link in einer Notiz, über die Suche oder als neue Notiz, zeigt sich wieder der Baum.
- **Smartphones:** Das Menü bietet dieselben Filter und zeigt die Liste sofort. Öffne eine Notiz aus der Liste, um den Filter zu behalten. Schließt du das Menü, ohne eine Notiz zu öffnen, zeigt es wieder, was es vorher gezeigt hat.
:::

## Navigation ausblenden {icon="layout-sidebar-left-collapse"}

Blende die Navigation aus, um dich auf die Notiz zu konzentrieren. Blende sie auch aus, wenn andere deinen Bildschirm sehen und deine Notizen und Ordner nicht sehen dürfen.

:::reference
- **Ausblenden:** Wähle ganz links in der Werkzeugleiste des Editors **Navigation ausblenden**. Du kannst auch **Cmd/Strg+Alt+S** drücken oder in der Cloud-Suche `>` tippen und **Notizbuch-Navigation ausblenden** ausführen. Oder ziehe den Rand der Navigation fast ganz nach links.
- **Was verschwindet:** Die Seitenleiste verschwindet vollständig, ebenso die Seitenliste der Buchansicht.
- **Einblenden:** Wähle an derselben Stelle **Navigation einblenden** oder drücke erneut **Cmd/Strg+Alt+S**. Du kannst auch in der Cloud-Suche `>` tippen und **Notizbuch-Navigation einblenden** ausführen.
- **Ohne Werkzeugleiste:** Manche Stellen zeigen keine Werkzeugleiste des Editors: die Buchansicht, ein leeres Notizbuch, **Schreibgeschützt** und die Anhänge. Dort steht die Schaltfläche unten links. Im Graph steht sie links in seiner eigenen Werkzeugleiste.
- **Bleibt ausgeblendet:** Dieser Browser speichert die Wahl. Sie gilt für alle Notizbücher, auch nach dem Neuladen und in anderen offenen Tabs. Ein Notizbuch mit ausgeblendeter Navigation öffnet ohne sie, Notiztitel erscheinen also auch beim Laden nicht.
- **Lesebreite:** Auf einem großen Bildschirm bleibt der Text in einer Spalte, so breit wie in der Buchansicht, auch im Editor und in **Schreibgeschützt**. Blendest du die Navigation aus, rückt die Spalte in die Mitte. Die Zeilen werden nicht länger.
- **Volle Breite:** Für längere Zeilen schalte im Detailbereich **Volle Breite** ein, oder tippe in der Cloud-Suche `>` und führe **Volle Breite einschalten** aus. Der Text füllt dann den freien Platz im Editor, in **Schreibgeschützt** und in der Buchansicht. Nur du siehst das, und dieser Browser speichert die Wahl für alle Notizbücher und offenen Tabs. Volle Breite gilt nur auf großen Bildschirmen, dort erscheint der Schalter. Lassen Navigation und Detailbereich weniger Platz als die Spalte, werden die Zeilen erst länger, wenn du den Detailbereich schließt.
- **Deine Stelle in der Notiz:** Beim Aus- und Einblenden bleibt der Cursor, wo er ist. Der Text oben im Editor oder in der Buchansicht bleibt an seiner Stelle.
- **Smartphones und Tablets:** Auf kleinen Bildschirmen bleibt die Navigation im Menü. Auf einem Tablet öffnet die Schaltfläche oben links die Navigation über der Notiz. Ist sie ausgeblendet, zeigt die Schaltfläche unten links sie wieder an. Auf größeren Bildschirmen steht die Navigation neben der Notiz.
:::

## Notizen anordnen {icon="arrows-sort"}

Auf jeder Ebene der Seitenleiste stehen Notizen nach Titel, bis jemand sie anordnet. Mit Zugriff **Bearbeiten** oder **Verwalten** legst du eine eigene Reihenfolge fest, zum Beispiel die Kapitel eines Buchs. Alle sehen diese Reihenfolge sofort in der Seitenleiste und in der Buchansicht.

:::reference
- **Ziehen:** Ziehe am Computer eine Notiz zwischen ihren Nachbarn nach oben oder unten. Eine Linie zeigt, wo sie landet. Unternotizen wandern mit, und die Notiz bleibt auf ihrer Ebene. Um eine Notiz unter eine andere Notiz zu legen, nutze **Verschieben** im Notizmenü.
- **Tastatur:** Wähle eine Notiz in der Seitenleiste aus und drücke **Alt+Pfeil nach oben** oder **Alt+Pfeil nach unten**.
- **Smartphone und Menüs:** Öffne das Notizmenü und wähle **Nach oben verschieben** oder **Nach unten verschieben**.
- **Eine Ebene nach der anderen:** Ordnest du eine Notiz an, legst du nur die Reihenfolge ihrer Ebene fest. Andere Ebenen bleiben nach Titel sortiert. Neue Notizen auf einer angeordneten Ebene erscheinen am Ende. Notizen, die du von anderswo dorthin verschiebst, erscheinen ebenfalls am Ende.
- **Zurück zum Titel:** Im Menü einer Notiz mit Unternotizen setzt **Unternotizen alphabetisch sortieren** diese Ebene wieder auf die Reihenfolge nach Titel. Für die oberste Ebene wähle **Oberste Ebene alphabetisch sortieren** im Menü einer ihrer Notizen.
- **Startseite:** Die Startseite bleibt die erste ihrer Ebene. Andere Notizen lassen sich nicht über sie schieben.
- **Sortierung der Seitenleiste:** Die Reihenfolge gilt, wenn die Seitenleiste nach **Reihenfolge im Notizbuch** sortiert. **Zuletzt geändert** und **Erstellt** ändern nur deine Ansicht und bieten kein Anordnen an.
- **Zugriff Ansehen:** Personen mit Zugriff **Ansehen** sehen die festgelegte Reihenfolge, können sie aber nicht ändern.
:::

## Typografische Zeichen tippen {icon="typography"}

Wenn du eine Notiz liest oder bearbeitest, zeigt Notebooks einige getippte Zeichenfolgen als ein Zeichen an. Die Notiz behält die getippten Zeichen. Suche, Export und Assistant sehen sie unverändert.

| Du tippst | Du siehst |
| --- | --- |
| `->` `<-` `<->` | → ← ↔ |
| `=>` `<=>` | ⇒ ⇔ |
| `<=` `>=` `!=` `+-` | ≤ ≥ ≠ ± |
| `(c)` `(r)` `(tm)` | © ® ™ |
| `...` | … |
| `--` mit Leerzeichen auf beiden Seiten | – |

:::reference
- **Zeichen sehen:** Setze den Cursor auf ein Zeichen oder markiere es, um die getippten Zeichen zu bearbeiten. **Markdown-Quelltext anzeigen** zeigt sie immer. In der Buchansicht zeigt ein Tooltip sie, wenn du mit der Maus auf das Zeichen zeigst.
- **Unverändert:** Code, Formeln, Links, HTML, Daten- und Abfrageblöcke sowie Front Matter behalten die getippten Zeichen.
- **Zeichenfolge behalten:** Setze einen Backslash vor das erste Zeichen, zum Beispiel `\->`.
:::

**Gut lesbare Hervorhebung**

## Hinweisblöcke einfügen {icon="message-circle"}

Verwende Hinweisblöcke für Kontext, Entscheidungen, Warnungen und Status, die Lesende beim Überfliegen einer Notiz sehen müssen.

:::steps
1. Schreibe in eine eigene Zeile `:::note`, `:::info`, `:::success`, `:::warning` oder `:::danger`.
2. Optional: Schreibe eine Überschrift hinter die Art, zum Beispiel `:::warning Offenes Risiko`.
3. Schreibe den Text in die nächsten Zeilen.
4. Schließe den Hinweisblock mit `:::` in einer eigenen Zeile.
:::

Ein Hinweisblock zeigt ein Symbol für seine Art und eine helle Tönung. Symbol und Überschrift tragen die Farbe der Art; der Text bleibt neutral. Editor, Buchansicht und PDF-Export zeigen denselben Kasten. Beschreibungen und Kommentare in Spaces und die Hilfe zeigen ihn ebenso.

**Gut lesbare Kästen**

```text
# Projektübersicht

:::info
Dieser Kasten hebt wichtigen Kontext hervor.
:::

:::success
Entscheidung: Die erste Version bleibt klein.
:::

:::warning Offenes Risiko
Die endgültigen Preise stehen noch aus.
:::
```

**Diagramme**

## Diagramme zoomen und exportieren {icon="chart-dots-3"}

Schreibe ein Mermaid-Diagramm in einen Codeblock mit der Sprache `mermaid`. Editor und Buchansicht zeigen das gerenderte Diagramm. Wähle im Editor das Diagramm, um seinen Quelltext zu bearbeiten.

:::reference
- **Zoomen:** Nutze die Plus- und Minus-Schaltflächen oder scrolle mit gedrückter **Strg**- oder **Cmd**-Taste. Ziehe auf einem Touchscreen zwei Finger auseinander. Normales Scrollen bewegt weiterhin die Seite.
- **Verschieben:** Wenn du hineingezoomt hast, ziehe das Diagramm oder nutze die Pfeiltasten. Die Zurücksetzen-Schaltfläche zeigt wieder das ganze Diagramm.
- **Tastatur:** Fokussiere das Diagramm. Drücke **+** und **-** zum Zoomen, **0** zum Zurücksetzen und **F** für die Vollbildansicht.
- **Vollbild:** Die Vollbild-Schaltfläche öffnet das Diagramm in einem großen Fenster mit denselben Bedienelementen. Mit **Esc** schließt du es.
- **Exportieren:** In der Vollbildansicht speichert **SVG herunterladen** eine skalierbare Datei. **PNG herunterladen** speichert ein Bild auf dem Hintergrund des Farbschemas. Der Dateiname ist der Titel der Notiz.
:::

Im Editor erscheinen die Bedienelemente, wenn du auf das Diagramm zeigst oder es fokussierst. Nach dem Neuladen zeigt jedes Diagramm wieder seine volle Größe.

**Organisation**

## Notizen mit Links, Tags und Anhängen verbinden {icon="link"}

:::reference
- **Verknüpfungen sehen:** Wähle **Verknüpfungen** unten in der Navigation. **Netz** zeigt alle Notizen des Notizbuchs und die Verknüpfungen zwischen ihnen. Die offene Notiz hat einen Ring in der Farbe der App. Das geht auch mit Zugriff **Ansehen** in der Buchansicht.
- **Kreis:** Alle Notizen stehen auf einem Kreis, nach Bereich in Seitenreihenfolge gruppiert. Der Bereichsname steht innen im Kreis. Verknüpfungen verlaufen quer durch den Kreis in der Farbe ihres Ausgangsbereichs. Zeige auf eine Notiz, um nur ihre Verknüpfungen sichtbar zu halten. Durchgezogene Linien gehen hinaus. Gestrichelte Linien kommen herein. Bei vielen Notizen erscheinen manche Titel erst beim Zeigen auf eine Notiz oder beim Hineinzoomen.
- **Umgebung:** Die aktuelle Notiz steht in der Mitte. Notizen, auf die sie verweist, stehen rechts. Notizen, die auf sie verweisen, stehen links. Der zweite Schritt steht auf dem äußeren Ring. Auf einem hohen, schmalen Bildschirm wie einem Telefon stehen eingehende Verweise oben und ausgehende unten.
- **Verlauf:** Notizen stehen als Zeilen untereinander, die letzte Änderung zuerst. Die Gruppen beginnen mit **Heute**, **Gestern**, **Diese Woche** und **Letzte Woche**, danach folgen Monate und Jahre. Verknüpfungen sind Bögen links, in der Farbe ihres Ausgangsbereichs. Zeige auf eine Zeile oder fokussiere sie, um ihre Verknüpfungen zu sehen. Eingehende Verknüpfungen sind gestrichelt. Diese Darstellung scrollt, statt zu zoomen. Sie öffnet sich bei der offenen Notiz.
- **Tiefe:** Wähle in **Umgebung** zwischen **1 Schritt** und **2 Schritte**.
- **In die Mitte:** Fokussiere eine Notiz und drücke die **Leertaste**. Auf einem Touchscreen wählst du eine Notiz und dann **In die Mitte**. Diese Notiz wird die Mitte.
- **Auf dem Telefon:** Verknüpfungen öffnet sich in **Umgebung**, außer du wählst eine andere Darstellung. Deine Wahl bleibt in der Adresse.
- **Hier keine Verknüpfungen:** Wähle **Ganzes Notizbuch zeigen**, um **Netz** zu sehen. Blenden die Filter alle Verknüpfungen der aktuellen Notiz aus, wähle **Filter zurücksetzen**.
- **Bereiche:** Jede Seite auf oberster Ebene mit Unterseiten ist ein Bereich mit eigener Farbe. Die übrigen Seiten auf oberster Ebene stehen unter **Oberste Ebene**. Das Netz bewegt sich nicht von selbst. Du kannst eine Notiz ziehen, und ihre Nachbarn folgen ein wenig.
- **Auf eine Notiz zeigen:** Die Notiz und ihre Nachbarn bleiben sichtbar, die anderen Notizen treten zurück. Verweise von der Notiz sind durchgezogen. Verweise auf die Notiz sind gestrichelt. Unten links stehen der Bereich, die Zahl der Verweise in beide Richtungen und die letzte Änderung.
- **Filter und Suche:** Wähle **Alle Notizen**, **Nur verknüpfte** oder **Nur ohne Verknüpfung**. Wähle einen Bereich, um ihn aus- oder einzublenden. **Notiz finden** markiert die Notizen mit passendem Titel, und Enter springt zum ersten Treffer. Die Adresse behält diese Einstellungen, also zeigen Neuladen und Zurück dieselbe Ansicht.
- **Als Liste:** Zeigt dieselben Notizen und Filter als Tabelle: den Bereich, die Notizen, auf die eine Notiz verweist, die Notizen, die auf sie verweisen, und die letzte Änderung. Wähle **Geändert**, um nach der letzten Änderung zu sortieren, die neueste zuerst. Wähle es erneut für die älteste zuerst. Die Adresse behält die Reihenfolge.
- **Tastatur:** Mit Tab kommst du in den Graph. In **Netz** und **Umgebung** wechseln die Pfeiltasten zur nächsten Notiz in dieser Richtung. Bild ab und Bild auf gehen die Notizen in Seitenreihenfolge durch. Im **Kreis** gehen die Pfeiltasten den Kreis entlang. Bild ab und Bild auf springen zum nächsten oder vorherigen Bereich. Im **Verlauf** gehen Pfeil hoch und Pfeil runter zur nächsten oder vorherigen Zeile. Enter öffnet die Notiz, Pos1 springt zur offenen Notiz, und Esc leert die Suche. In allen Darstellungen außer **Verlauf** zoomen + und −, und 0 passt den Graph ein.
- **Touchscreens:** Im **Verlauf** wählst du eine Zeile, um die Notiz zu öffnen. In den anderen Darstellungen wählst du eine Notiz, um sie auszuwählen. Unten erscheint eine Leiste mit der Notiz. Wähle **Öffnen**, um sie zu öffnen. Mit zwei Fingern zoomst du.
- **Notizlinks:** Die Markdown-Schreibweise lautet `[Label](note://shortId)`. Der Editor kann Links auch für dich einfügen.
- **Link auf eine Überschrift:** Hänge den Namen der Überschrift in Kleinbuchstaben mit Bindestrichen an. `[Label](note://shortId#backup-restore)` öffnet die Überschrift „Backup & Restore“. Hat die Notiz keine solche Überschrift, öffnet sie sich oben.
- **Tags:** Verwende Tags wie #garden, um Notizen im ganzen Notizbuch zu gruppieren. Tagfilter berücksichtigen erkannte Tags, nicht beliebige Wörter.
- **Anhänge:** Bilder erscheinen direkt in der Notiz. Andere Dateien erscheinen als Links. Beide verwenden Verweise im Format attach://shortId. Mit `=400x`, `=x300` oder `=400x300` nach der Adresse legst du die Größe eines Bildes fest.
- **So sehen Links aus:** Links auf Notizen, Überschriften und Dateien sind hellgraue Marken mit einem farbigen Symbol für die Art. PDFs sind rot, Bilder violett, Designdateien orange, Notizen blaugrau und Überschriften grau.
- **Überschrift in einer anderen Notiz:** Der Link zeigt zuerst diese Notiz, etwa „Farbsystem › Akzentfarbe“.
- **Datei in einer eigenen Zeile:** Der Link zeigt zusätzlich die Dateigröße.
- **Websites und E-Mail-Adressen:** Diese Links bleiben Teil des Textes mit einer dünnen Unterstreichung. Website-Links enden mit einem kleinen ↗.
- **Wo Links so aussehen:** Buchansicht und PDF-Export zeigen Links so an. Der Editor nutzt dasselbe Aussehen mit drei Unterschieden. Er zeigt bei einer Überschrift nur den Linktext, liest die Art einer Datei aus ihrem Linktext und zeigt keine Dateigrößen.
- **Anhang öffnen:** Wähle ein Bild aus, um es im Vollbild zu sehen. Wähle eine PDF-, Markdown-, Text-, JSON- oder CSV-Datei aus, um ihre Vorschau zu öffnen.
- **Aktionen der Vorschau:** Die Vorschau bietet **Herunterladen**. PDFs bieten zusätzlich **In neuem Tab öffnen**, Text- und JSON-Dateien **Kopieren**.
- **Andere Dateien:** Notebooks lädt andere Dateien wie Archive, Audio und Video nach einer Bestätigung herunter. Das gilt auch für sehr große Dateien und für Bilder, die die Notiz nicht anzeigen kann.
- **Wo das funktioniert:** Du öffnest Anhänge im Editor, in der Buchansicht, im Detailbereich und in der Anhangsübersicht.
- **Alle Dateien des Notizbuchs:** Öffne **Anhänge** unten in der Seitenleiste des Notizbuchs. Dort siehst und durchsuchst du alle Dateien des Notizbuchs.
:::

**Übersichtsnotiz mit Links**

```text
# Gartenübersicht

#garden #spring #planning

Füge Links mit /note ein. Die Notiz-IDs musst du nicht selbst heraussuchen.

- [Pflanzenliste](note://aB12Cd)
- [Beetplan](note://xY98Qr)
- [Saatgutbestellung.pdf](attach://pQ45Rt)
```

**Verweise auf Anhänge**

```text
# Beleg

Ziehe eine Datei in den Editor, füge ein Bild ein oder gib /file ein.

Bilder werden direkt in der Notiz dargestellt:

![Tomatensetzlinge](attach://img123)

Andere Dateien erscheinen als Links:

[Bodenanalyse.pdf](attach://pdf123)
```
