import { describe, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { buildInfoBlockSnippet, infoBlockCompletionSource, markdownExtension } from "@k2b/editor/markdown";
import { parseNotebookChartBlocks } from "@k2b/editor/markdown/lib/chart-blocks";
import { notebookChartOptions } from "../../../lib/chart-options";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "../../../lib/query-blocks";

const stateFor = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });
describe("Notebooks directive snippets", () => {
  test("query and TOC snippets conform to the shared parser", () => {
    const query = `:::${buildInfoBlockSnippet("query").replace("${0}", "")}`;
    const toc = `:::${buildInfoBlockSnippet("toc").replace("${0}", "")}`;
    expect(parseNotebookQueryBlocks(query).blocks).toHaveLength(1);
    expect(parseNotebookQueryBlocks(query).diagnostics).toEqual([]);
    expect(parseNotebookTocBlocks(toc).blocks).toHaveLength(1);
    expect(parseNotebookTocBlocks(toc).diagnostics).toEqual([]);
  });
});

test("offers a chart snippet that parses without diagnostics", () => {
  const doc = ":::";
  const result = infoBlockCompletionSource(new CompletionContext(stateFor(doc), doc.length, true));
  expect(result?.options.find((option) => option.label === "chart")?.detail).toBe("Chart from a table or list");
  const parsed = parseNotebookChartBlocks(`:::${buildInfoBlockSnippet("chart").replace("${0}", "")}`, notebookChartOptions);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.blocks[0]?.input.kind).toBe("bar");
});
