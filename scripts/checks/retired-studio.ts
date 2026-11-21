import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** Also catches lazy imports and Bun.file/new URL build entrypoints. */
export function retiredStudioImports(file: string, source: string, workspaceRoot: string): Finding[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      const specifier = node.text;
      const path = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : specifier.startsWith("@/") && file.includes("/assistant/")
          ? resolve(workspaceRoot, "packages/assistant/src", specifier.slice(2))
          : resolve(workspaceRoot, specifier);
      const local = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (/^packages\/assistant\/src\/(?:artifacts(?:\/|$)|cli\/code(?:\.ts$|$)|cli\/code-host(?:[.\/-]|$))/.test(local))
        findings.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          message: "Studio is retired. Use the Assistant chat-code boundary or lasting Code.",
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
}
export const rule: Rule = {
  name: "retired-studio",
  description: "No source or build references to retired Studio execution modules",
  run: async ({ workspaceRoot }) =>
    ["packages", "scripts", "tests"].flatMap((path) =>
      listFiles(join(workspaceRoot, path), sourceFilePattern).flatMap((file) =>
        retiredStudioImports(file, readFileSync(file, "utf8"), workspaceRoot),
      ),
    ),
};
