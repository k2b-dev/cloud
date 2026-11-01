import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const message =
  "Serialized JSON/text SQL parameters need ::text::jsonb; Bun otherwise stores a JSON string (#2336). Pass objects directly only when the parameter is an object.";

/** Inspect real tagged templates, including multiline/nested stringify expressions and local text aliases. */
export function checkSqlJsonbTextSource(file: string, source: string): Finding[] {
  if (!/(?:::|\bAS)\s*(?:pg_catalog\.)?jsonb?\b/i.test(source)) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // A file-local checker resolves lexical scopes and explicit string parameter types without loading dependencies.
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file ? sourceFile : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === file,
    readFile: (name) => (name === file ? source : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const checker = ts.createProgram([file], { noLib: true, noResolve: true }, host).getTypeChecker();
  const isText = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    const type = checker.getTypeAtLocation(node);
    if ((type.isUnion() ? type.types : [type]).some((part) => !!(part.flags & ts.TypeFlags.StringLike))) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isText(node.expression, seen);
    if (ts.isConditionalExpression(node)) return isText(node.whenTrue, seen) || isText(node.whenFalse, seen);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "JSON" &&
      node.expression.name.text === "stringify"
    )
      return true;
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return isText(declaration.initializer, seen);
    }
    return false;
  };
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
      for (const [index, span] of node.template.templateSpans.entries()) {
        const stripComments = (value: string) => value.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ");
        let suffix = stripComments(span.literal.text);
        let prefix = stripComments(index ? node.template.templateSpans[index - 1]!.literal.text : node.template.head.text);
        // Also catch a parenthesized parameter, without mistaking function arguments for a cast of that parameter.
        while (/^\s*\)/.test(suffix) && /\(\s*$/.test(prefix)) {
          const word = /([\w"]+)\s*\(\s*$/.exec(prefix)?.[1];
          if (word && !/^(SELECT|VALUES|THEN|ELSE|RETURNING)$/i.test(word)) break;
          suffix = suffix.replace(/^\s*\)/, "");
          prefix = prefix.replace(/\(\s*$/, "");
        }
        const direct = /^\s*::\s*(?:pg_catalog\.)?jsonb?\b/i.test(suffix);
        const cast = /\bCAST\s*\(\s*$/i.test(prefix) && /^\s*AS\s+(?:pg_catalog\.)?jsonb?\s*\)/i.test(suffix);
        if ((direct || cast) && isText(span.expression)) {
          findings.push({ file, line: sourceFile.getLineAndCharacterOfPosition(span.expression.getStart(sourceFile)).line + 1, message });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export const collectSqlJsonbTextFindings = (root: string): Finding[] =>
  ["packages", "scripts", "docs-site/src", "pwas"]
    .flatMap((dir) => listFiles(join(root, dir), sourceFilePattern))
    .sort()
    .flatMap((file) => checkSqlJsonbTextSource(relative(root, file), readFileSync(file, "utf8")));

export const rule: Rule = {
  name: "sql-jsonb-text",
  description: "Serialized JSON SQL parameters explicitly pass through text before jsonb",
  run: async ({ workspaceRoot }) => {
    // Existing unrelated applications migrate separately. No Code paths are grandfathered.
    const path = join(workspaceRoot, "scripts/checks/sql-jsonb-text.baseline");
    const baseline = new Map<string, number>();
    if (existsSync(path))
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const match = /^(.+) \| ([1-9]\d*)$/.exec(line);
        if (!match) throw new Error(`Invalid sql-jsonb-text baseline: ${line}`);
        baseline.set(match[1]!, Number(match[2]));
      }
    const grouped = new Map<string, Finding[]>();
    for (const finding of collectSqlJsonbTextFindings(workspaceRoot)) {
      const file = finding.file!;
      grouped.set(file, [...(grouped.get(file) ?? []), finding]);
    }
    return [...grouped].flatMap(([file, findings]) => (findings.length > (baseline.get(file) ?? 0) ? findings : []));
  },
};
