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

Verwende Hinweisblöcke für Kontext, Entscheidungen, Warnungen und Statusangaben, die beim Überfliegen einer Notiz sichtbar sein sollen.

**Gut lesbare Kästen**

```text
# Projektübersicht

:::info
Dieser Kasten hebt wichtigen Kontext hervor.
:::

:::success
Entscheidung: Die erste Version bleibt klein.
:::

:::warning
Risiko: Die endgültigen Preise stehen noch aus.
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
- **Notizlinks:** Die Markdown-Schreibweise lautet [Label](note://shortId), der Editor kann Links jedoch auch für dich einfügen.
- **Tags:** Verwende Tags wie #garden, um Notizen themenübergreifend zu gruppieren. Tag-Filter berücksichtigen erkannte Tags, nicht beliebige Wörter.
- **Anhänge:** Bilder werden direkt in der Notiz dargestellt. Andere Dateien erscheinen als Links. Beide verwenden Verweise im Format attach://shortId.
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
