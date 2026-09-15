import { expect, test } from "bun:test";
import { compileHelp } from "../packages/cloud/src/_internal/help";
import { gridsHelp } from "../packages/grids/src/help";

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
