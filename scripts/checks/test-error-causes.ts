import { readFileSync } from "node:fs";
import ts from "@typescript/typescript6";
import { playwrightImport } from "./browser-launch";
import { isTestFile, listFiles, parseSource, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const message =
  "a Playwright test that catches an error and throws another keeps the caught one: name it and pass it on (`{ cause }` or in the message), as waitInPage() in packages/ui/test/browser.ts does. Otherwise a red run loses Playwright's own reason, such as a closed page or a destroyed context (#4121)";

/** The handler of a `catch` clause or a `.catch(…)` callback: its error's name (null when it names none) and body. */
const handlerOf = (node: ts.Node): { name: string | null; body: ts.Node } | undefined => {
  if (ts.isCatchClause(node)) {
    const declared = node.variableDeclaration?.name;
    if (declared && !ts.isIdentifier(declared)) return undefined;
    return { name: declared?.text ?? null, body: node.block };
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "catch")
    return undefined;
  const callback = node.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return undefined;
  const param = callback.parameters[0]?.name;
  if (param && !ts.isIdentifier(param)) return undefined;
  return { name: param?.text ?? null, body: callback.body };
};

/** The nodes of a handler's own body, not those of functions defined inside it. */
const ownNodes = (body: ts.Node): ts.Node[] => {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    found.push(node);
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
};

const mentions = (node: ts.Node, names: ReadonlySet<string>): boolean =>
  (ts.isIdentifier(node) && names.has(node.text)) || (ts.forEachChild(node, (child) => mentions(child, names) || undefined) ?? false);

/** The caught error's name and the local names built from it (`const report = new Error(…, { cause: error })`). */
const carriers = (name: string, nodes: readonly ts.Node[]): Set<string> => {
  const names = new Set([name]);
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && mentions(node.initializer, names))
      names.add(node.name.text);
  }
  return names;
};

export const rule: Rule = {
  name: "test-error-causes",
  description: "Playwright tests that replace a caught error keep it, so a red run names Playwright's own reason",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const file of listFiles(workspaceRoot, sourceFilePattern).sort()) {
      if (!isTestFile(file) && !file.endsWith(".browser-suite.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (!playwrightImport.test(source)) continue;
      const parsed = parseSource(file, source);
      findings.push(...parsed.findings);
      const visit = (node: ts.Node) => {
        const handler = handlerOf(node);
        if (handler) {
          const nodes = ownNodes(handler.body);
          const kept = handler.name === null ? new Set<string>() : carriers(handler.name, nodes);
          for (const thrown of nodes.filter(ts.isThrowStatement)) {
            if (thrown.expression && mentions(thrown.expression, kept)) continue;
            const line = parsed.sourceFile.getLineAndCharacterOfPosition(thrown.getStart()).line + 1;
            findings.push({ file, line, message });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed.sourceFile);
    }
    return findings;
  },
};
