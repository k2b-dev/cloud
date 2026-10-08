---
id: notebooks-write-organize
title: "Schreiben und ordnen"
icon: "ti ti-markdown"
description: "Lesbare Markdown-Notizen schreiben, Seiten diskutieren, mit Links und Tags verbinden und Dateien anhängen."
order: 120
---

Schreibe Notizen als lesbares Markdown. Nutze anschließend Links, Tags, Anhänge und die Seitenleiste, um dich im Notizbuch zurechtzufinden.

**Zusammenarbeit**

## Eine Seite diskutieren {icon="message-circle"}

Nutze **Kommentare** in den Notizdetails für Fragen, Feedback und Entscheidungen, die zur Seite gehören, aber nicht ihren Markdown-Inhalt verändern sollen.

:::reference
- **Ansichten:** Nutzer mit Schreib- oder Adminrechten können Diskussionen unter Bearbeiten oder Schreibgeschützt verfolgen. Buch hat keinen Detailbereich und keine Diskussionen.
- **Hinzufügen:** Nutzer mit Schreibzugriff können Markdown-Kommentare verfassen. Neue Kommentare erscheinen live bei anderen Lesern.
- **Korrigieren:** Eigene Kommentare können nach dem Veröffentlichen zehn Minuten lang bearbeitet oder gelöscht werden.
- **Gesperrte Notizen:** Eine Sperre schützt den Inhalt der Notiz, nicht ihre Diskussion. Nutzer mit Schreibzugriff können weiterhin kommentieren.
:::

Dauerhaftes Handbuchwissen gehört in die Notiz selbst. Nutze Kommentare, um diesen Inhalt vor oder nach einer Änderung zu besprechen.

**Mit KI bearbeiten** öffnet Assistant mit der Seite und ihrer Diskussion. Assistant kann nach einer Prüfung auch deine neuen Kommentare korrigieren oder löschen; es gelten dieselben Autoren- und Zehn-Minuten-Regeln. Query- und Inhaltsverzeichnis-Entwürfe lassen sich ohne Speichern prüfen. Diese Prüfung deckt nicht alle Markdown-Funktionen oder Tabellenformeln ab.

**Markdown**

## Eine nützliche Notiz schreiben {icon="pencil"}

:::reference
- **Überschriften:** Gliedere die Notiz mit #, ## und weiteren Überschriftenebenen. Die erste H1 oder andernfalls die erste sichtbare Zeile wird außerdem als Notiztitel in der Navigation und Suche verwendet.
- **Listen und Aufgaben:** Verwende - für Listen und - [ ] oder - [x] für Aufgaben.
- **Slash-Menü:** Verwende das Einfüge-Menü im Editor für häufige Blöcke wie Notizlinks, Dateien und Tabellen. Tippe ::: für Daten, Abfragen, Inhaltsverzeichnisse und Hinweisblöcke.
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

Tab rückt im Notizeditor ein. So verschachtelst du Listen und richtest Code aus, ohne zur Maus zu greifen. Die Notiz speichert dabei normale Leerzeichen.

:::reference
- **Text und Code:** Tab fügt an der Cursorposition zwei Leerzeichen ein oder rückt die markierten Zeilen ein. Umschalt+Tab entfernt bis zu zwei Leerzeichen Einzug.
- **Listen:** Tab ordnet den aktuellen Eintrag dem Eintrag darüber unter, seine Untereinträge wandern mit. Umschalt+Tab holt ihn eine Ebene zurück.
- **Tabellen:** Tab markiert die nächste Zelle, Umschalt+Tab die vorherige.
- **Vorschläge:** Ist eine Vorschlagsliste geöffnet, übernimmt Tab den markierten Vorschlag.
- **Editor verlassen:** Drücke Esc und dann Tab, um zum nächsten Bedienelement zu wechseln, oder Esc und dann Umschalt+Tab für das vorherige.
- **Tab für den Fokus behalten:** Öffne in den **Einstellungen** den Bereich **Notizbuch – Ansicht und Verhalten** und aktiviere **Tab-Taste bewegt den Fokus statt einzurücken**. Die Auswahl wird in diesem Browser gespeichert und gilt sofort.
:::

## Navigation ausblenden {icon="layout-sidebar-left-collapse"}

Blende die Navigation aus, um mit der ganzen Breite zu schreiben oder wenn andere deinen Bildschirm sehen und deine Notizen und Ordner nicht sehen sollen.

