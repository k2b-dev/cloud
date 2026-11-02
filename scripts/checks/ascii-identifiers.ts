import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const nonAscii = /[^\x00-\x7f]/;

/**
 * Identifiers and object keys in shipped code stay ASCII. A bundler prints a key such as `"übermorgen"` as a bare
 * identifier, and a browser that reads the script as Latin-1 (WebKit without a charset) stops at its first non-ASCII
 * byte, so one word in a parser table broke every page that loaded `@k2b/ui`. Strings, regular expressions and
 * comments are unaffected: there a wrong decoding only garbles text.
 */
const findInFile = (path: string, source: string): { line: number; name: string }[] => {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const hits: { line: number; name: string }[] = [];
  const report = (node: ts.Node, name: string) =>
    hits.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, name });
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && nonAscii.test(node.text)) report(node, node.text);
    else if (
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertySignature(node)) &&
      ts.isStringLiteral(node.name) &&
      nonAscii.test(node.name.text) &&
      // Only a key that is a valid identifier gets printed bare; "Loading…" stays quoted.
      ts.isIdentifierText(node.name.text, ts.ScriptTarget.Latest)
    )
      report(node.name, node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
};

export const rule: Rule = {
  name: "ascii-identifiers",
  description: "Identifiers and object keys in shipped package code are ASCII, so a script read as Latin-1 still parses",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const packagesRoot = join(workspaceRoot, "packages");
    for (const path of listFiles(packagesRoot, sourceFilePattern)) {
      if (isTestFile(path) || !path.includes("/src/")) continue;
      for (const hit of findInFile(path, readFileSync(path, "utf8"))) {
        findings.push({
          file: relative(workspaceRoot, path),
          line: hit.line,
          message: `"${hit.name}" is not ASCII; use an ASCII name or a [string, value] pair`,
        });
      }
    }
    return findings;
  },
};
