import type { TemplateContext, TemplateNote } from "./types";

const readingDashboardScriptDe = `// Leseübersicht
const currentYear = String(new Date().getFullYear());
const statusLabel = { Reading: "Wird gelesen", Want: "Vorgemerkt", Done: "Gelesen", Reference: "Nachschlagewerk", Unknown: "Unbekannt" };

const booksNote = (await nb.search("#books"))[0];
const books = booksNote?.table("books")?.rows ?? [];
const bookNotes = await nb.search("#book");
const pages = [booksNote, ...bookNotes].filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
const queue = current.todo("reading")?.items ?? [];

const byStatus = books.reduce((acc, row) => {
  const key = statusLabel[row.Status] ?? statusLabel.Unknown;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
const linkedBook = (row) => bookNotes.find((note) => note.title === row.Title) ?? row.Title;
const reading = books.filter((row) => row.Status === "Reading").map((row) => ({
  Buch: linkedBook(row), Autor: row.Author, Begonnen: row.Started, Notizen: row.Notes,
}));
const finishedThisYear = books.filter((row) => String(row.Finished ?? "").startsWith(currentYear));
const topRated = books
  .filter((row) => Number(row.Rating) > 0)
  .sort((a, b) => Number(b.Rating) - Number(a.Rating))
  .slice(0, 5)
  .map((row) => ({ Buch: linkedBook(row), Bewertung: row.Rating, Status: statusLabel[row.Status] ?? row.Status }));
const queueRows = queue.map((item) => ({
  Merkliste: item.content,
  Status: item.done ? "erledigt" : "offen",
  Aktion: item.done ? "" : ui.button("Erledigt", async () => {
    await current.replaceLine(item.line, "- [x] " + item.content);
  }, { variant: "secondary", icon: "ti ti-check" }),
}));

ui.render(
  ui.heading("Leseübersicht", 2),
  ui.row(
    ui.metric("Bücher", books.length, { icon: "ti ti-books", tone: "info" }),
    ui.metric("Dieses Jahr gelesen", finishedThisYear.length, { icon: "ti ti-check", tone: "success" }),
    ui.metric("Vorgemerkt", queue.filter((item) => !item.done).length, { icon: "ti ti-list-check", tone: "warning" }),
  ),
  ui.table(reading, { emptyText: "Derzeit wird kein Buch gelesen." }),
  ui.chart("donut", {
    data: Object.entries(byStatus).map(([label, value]) => ({ label, value })),
    title: "Bücher nach Status", showLabels: true, height: 180,
  }),
  ui.table(topRated, { emptyText: "Noch keine Bewertungen vorhanden." }),
  ui.table(queueRows, { emptyText: "Die Merkliste ist leer." }),
  ui.heading("Leseseiten", 3),
  ui.noteList(pages, { emptyText: "Noch keine Leseseiten vorhanden." }),
  ui.button("Buch vormerken", async () => {
    const title = await ui.prompt.text("Buchtitel", "", { title: "Zur Merkliste hinzufügen", placeholder: "Four Thousand Weeks" });
    if (!title) return;
    await current.todo("reading")?.add(title);
    ui.toast("Zur Merkliste hinzugefügt", { variant: "success" });
  }, { icon: "ti ti-book-2" }),
);`;

const readingLibraryScriptDe = `// Verzeichnis der Buchnotizen
const bookNotes = (await nb.search("#book")).sort((a, b) => a.title.localeCompare(b.title));
const statusLabel = { Reading: "Wird gelesen", Want: "Vorgemerkt", Done: "Gelesen", Reference: "Nachschlagewerk" };

ui.render(
  ui.heading("Buchnotizen", 2),
  ui.table(bookNotes.map((note) => {
    const meta = note.data("book")?.value ?? {};
    return {
      Buch: note,
      Autor: meta.author ?? "",
      Status: statusLabel[meta.status] ?? meta.status ?? "",
      Bewertung: meta.rating ?? "",
      Zitate: note.list("quotes")?.items.length ?? 0,
    };
  }), { emptyText: "Noch keine Buchnotizen vorhanden." }),
);`;

const bookContentDe = (title: string, author: string, status: string, rating: string, quotes: string[], notes: string[]) => `# ${title}

#book

@book
:::data
title: ${title}
author: ${author}
status: ${status}
rating: ${rating}
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
Die Büchertabelle ist die verbindliche Übersicht. Buchnotizen ergänzen Zitate und persönliche Beobachtungen.
:::

\`\`\`script
${readingDashboardScriptDe}
\`\`\`

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
| Title | Author | Status | Rating | Started | Finished | Notes |
|---|---|---|---:|---|---|---|
| The Creative Act | Rick Rubin | Reading |  | ${ctx.now.getFullYear()}-05-01 |  | kurze Abschnitte für jeden Tag |
| Braiding Sweetgrass | Robin Wall Kimmerer | Want |  |  |  | Ökologie und Aufmerksamkeit |
| Four Thousand Weeks | Oliver Burkeman | Done | 5 | ${ctx.now.getFullYear()}-04-01 | ${ctx.now.getFullYear()}-04-14 | nützliche Grenzen |
| A Psalm for the Wild-Built | Becky Chambers | Done | 4 | ${ctx.now.getFullYear()}-03-11 | ${ctx.now.getFullYear()}-03-15 | ruhige Fiktion |
| The Art of Fermentation | Sandor Katz | Reference |  |  |  | einzelne Kapitel nachschlagen |

\`\`\`script
${readingLibraryScriptDe}
\`\`\`

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
