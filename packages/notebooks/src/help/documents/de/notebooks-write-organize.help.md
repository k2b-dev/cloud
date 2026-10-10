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

**Markdown**

## Eine nützliche Notiz schreiben {icon="pencil"}

:::reference
- **Überschriften:** Gliedere die Notiz mit #, ## und tieferen Überschriften. Die erste H1 ist der Notiztitel in Navigation und Suche. Ohne H1 ist die erste sichtbare Zeile der Titel.
- **Listen und Aufgaben:** Verwende - für Listen. Verwende - [ ] oder - [x] für Aufgaben.
- **Slash-Menü:** Nutze das Einfügemenü des Editors für häufige Blöcke wie Notizlinks, Dateien und Tabellen. Tippe ::: für Daten, Abfragen, Inhaltsverzeichnisse und Hinweisblöcke.
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

## Mit Tab einrücken {icon="keyboard"}

**Tab** rückt im Notizeditor ein. So verschachtelst du Listen und richtest Code aus, ohne zur Maus zu greifen. Die Notiz speichert normale Leerzeichen.

:::reference
- **Text und Code:** **Tab** fügt an der Cursorposition zwei Leerzeichen ein oder rückt die markierten Zeilen ein. **Umschalt+Tab** entfernt bis zu zwei Leerzeichen Einzug.
- **Listen:** **Tab** ordnet den aktuellen Eintrag dem Eintrag darüber unter. Seine Untereinträge wandern mit. **Umschalt+Tab** holt ihn eine Ebene zurück.
- **Tabellen:** **Tab** markiert die nächste Zelle, **Umschalt+Tab** die vorherige.
- **Vorschläge:** Ist eine Vorschlagsliste offen, setzt **Tab** den markierten Vorschlag ein.
- **Editor verlassen:** Drücke **Esc** und dann **Tab**, um zum nächsten Bedienelement zu wechseln. Drücke **Esc** und dann **Umschalt+Tab**, um zurückzugehen.
- **Tab für den Fokus behalten:** Öffne **Einstellungen → Notizbuch → Ansicht und Verhalten** und schalte **Tab-Taste bewegt den Fokus statt einzurücken** ein. Dieser Browser speichert die Wahl, und sie gilt sofort.
:::

## Navigation ausblenden {icon="layout-sidebar-left-collapse"}

Blende die Navigation aus, um mit der ganzen Breite zu schreiben. Blende sie auch aus, wenn andere deinen Bildschirm sehen und deine Notizen und Ordner nicht sehen dürfen.

:::reference
- **Ausblenden:** Wähle ganz links in der Werkzeugleiste des Editors **Navigation ausblenden**. Du kannst auch **Cmd/Strg+Alt+S** drücken oder in der Cloud-Suche `>` tippen und **Notizbuch-Navigation ausblenden** ausführen. Oder ziehe den Rand der Navigation fast ganz nach links.
- **Was verschwindet:** Die Navigation verschwindet in beiden Layouts und in der Buchansicht vollständig. Das gilt auch für die Notizliste des Navigators und die Seitenliste der Buchansicht.
- **Einblenden:** Wähle an derselben Stelle **Navigation einblenden** oder drücke erneut **Cmd/Strg+Alt+S**. Du kannst auch in der Cloud-Suche `>` tippen und **Notizbuch-Navigation einblenden** ausführen.
- **Ohne Werkzeugleiste:** Manche Stellen zeigen keine Werkzeugleiste des Editors: die Buchansicht, ein leeres Notizbuch, **Schreibgeschützt**, der Graph und die Anhänge. Dort steht die Schaltfläche unten links.
- **Bleibt ausgeblendet:** Dieser Browser speichert die Wahl. Sie gilt für alle Notizbücher, auch nach dem Neuladen und in anderen offenen Tabs. Ein Notizbuch mit ausgeblendeter Navigation öffnet ohne sie, Notiztitel erscheinen also auch beim Laden nicht.
- **Deine Stelle in der Notiz:** Beim Aus- und Einblenden bleibt der Cursor, wo er ist. Der Text oben im Editor oder in der Buchansicht bleibt an seiner Stelle.
- **Smartphones:** Auf kleinen Bildschirmen bleibt die Navigation im Menü. Die Schaltfläche erscheint auf breiteren Bildschirmen, wo die Navigation neben der Notiz steht.
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

Ein Hinweisblock ist ein ruhiger Kasten: eine helle Tönung je nach Art, normaler Text und kein Symbol. Editor, Buchansicht und PDF-Export zeigen denselben Kasten. Beschreibungen und Kommentare in Spaces und die Hilfe zeigen ihn ebenso.

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
- **Notizlinks:** Die Markdown-Schreibweise lautet `[Label](note://shortId)`. Der Editor kann Links auch für dich einfügen.
- **Link auf eine Überschrift:** Hänge den Namen der Überschrift in Kleinbuchstaben mit Bindestrichen an. `[Label](note://shortId#backup-restore)` öffnet die Überschrift „Backup & Restore“. Hat die Notiz keine solche Überschrift, öffnet sie sich oben.
- **Tags:** Verwende Tags wie #garden, um Notizen im ganzen Notizbuch zu gruppieren. Tagfilter berücksichtigen erkannte Tags, nicht beliebige Wörter.
- **Anhänge:** Bilder erscheinen direkt in der Notiz. Andere Dateien erscheinen als Links. Beide verwenden Verweise im Format attach://shortId.
- **So sehen Links aus:** Links auf Notizen, Überschriften und Dateien sind hellgraue Marken mit einem farbigen Symbol für die Art. PDFs sind rot, Bilder violett, Designdateien orange, Notizen blaugrau und Überschriften grau.
- **Überschrift in einer anderen Notiz:** Der Link zeigt zuerst diese Notiz, etwa „Farbsystem › Akzentfarbe“.
- **Datei in einer eigenen Zeile:** Der Link zeigt zusätzlich die Dateigröße.
- **Websites und E-Mail-Adressen:** Diese Links bleiben Teil des Textes mit einer dünnen Unterstreichung. Website-Links enden mit einem kleinen ↗.
- **Wo Links so aussehen:** Buchansicht und PDF-Export zeigen Links so an. Der Editor nutzt dasselbe Aussehen mit drei Unterschieden. Er zeigt bei einer Überschrift nur den Linktext, liest die Art einer Datei aus ihrem Linktext und zeigt keine Dateigrößen.
- **Anhang öffnen:** Wähle ein Bild aus, um es im Vollbild zu sehen. Wähle eine PDF-, Markdown-, Text-, JSON- oder CSV-Datei aus, um ihre Vorschau zu öffnen.
- **Aktionen der Vorschau:** Die Vorschau bietet **Herunterladen**. PDFs bieten zusätzlich **In neuem Tab öffnen**, Text- und JSON-Dateien **Kopieren**.
- **Andere Dateien:** Notebooks lädt andere Dateien wie Archive, Audio und Video nach einer Bestätigung herunter. Das gilt auch für sehr große Dateien und für Bilder, die die Notiz nicht anzeigen kann.
- **Wo das funktioniert:** Du öffnest Anhänge im Editor, in der Buchansicht, im Detailbereich und in der Anhangsübersicht.
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
