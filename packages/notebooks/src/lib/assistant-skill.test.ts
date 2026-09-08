import { expect, test } from "bun:test";
import { parseNamedDataBlockResult } from "./named-blocks";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "./query-blocks";

test("the shipped Assistant skill uses executable data, query and TOC examples", async () => {
  const source = await Bun.file(new URL("../../../cloud/src/ai/skill-seeds.ts", import.meta.url)).text();
  const reference = source
    .match(/const CLOUD_NOTEBOOKS_REFERENCE = `([\s\S]*?)\n`;/)?.[1]
    ?.replaceAll("\\`", "`");
  expect(reference).toBeDefined();
  const examples = [...reference!.matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  expect(examples).toHaveLength(3);
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
});
