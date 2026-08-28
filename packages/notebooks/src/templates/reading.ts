import { readingNotesDe } from "./reading.de";
import type { NotebookTemplate, TemplateContext } from "./types";

const readingDashboardScript = `// Reading dashboard
// Keeps the system light: one table, optional book notes, one reading queue.

const currentYear = String(new Date().getFullYear());

// ── Read source notes ───────────────────────────────────────────
const booksNote = (await nb.search("#books"))[0];
const books = booksNote?.table("books")?.rows ?? [];
const bookNotes = await nb.search("#book");
const pages = [booksNote, ...bookNotes].filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
const queue = current.todo("reading")?.items ?? [];

// ── Derive dashboard rows ───────────────────────────────────────
const byStatus = books.reduce((acc, row) => {
  const key = row.Status || "Unknown";
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
const linkedBook = (row) => bookNotes.find((note) => note.title === row.Title) ?? row.Title;
const reading = books.filter((row) => row.Status === "Reading").map((row) => ({
  Book: linkedBook(row),
  Author: row.Author,
  Started: row.Started,
  Notes: row.Notes,
}));
const finishedThisYear = books.filter((row) => String(row.Finished ?? "").startsWith(currentYear));
const topRated = books
  .filter((row) => Number(row.Rating) > 0)
  .sort((a, b) => Number(b.Rating) - Number(a.Rating))
  .slice(0, 5)
  .map((row) => ({ Book: linkedBook(row), Rating: row.Rating, Status: row.Status }));
const queueRows = queue.map((item) => ({
  Queue: item.content,
  Done: item.done ? "yes" : "open",
  Action: item.done ? "" : ui.button("Done", async () => {
    await current.replaceLine(item.line, "- [x] " + item.content);
  }, { variant: "secondary", icon: "ti ti-check" }),
}));

// ── Render dashboard ────────────────────────────────────────────
ui.render(
  ui.heading("Reading dashboard", 2),
  ui.row(
    ui.metric("Books", books.length, { icon: "ti ti-books", tone: "info" }),
    ui.metric("Finished this year", finishedThisYear.length, { icon: "ti ti-check", tone: "success" }),
    ui.metric("Queued", queue.filter((item) => !item.done).length, { icon: "ti ti-list-check", tone: "warning" }),
  ),
  ui.table(reading, { emptyText: "No current reads." }),
  ui.chart("donut", {
    data: Object.entries(byStatus).map(([label, value]) => ({ label, value })),
    title: "Books by status",
    showLabels: true,
    height: 180,
  }),
  ui.table(topRated, { emptyText: "No ratings yet." }),
  ui.table(queueRows, { emptyText: "Queue is empty." }),
  ui.heading("Reading pages", 3),
  ui.noteList(pages, { emptyText: "No reading pages yet." }),
  ui.button("Add queue item", async () => {
    const title = await ui.prompt.text("Book title", "", { title: "Add to reading queue", placeholder: "Four Thousand Weeks" });
    if (!title) return;
    await current.todo("reading")?.add(title);
    ui.toast("Added to queue", { variant: "success" });
  }, { icon: "ti ti-book-2" }),
);`;

const readingLibraryScript = `// Book note index
const bookNotes = (await nb.search("#book")).sort((a, b) => a.title.localeCompare(b.title));

ui.render(
  ui.heading("Book notes", 2),
  ui.table(bookNotes.map((note) => {
    const meta = note.data("book")?.value ?? {};
    return {
      Book: note,
      Author: meta.author ?? "",
      Status: meta.status ?? "",
      Rating: meta.rating ?? "",
      Quotes: note.list("quotes")?.items.length ?? 0,
    };
  }), { emptyText: "No book notes yet." }),
);`;

const bookContent = (title: string, author: string, status: string, rating: string, quotes: string[], notes: string[]) => `# ${title}

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
## Notes

${notes.map((note) => `- ${note}`).join("\n")}
`;

export const readingListTemplate: NotebookTemplate = {
  id: "reading-list",
  name: "Reading List",
  description: "Books, reading queue, notes, quotes, ratings, and charts.",
  icon: "ti ti-books",
  notebookName: "Reading List",
  notebookDescription: "Track books, current reads, quotes, and a queue without turning reading into project management.",
  translations: {
    de: {
      name: "Leseliste",
      description: "Bücher, Leseliste, Notizen, Zitate, Bewertungen und Diagramme.",
      notebookName: "Leseliste",
      notebookDescription: "Bücher, aktuelle Lektüre, Zitate und eine Merkliste verwalten, ohne das Lesen zum Projektmanagement zu machen.",
    },
  },
  scriptsEnabled: true,
  homepageNoteKey: "dashboard",
  notes: (ctx: TemplateContext) =>
    ctx.locale?.toLowerCase().split("-")[0] === "de"
      ? readingNotesDe(ctx)
      : [
          {
            key: "dashboard",
            content: (c) => `# Reading Dashboard

#reading

:::success
Start here. Keep the reading system light: one table for tracking, separate notes only for books that earn them.
:::

## How to use this reading list

1. Track status, dates, and ratings in ${c.link("books", "Books")}.
2. Use book notes for quotes and thoughts that are worth keeping.
3. Add quick ideas to the reading queue below, then decide later what to read.
4. Do not over-manage reading. The dashboard is for direction, not pressure.

:::info
The books table is the source of truth. Book notes add depth, quotes, and personal observations.
:::

\`\`\`script
${readingDashboardScript}
\`\`\`

@reading
- [x] Borrow Braiding Sweetgrass from the library
- [ ] Add a nonfiction book about attention
- [ ] Pick one short evening novel
`,
          },
          {
            key: "books",
            content: (c) => `# Books

#books

@books
| Title | Author | Status | Rating | Started | Finished | Notes |
|---|---|---|---:|---|---|---|
| The Creative Act | Rick Rubin | Reading |  | ${ctx.now.getFullYear()}-05-01 |  | short daily sections |
| Braiding Sweetgrass | Robin Wall Kimmerer | Want |  |  |  | ecology and attention |
| Four Thousand Weeks | Oliver Burkeman | Done | 5 | ${ctx.now.getFullYear()}-04-01 | ${ctx.now.getFullYear()}-04-14 | useful limits |
| A Psalm for the Wild-Built | Becky Chambers | Done | 4 | ${ctx.now.getFullYear()}-03-11 | ${ctx.now.getFullYear()}-03-15 | calm fiction |
| The Art of Fermentation | Sandor Katz | Reference |  |  |  | dip into chapters |

\`\`\`script
${readingLibraryScript}
\`\`\`

:::info
Keep this table small. If a book needs real notes, create a page and link it from the title.
:::
`,
          },
          {
            key: "creative-act",
            content: bookContent(
              "The Creative Act",
              "Rick Rubin",
              "Reading",
              "",
              [
                "Attention is treated as a practice, not a mood.",
                "Useful reminder: collect broadly, edit later.",
                "Short sections make this easy to read in small sessions.",
              ],
              [
                "Good companion for notebook workflows because it separates capture from judgement.",
                "Try a weekly pass over raw notes instead of editing during capture.",
              ],
            ),
          },
          {
            key: "braiding-sweetgrass",
            content: bookContent(
              "Braiding Sweetgrass",
              "Robin Wall Kimmerer",
              "Want",
              "",
              ["Read with the garden log open.", "Track plant names and practices that connect to local ecology."],
              [
                "Potential bridge between reading notes and the native hedge plan.",
                "Look for practical observations, not only beautiful passages.",
              ],
            ),
          },
        ],
};
