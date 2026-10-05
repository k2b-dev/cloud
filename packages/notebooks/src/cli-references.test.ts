import { expect, setSystemTime, test } from "bun:test";
import { evaluateFormula } from "@k2b/cloud/shared";
import { renderNotebookBook } from "./lib/book-renderer";
import { extractNamedDataProperties } from "./lib/named-blocks";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "./lib/query-blocks";

const reference = (file: string) => Bun.file(new URL(`./cli-references/${file}`, import.meta.url)).text();

/** Markdown examples, including four-backtick fences that wrap code fences. */
const markdownExamples = (source: string): string[] =>
  [...source.matchAll(/^(`{3,})markdown\n([\s\S]*?)\n\1$/gm)].map((match) => match[2]!);

test("every Markdown example in the agent references renders as documented", async () => {
  const examples = (await Promise.all(["index.md", "markdown.md", "formulas.md"].map(reference))).flatMap(markdownExamples);
  expect(examples.length).toBeGreaterThan(10);
  for (const markdown of examples) {
    expect(parseNotebookQueryBlocks(markdown).diagnostics, markdown).toEqual([]);
    expect(parseNotebookTocBlocks(markdown).diagnostics, markdown).toEqual([]);
    expect(extractNamedDataProperties(markdown).diagnostics, markdown).toEqual([]);
    const { html } = renderNotebookBook({ markdown, notebookId: "Ab12Cd", locale: "en" });
    expect(html, markdown).not.toContain("md-formula-error");
    expect(html.replace(/<pre>[\s\S]*?<\/pre>/g, ""), markdown).not.toContain(":::");
    const callouts = markdown.match(/^:::(?:note|info|success|warning|danger)$/gm) ?? [];
    expect(html.match(/<aside /g)?.length ?? 0, markdown).toBe(callouts.length);
  }
});

test("the formula examples compute the values they are meant to show", async () => {
  // TODAY() reads the local date; noon keeps it 2026-10-05 in every time zone.
  setSystemTime(new Date(2026, 9, 5, 12));
  try {
    const examples = (await Promise.all(["index.md", "markdown.md", "formulas.md"].map(reference))).flatMap(markdownExamples);
    const computed = examples
      .filter((markdown) => /\| =/.test(markdown))
      .map((markdown) =>
        [
          ...renderNotebookBook({ markdown, notebookId: "Ab12Cd", locale: "en" }).html.matchAll(/md-formula-ok[^>]*><i[^>]*><\/i>([^<]*)/g),
        ].map((match) => match[1]),
      );
    expect(computed).toEqual([
      ["60", "12", "72"], // markdown.md, tables: Price * Quantity and SUM(Total)
      ["3", "7"], // markdown.md, complete example: days left until 2026-10-08 and 2026-10-12
      ["60", "60"], // formulas.md: Price * Quantity and SUM(Total)
    ]);
  } finally {
    setSystemTime();
  }
});

test("a callout title is not Notebook syntax", () => {
  const { html } = renderNotebookBook({ markdown: ":::warning Before deleting\nText\n:::", notebookId: "Ab12Cd", locale: "en" });
  expect(html).not.toContain("<aside");
});

test("the formula reference names only functions the evaluator knows", async () => {
  const names = new Set([...(await reference("formulas.md")).matchAll(/`([A-Z]+)\(/g)].map((match) => match[1]!));
  expect(names.size).toBeGreaterThan(30);
  for (const name of names) {
    const result = evaluateFormula(`=${name}()`, { headers: [], rows: [[]], currentRow: 0, currentCol: 0 });
    expect(result.kind === "error" ? result.code : "ok", name).not.toBe("UNKNOWN_FUNCTION");
  }
});
