import { expect, test } from "bun:test";
import { gridsHelp } from ".";

test("table help links to the shared formula reference in both languages", async () => {
  const knownIds = new Set(gridsHelp.documents.map((document) => document.id));
  for (const locale of ["en", "de"]) {
    const markdown = await Bun.file(new URL(`./documents/${locale}/grids-tables-fields.help.md`, import.meta.url)).text();
    expect(markdown).toContain("/app/grids/help/grids-formulas");
    for (const link of markdown.matchAll(/\]\(\/app\/grids\/help\/([a-z0-9-]+)\)/g)) {
      expect(knownIds.has(link[1]!), `${locale}: ${link[1]}`).toBe(true);
    }
    for (const fn of ["LIST_SUM", "LIST_AVG", "LIST_MIN", "LIST_MAX", "LIST_COUNT"]) expect(markdown).toContain(fn);
  }
});
