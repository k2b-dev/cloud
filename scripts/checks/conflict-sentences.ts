import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** The words of a literal message, without its `${…}` parts. */
const wordsOf = (node: ts.Expression): number | undefined => {
  const text = ts.isStringLiteralLike(node)
    ? node.text
    : ts.isTemplateExpression(node)
      ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")
      : undefined;
  return text === undefined ? undefined : text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
};

/**
 * `err.conflict(message)` from `@k2b/stdlib` takes the whole sentence a person or agent reads, as given; since 0.33.0
 * it appends nothing. A literal of fewer than two words, such as `err.conflict("Passkey")`, is a subject that used to
 * become "Passkey already exists" and would now read as just "Passkey" (#1326). Messages from a catalog or a
 * variable are sentences by construction and are not read here.
 */
export const checkSource = (file: string, source: string): Finding[] => {
  if (!source.includes("conflict(")) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "conflict" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "err"
    ) {
      const [message] = node.arguments;
      const words = message ? wordsOf(message) : 0;
      if (words !== undefined && words < 2)
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          message:
            'err.conflict takes the whole sentence a person reads, such as "Passkey already exists"; it appends nothing since @k2b/stdlib 0.33.0 (#1326)',
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const rule: Rule = {
  name: "conflict-sentences",
  description: "err.conflict gets a whole sentence, not a subject",
  run: async ({ workspaceRoot }) =>
    [...workspacePackages(workspaceRoot), "scripts"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .filter((file) => !isTestFile(file))
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
