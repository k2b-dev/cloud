import { expect, test } from "bun:test";
import { GRID_FORMULA_FUNCTIONS } from "../formula/function-catalog";
import { helpTopicHref, REFERENCE_TOPICS } from "../frontend/reference-redirects";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { gridsHelp } from ".";

// The Help topics are the reference: the in-app reference windows are gone, so these guards keep the topics complete.
const topic = (locale: string, id: string) => Bun.file(new URL(`./documents/${locale}/${id}.help.md`, import.meta.url)).text();
const gqlBlocks = (markdown: string) => [...markdown.matchAll(/```gql\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());

test("every GQL example in the query topic parses with the public parser and uses no removed syntax", async () => {
  for (const locale of ["en", "de"]) {
    const blocks = gqlBlocks(await topic(locale, "grids-gql"));
    expect(blocks.length, locale).toBeGreaterThan(10);
    for (const code of blocks) {
      expect(parseGridsQueryDsl(code).ok, `${locale}:\n${code}`).toBe(true);
      expect(code).not.toMatch(/(^|\s)skip\s/i);
      expect(code).not.toMatch(/(^|[^A-Za-z0-9_])#[A-Za-z0-9_-]+/);
    }
  }
});

test("the formula topic names every formula function with its call, in both languages", async () => {
  for (const locale of ["en", "de"]) {
    const markdown = await topic(locale, "grids-formulas");
    for (const fn of GRID_FORMULA_FUNCTIONS) expect(markdown, `${locale}: ${fn.name}`).toMatch(new RegExp(`\\b${fn.name}\\(`));
  }
});

test("links to the retired reference windows open a registered Help topic, the query language by default", () => {
  const ids = new Set(gridsHelp.documents.map((document) => document.id));
  for (const id of REFERENCE_TOPICS.values()) expect(ids.has(id), id).toBe(true);
  expect(helpTopicHref("formulas")).toBe("/help/apps/grids/grids-formulas");
  expect(helpTopicHref(undefined)).toBe("/help/apps/grids/grids-gql");
  expect(helpTopicHref("constructor")).toBe("/help/apps/grids/grids-gql");
});
