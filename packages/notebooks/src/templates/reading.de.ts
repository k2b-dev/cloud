import type { TemplateContext, TemplateNote } from "./types";

const bookContentDe = (title: string, author: string, status: string, rating: string, quotes: string[], notes: string[]) => `# ${title}

#book

@book
:::data
title: ${title}
author: ${author}
status: ${status}
rating: "${rating}"
:::

@quotes
${quotes.map((quote) => `- ${quote}`).join("\n")}

@notes
## Notizen

${notes.map((note) => `- ${note}`).join("\n")}
`;

export const readingNotesDe = (ctx: TemplateContext): TemplateNote[] => [
  {
    key: "dashboard",
    content: (c) => `# Leseübersicht

#reading

:::success
Beginne hier. Halte die Leseliste übersichtlich: eine Tabelle zur Nachverfolgung und eigene Notizen nur für Bücher, bei denen es sich lohnt.
:::

## So verwendest du diese Leseliste

1. Pflege Status, Datumsangaben und Bewertungen unter ${c.link("books", "Bücher")}.
2. Verwende Buchnotizen für Zitate und Gedanken, die du behalten möchtest.
3. Halte spontane Ideen unten in der Merkliste fest und entscheide später, was du lesen möchtest.
4. Verwalte das Lesen nicht zu kleinteilig. Die Übersicht soll Orientierung geben, keinen Druck erzeugen.

:::info
Die Tabelle hält deine Leseliste fest. Die automatische Liste zeigt eigene Buchseiten und deren benannte Daten; sie liest keine Tabellenzeilen.
:::

:::query
source: notes
scope: notebook
where:
  - field: $tags
    op: contains
    value: book
sort:
  field: $title
  direction: asc
columns:
  - $title
  - book.author
  - book.status
limit: 25
:::

@reading
- [x] Braiding Sweetgrass in der Bibliothek ausleihen
- [ ] Ein Sachbuch über Aufmerksamkeit ergänzen
- [ ] Einen kurzen Roman für den Abend auswählen
`,
  },
  {
    key: "books",
    content: `# Bücher

#books

@books
| Titel | Autor | Status | Bewertung | Begonnen | Beendet | Notizen |
|---|---|---|---:|---|---|---|
| The Creative Act | Rick Rubin | Reading |  | ${ctx.now.getFullYear()}-05-01 |  | kurze Abschnitte für jeden Tag |
| Braiding Sweetgrass | Robin Wall Kimmerer | Want |  |  |  | Ökologie und Aufmerksamkeit |
| Four Thousand Weeks | Oliver Burkeman | Done | 5 | ${ctx.now.getFullYear()}-04-01 | ${ctx.now.getFullYear()}-04-14 | nützliche Grenzen |
| A Psalm for the Wild-Built | Becky Chambers | Done | 4 | ${ctx.now.getFullYear()}-03-11 | ${ctx.now.getFullYear()}-03-15 | ruhige Fiktion |
| The Art of Fermentation | Sandor Katz | Reference |  |  |  | einzelne Kapitel nachschlagen |

:::query
source: notes
scope: notebook
where:
  - field: $tags
    op: contains
    value: book
sort:
  field: $title
  direction: asc
columns:
  - $title
  - book.author
  - book.status
limit: 25
:::

:::info
Halte diese Tabelle kurz. Wenn ein Buch ausführliche Notizen benötigt, lege eine Seite an und verlinke sie über den Titel.
:::
`,
  },
  {
    key: "creative-act",
    content: bookContentDe(
      "The Creative Act",
      "Rick Rubin",
      "Reading",
      "",
      [
        "Aufmerksamkeit wird als Praxis verstanden, nicht als Stimmung.",
        "Nützliche Erinnerung: zuerst breit sammeln, später bearbeiten.",
        "Die kurzen Abschnitte eignen sich für kleine Leseeinheiten.",
      ],
      [
        "Passt gut zu Notizabläufen, weil Erfassen und Bewerten getrennt werden.",
        "Rohnotizen einmal pro Woche durchsehen, statt sie bereits beim Erfassen zu bearbeiten.",
      ],
    ),
  },
  {
    key: "braiding-sweetgrass",
    content: bookContentDe(
      "Braiding Sweetgrass",
      "Robin Wall Kimmerer",
      "Want",
      "",
      ["Mit geöffnetem Gartentagebuch lesen.", "Pflanzennamen und Vorgehensweisen mit Bezug zur lokalen Ökologie festhalten."],
      [
        "Mögliche Verbindung zwischen Lesenotizen und dem Plan für die heimische Hecke.",
        "Auf praktische Beobachtungen achten, nicht nur auf schöne Passagen.",
      ],
    ),
  },
];
