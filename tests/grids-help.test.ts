import { expect, test } from "bun:test";
import { compileHelp } from "../packages/cloud/src/_internal/help";
import { selectHelpMarkdown } from "../packages/cloud/src/_internal/help-catalog";
import { gridsHelp } from "../packages/grids/src/help";

test("the full bilingual Grids help fits the startup registry contract", () => {
  const compiled = compileHelp({
    appId: "grids",
    basePath: "/app/grids",
    definition: gridsHelp,
  });
  expect(Object.keys(compiled.summary).sort()).toEqual(["baseLocale", "manifestHash", "pageBase"]);
  expect([...new Set([compiled.corpus.baseLocale, ...Object.keys(compiled.corpus.documentsByLocale ?? {})])].sort()).toEqual(["de", "en"]);
});

test("agent Help retrieval reaches exact authoring sections without dumping the whole corpus", () => {
  const corpus = compileHelp({ appId: "grids", basePath: "/app/grids", definition: gridsHelp }).corpus;
  for (const [locale, heading] of [
    ["en", "Generated identifiers"],
    ["de", "Generierte Kennungen"],
  ] as const) {
    const documents = locale === "en" ? corpus.documents : corpus.documentsByLocale?.[locale];
    const fields = documents?.find((document) => document.id === "grids-field-configuration");
    expect(fields?.searchText).toContain("date_sequence");
    const selected = selectHelpMarkdown(gridsHelp.getMarkdown("grids-field-configuration", locale)!, heading);
    expect(selected.markdown).toContain("finalization");
    expect(selected.markdown).toContain("date_sequence");
    expect(selected.markdown).not.toContain("html_template");
    expect(selected.markdown.length).toBeLessThanOrEqual(7_000);
  }
});
