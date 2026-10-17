import { expect, test } from "bun:test";
import { parseNotebookChartBlocks } from "./chart-blocks";
import { parseNamedDataBlockResult } from "./named-blocks";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "./query-blocks";

test("the shipped Assistant skill uses executable data, query, TOC and chart examples", async () => {
  const reference = await Bun.file(new URL("../skills/cloud-notebooks/references/structured-pages.md", import.meta.url)).text();
  const examples = [...reference!.matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  expect(examples).toHaveLength(5);
  const data = examples.find((example) => example.includes(":::data"))!;
  const parsedData = parseNamedDataBlockResult(data.split(":::data\n")[1]!.split("\n:::")[0]!);
  expect(parsedData.diagnostics).toEqual([]);
  expect(parsedData.entries).toHaveLength(4);
  const query = parseNotebookQueryBlocks(examples.find((example) => example.startsWith(":::query"))!);
  expect(query.diagnostics).toEqual([]);
  expect(query.blocks).toHaveLength(1);
  expect(query.blocks[0]!.where).toHaveLength(2);
  const toc = parseNotebookTocBlocks(examples.find((example) => example.startsWith(":::toc"))!);
  expect(toc.diagnostics).toEqual([]);
  expect(toc.blocks[0]).toMatchObject({ minDepth: 2, maxDepth: 3 });
  const charts = examples.filter((example) => example.includes(":::chart"));
  expect(charts).toHaveLength(2);
  for (const example of charts) {
    const parsed = parseNotebookChartBlocks(example);
    expect(parsed.diagnostics, example).toEqual([]);
    expect(parsed.blocks, example).toHaveLength(1);
  }
});