:::reference
- **Ausblenden:** Wähle ganz links in der Werkzeugleiste des Editors **Navigation ausblenden**, drücke **Cmd/Strg+Alt+S**, tippe in der Cloud-Suche `>` und führe **Notizbuch-Navigation ausblenden** aus oder ziehe den Rand der Navigation fast ganz nach links. Die Navigation verschwindet in beiden Layouts und in der Buchansicht vollständig, auch die Notizliste des Navigators und die Seitenliste der Buchansicht.
- **Einblenden:** Wähle an derselben Stelle **Navigation einblenden**, drücke erneut **Cmd/Strg+Alt+S** oder tippe in der Cloud-Suche `>` und führe **Notizbuch-Navigation einblenden** aus. Wo der Editor keine Werkzeugleiste zeigt, etwa in der Buchansicht, in einem leeren Notizbuch, in Schreibgeschützt, im Graphen oder bei den Anhängen, steht die Schaltfläche unten links.
- **Bleibt ausgeblendet:** Die Einstellung wird in diesem Browser gespeichert und gilt für alle Notizbücher, auch nach dem Neuladen und in anderen offenen Tabs. Ein Notizbuch mit ausgeblendeter Navigation öffnet ohne sie, Notiztitel erscheinen also auch beim Laden nicht.
- **Deine Stelle in der Notiz:** Beim Aus- und Einblenden bleibt der Cursor, wo er ist, und der Text oben im Editor oder in der Buchansicht bleibt an seiner Stelle.
- **Smartphones:** Auf kleinen Bildschirmen bleibt die Navigation im Menü. Die Schaltfläche erscheint auf breiteren Bildschirmen, wo die Navigation neben der Notiz steht.
:::

## Notizen anordnen {icon="arrows-sort"}

Die Notizen jeder Ebene der Seitenleiste stehen nach Titel, bis jemand sie anordnet. Schreibende und Admins legen ihre eigene Reihenfolge fest, zum Beispiel die Kapitel eines Buchs; alle sehen sie sofort in der Seitenleiste und in der Buchansicht.

:::reference
- **Ziehen:** Ziehe am Computer eine Notiz zwischen ihren Nachbarn nach oben oder unten. Eine Linie zeigt, wo sie landet. Unternotizen wandern mit, und die Notiz bleibt auf ihrer Ebene; um sie unter eine andere Notiz zu legen, nutze **Verschieben** im Notizmenü.
- **Tastatur:** Wähle eine Notiz in der Seitenleiste aus und drücke **Alt+Pfeil nach oben** oder **Alt+Pfeil nach unten**.
- **Smartphone und Menüs:** Öffne das Notizmenü und wähle **Nach oben verschieben** oder **Nach unten verschieben**.
- **Eine Ebene nach der anderen:** Das Anordnen legt nur die Reihenfolge der Ebene dieser Notiz fest. Andere Ebenen bleiben nach Titel sortiert. Neue Notizen auf einer angeordneten Ebene erscheinen am Ende, ebenso Notizen, die von anderswo dorthin verschoben werden.
- **Zurück zum Titel:** Im Menü einer Notiz mit Unternotizen setzt **Unternotizen alphabetisch sortieren** diese Ebene wieder auf die Reihenfolge nach Titel. Für die oberste Ebene nutze **Oberste Ebene alphabetisch sortieren** im Menü einer ihrer Notizen.
- **Startseite:** Die Startseite bleibt die erste ihrer Ebene; andere Notizen lassen sich nicht über sie schieben.
- **Sortierung der Seitenleiste:** Die Reihenfolge gilt, wenn die Seitenleiste nach **Reihenfolge im Notizbuch** sortiert. **Zuletzt geändert** und **Erstellt** ändern nur deine Ansicht und bieten kein Anordnen an.
- **Lesende** sehen die festgelegte Reihenfolge, können sie aber nicht ändern.
:::

## Typografische Zeichen {icon="typography"}

Notizbücher zeigen einige getippte Zeichenfolgen als ein Zeichen an, wenn du eine Notiz liest oder bearbeitest. Die Notiz behält die getippten Zeichen, deshalb sehen Suche, Export und Assistant sie unverändert.

| Du tippst | Du siehst |
| --- | --- |
| `->` `<-` `<->` | → ← ↔ |
| `=>` `<=>` | ⇒ ⇔ |
| `<=` `>=` `!=` `+-` | ≤ ≥ ≠ ± |
| `(c)` `(r)` `(tm)` | © ® ™ |
| `...` | … |
| `--` mit Leerzeichen auf beiden Seiten | – |

:::reference
- **Zeichen sehen:** Setze den Cursor auf ein Zeichen oder markiere es, um die getippten Zeichen zu bearbeiten. **Markdown-Quelltext anzeigen** zeigt sie immer. Im Buch zeigt sie ein Tooltip, wenn du mit der Maus auf das Zeichen zeigst.
- **Unverändert:** Code, Formeln, Links, HTML, Daten- und Abfrageblöcke sowie Front Matter behalten die getippten Zeichen.
- **Zeichenfolge behalten:** Setze einen Backslash vor das erste Zeichen, zum Beispiel `\->`.
:::

**Gut lesbare Hervorhebung**

