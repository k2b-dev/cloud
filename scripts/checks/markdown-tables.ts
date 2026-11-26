import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** The cells of a table row: split at every pipe that is not escaped, as GitHub Flavored Markdown does. */
const cells = (row: string): number => {
  const inner = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).length;
};

const separator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Every row of a Markdown table has as many cells as its head. A renderer drops the cells after the head's count and
 * leaves the missing ones empty, so a row pasted into the middle of another one shows half a row and loses a link
 * without any warning (the API reference lost a row this way).
 */
export const findInMarkdown = (source: string): { line: number; message: string }[] => {
  const lines = source.split("\n");
  const hits: { line: number; message: string }[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (opener) {
      if (!fence) fence = opener[0];
      else if (opener[0] === fence) fence = undefined;
      continue;
    }
    if (fence || !line.trimStart().startsWith("|") || !separator.test(lines[index + 1] ?? "")) continue;
    const head = cells(line);
    if (cells(lines[index + 1]!) !== head)
      hits.push({ line: index + 2, message: `the separator has ${cells(lines[index + 1]!)} cells, the head ${head}` });
    let row = index + 2;
    for (; row < lines.length && lines[row]!.trimStart().startsWith("|"); row += 1) {
      const count = cells(lines[row]!);
      if (count !== head) hits.push({ line: row + 1, message: `the row has ${count} cells, its table's head ${head}` });
    }
    index = row - 1;
  }
  return hits;
};

export const rule: Rule = {
  name: "markdown-tables",
  description: "Every row of a documentation table has as many cells as its head",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const path of listFiles(join(workspaceRoot, "docs-site/docs"), /\.md$/)) {
      for (const hit of findInMarkdown(readFileSync(path, "utf8"))) findings.push({ file: relative(workspaceRoot, path), ...hit });
    }
    return findings;
  },
};
