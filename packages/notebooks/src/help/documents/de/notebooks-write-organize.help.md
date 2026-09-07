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