## Hinweisblöcke {icon="message-circle"}

Verwende Hinweisblöcke für Kontext, Entscheidungen, Warnungen und Statusangaben, die beim Überfliegen einer Notiz sichtbar sein sollen. Schreibe `:::note`, `:::info`, `:::success`, `:::warning` oder `:::danger` in eine eigene Zeile, darunter den Text und zum Schluss `:::`. Ein Hinweisblock ist ein ruhiger Kasten: eine helle Tönung je nach Art, normaler Text und kein Symbol. Für eine Überschrift schreibe sie hinter die Art, zum Beispiel `:::warning Offenes Risiko`. Editor, Buchansicht und PDF-Export zeigen denselben Kasten, ebenso Beschreibungen und Kommentare in Spaces und die Hilfe.

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

Schreibe ein Mermaid-Diagramm in einen Codeblock mit der Sprache `mermaid`. Editor und Buchansicht zeigen das gerenderte Diagramm; im Editor klickst du darauf, um den Quelltext zu bearbeiten.

:::reference
- **Zoomen:** Nutze die Plus- und Minus-Schaltflächen, scrolle mit gedrückter Strg- oder Cmd-Taste oder ziehe auf einem Touchscreen zwei Finger auseinander. Normales Scrollen bewegt weiterhin die Seite.
- **Verschieben:** Wenn du hineingezoomt hast, ziehe das Diagramm oder nutze die Pfeiltasten. Die Zurücksetzen-Schaltfläche zeigt wieder das ganze Diagramm.
- **Tastatur:** Fokussiere das Diagramm und drücke + und - zum Zoomen, 0 zum Zurücksetzen und F für die Vollbildansicht.
- **Vollbild:** Die Vollbild-Schaltfläche öffnet das Diagramm in einem großen Fenster mit denselben Bedienelementen. Mit Esc schließt du es.
- **Exportieren:** In der Vollbildansicht speichert **SVG herunterladen** eine skalierbare Datei und **PNG herunterladen** ein Bild auf dem Hintergrund des Farbschemas. Der Dateiname ist der Titel der Notiz.
:::

Im Editor erscheinen die Bedienelemente, wenn du auf das Diagramm zeigst oder es fokussierst. Nach dem Neuladen zeigt jedes Diagramm wieder seine volle Größe.

**Organisation**

## Links, Tags und Anhänge {icon="link"}

:::reference
- **Notizlinks:** Die Markdown-Schreibweise lautet `[Label](note://shortId)`, der Editor kann Links jedoch auch für dich einfügen. Um eine Notiz bei einer Überschrift zu öffnen, hänge den Namen der Überschrift in Kleinbuchstaben mit Bindestrichen an: `[Label](note://shortId#backup-restore)` öffnet die Überschrift „Backup & Restore“. Hat die Notiz keine solche Überschrift, öffnet sie sich oben.
- **Tags:** Verwende Tags wie #garden, um Notizen themenübergreifend zu gruppieren. Tag-Filter berücksichtigen erkannte Tags, nicht beliebige Wörter.
- **Anhänge:** Bilder werden direkt in der Notiz dargestellt. Andere Dateien erscheinen als Links. Beide verwenden Verweise im Format attach://shortId.
- **So sehen Links aus:** Links auf Notizen, Überschriften und Dateien erscheinen als hellgraue Marken mit einem farbigen Symbol für die Art: rot für PDFs, violett für Bilder, orange für Designdateien, blaugrau für Notizen und grau für Überschriften. Ein Link auf eine Überschrift in einer anderen Notiz zeigt zuerst diese Notiz, etwa „Farbsystem › Akzentfarbe“. Eine Datei in einer eigenen Zeile zeigt zusätzlich ihre Größe. Links auf Websites und E-Mail-Adressen bleiben Teil des Textes mit einer dünnen Unterstreichung; Website-Links enden mit einem kleinen ↗. So zeigen Buchansicht und PDF-Export Links an. Der Editor nutzt dasselbe Aussehen, zeigt bei einer Überschrift aber nur den Linktext, liest die Art einer Datei aus ihrem Linktext und zeigt keine Dateigrößen.
- **Anhang öffnen:** Wähle ein Bild aus, um es im Vollbild zu sehen. Wähle eine PDF-, Markdown-, Text-, JSON- oder CSV-Datei aus, um ihre Vorschau zu öffnen. Die Vorschau bietet **Herunterladen**. PDFs bieten zusätzlich **In neuem Tab öffnen**, Text- und JSON-Dateien **Kopieren**. Andere Dateien wie Archive, Audio und Video werden nach einer Bestätigung heruntergeladen, ebenso sehr große Dateien und Bilder, die in der Notiz nicht angezeigt werden. Das funktioniert im Editor, in der Buchansicht, im Detailbereich und in der Anhangsübersicht.
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
