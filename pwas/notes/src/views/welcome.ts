/** The note a first visit opens: a real local note, written in the browser's language, to change or delete. */
export const WELCOME_TEXT = {
  de: `# Willkommen
#start

Schön, dass du da bist. Hier schreibst du Notizen, die dir gehören.

Bleibt in diesem Browser · kein Konto · teilen per Link

## Eine Checkliste

- [x] Diese Notiz öffnen
- [ ] Etwas Eigenes aufschreiben
- [ ] Eine Notiz mit jemandem teilen

## Eine Tabelle wird ein Diagramm

@kaffee
| Monat | Tassen |
| --- | --- |
| Juli | 48 |
| August | 61 |
| September | 74 |
| Summe | =SUM(Tassen) |

:::chart
type: bar
title: Kaffee pro Monat
data: @kaffee
x: Monat
y: Tassen
:::

:::note
Diese Notiz gehört dir. Ändere sie oder lösche sie, wie du willst.
:::

Tippe / für mehr.
`,
  en: `# Welcome
#start

Good to have you here. This is where you write notes that belong to you.

Stays in this browser · no account · share by link

## A checklist

- [x] Open this note
- [ ] Write something of your own
- [ ] Share a note with someone

## A table becomes a chart

@coffee
| Month | Cups |
| --- | --- |
| July | 48 |
| August | 61 |
| September | 74 |
| Total | =SUM(Cups) |

:::chart
type: bar
title: Coffee per month
data: @coffee
x: Month
y: Cups
:::

:::note
This note belongs to you. Change it or delete it as you like.
:::

Type / for more.
`,
} as const;
