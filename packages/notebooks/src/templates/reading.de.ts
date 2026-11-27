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
- [x] Unterleuten in der Bibliothek ausleihen
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
| Momo | Michael Ende | Lese ich |  | ${ctx.now.getFullYear()}-05-01 |  | kurze Kapitel für jeden Abend |
| Unterleuten | Juli Zeh | Will ich lesen |  |  |  | Dorfroman, Empfehlung von Anna |
| Der Process | Franz Kafka | Gelesen | 5 | ${ctx.now.getFullYear()}-04-01 | ${ctx.now.getFullYear()}-04-14 | beklemmend und genau |
| Altes Land | Dörte Hansen | Gelesen | 4 | ${ctx.now.getFullYear()}-03-11 | ${ctx.now.getFullYear()}-03-15 | ruhig, norddeutsch |
| Duden – Die deutsche Rechtschreibung | Dudenredaktion | Zum Nachschlagen |  |  |  | einzelne Regeln nachschlagen |

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
      "Momo",
      "Michael Ende",
      "Lese ich",
      "",
      [
        "Zeit ist Leben, und das Leben wohnt im Herzen.",
        "Die grauen Herren sparen Zeit, und niemand hat mehr welche.",
        "Beppo Straßenkehrer nimmt immer nur den nächsten Schritt.",
      ],
      [
        "Passt gut zu Notizabläufen: einen Schritt nach dem anderen, statt alles auf einmal zu ordnen.",
        "Zitate einmal pro Woche durchsehen, statt sie schon beim Lesen zu bewerten.",
      ],
    ),
  },
  {
    key: "braiding-sweetgrass",
    content: bookContentDe(
      "Unterleuten",
      "Juli Zeh",
      "Will ich lesen",
      "",
      ["Nach dem Lesen festhalten, welche Figur man am Ende verstanden hat.", "Notieren, wo die Erzählung die Sicht wechselt."],
      ["Empfehlung von Anna; danach mit ihr darüber sprechen.", "Auf das Dorf als Ganzes achten, nicht nur auf einzelne Figuren."],
    ),
  },
];
