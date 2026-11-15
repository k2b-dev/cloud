import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDirectory, isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * In the Assistant, plum is the primary colour (`appearance.primary: "ai"`): buttons, focus, selection and links follow
 * the primary tokens. A fixed Tailwind blue class (`text-blue-600`, `hover:bg-blue-50`, …) would stay blue inside that
 * scope, so the Assistant uses the role tokens (`--k2b-action`, `--k2b-selected`, …) instead.
 */
const ROOT = "packages/assistant/src";
const BLUE = /(?<![\w-])(?:[a-z-]+:)*[a-z-]+-blue-\d{2,3}(?:\/\d{1,3})?(?![\w-])/g;

/** Every fixed blue utility class in one source, with its line. */
export const blueClasses = (source: string): { line: number; match: string }[] =>
  source.split("\n").flatMap((text, index) => [...text.matchAll(BLUE)].map((match) => ({ line: index + 1, match: match[0] })));

export const rule: Rule = {
  name: "assistant-no-blue",
  description: "The Assistant uses the primary role tokens, never fixed blue utility classes",
  run: async ({ workspaceRoot }) => {
    const root = join(workspaceRoot, ROOT);
    if (!isDirectory(root)) return [];
    const findings: Finding[] = [];
    for (const path of listFiles(root, sourceFilePattern)) {
      if (isTestFile(path)) continue;
      for (const { line, match } of blueClasses(readFileSync(path, "utf8")))
        findings.push({
          file: relative(workspaceRoot, path),
          line,
          message: `${match} stays blue in Gustav's plum primary; use a role token such as text-[var(--k2b-action)]`,
        });
    }
    return findings;
  },
};
