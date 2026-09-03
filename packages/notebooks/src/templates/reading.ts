import { readingNotesDe } from "./reading.de";
import type { NotebookTemplate, TemplateContext } from "./types";

const bookContent = (title: string, author: string, status: string, rating: string, quotes: string[], notes: string[]) => `# ${title}

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
## Notes

${notes.map((note) => `- ${note}`).join("\n")}
`;

export const readingListTemplate: NotebookTemplate = {
  id: "reading-list",
  name: "Reading List",
  description: "Books, reading queue, notes, quotes, and ratings.",
  icon: "ti ti-books",
  notebookName: "Reading List",
  notebookDescription: "Track books, current reads, quotes, and a queue without turning reading into project management.",
  translations: {
    de: {
      name: "Leseliste",
      description: "Bücher, Leseliste, Notizen, Zitate und Bewertungen.",
      notebookName: "Leseliste",
      notebookDescription: "Bücher, aktuelle Lektüre, Zitate und eine Merkliste verwalten, ohne das Lesen zum Projektmanagement zu machen.",
    },
  },
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
The table tracks your reading queue. The automatic list shows separate book pages and their named data; it does not read table rows.
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
