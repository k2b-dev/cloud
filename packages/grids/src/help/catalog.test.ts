import { expect, test } from "bun:test";
import { compileHelp } from "../../../cloud/src/_internal/help";
import { gridsHelp } from ".";

test("the full bilingual Grids help fits the startup registry contract", () => {
  const compiled = compileHelp({
    appId: "grids",
    basePath: "/app/grids",
    definition: gridsHelp,
  });
  expect(Object.keys(compiled.summary).sort()).toEqual(["baseLocale", "manifestHash", "pageBase"]);
  expect([...new Set([compiled.corpus.baseLocale, ...Object.keys(compiled.corpus.documentsByLocale ?? {})])].sort()).toEqual([
    "de",
    "en",
  ]);
});

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
