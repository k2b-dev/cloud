import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const testFiles = /\.(?:test|test-fixture|browser-suite)\.tsx?$/;
const compiler = /^(?:[\w]+-)*(?:cc|c\+\+|gcc|g\+\+|clang|clang\+\+|rustc|zig)(?:-\d+(?:\.\d+)*)?$/;
const launches = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);

/** Test-local setup helpers can be called from a timed hook too, so check every function body. */
export function checkTestNativeCompilersSource(file: string, source: string): Finding[] {
  if (!/\b(?:cc|c\+\+|gcc|g\+\+|clang|rustc|zig)/.test(source)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const visit = (node: ts.Node, inFunction: boolean): void => {
    if (inFunction && ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(tree);
      let command = node.arguments[0];
      if (command && ts.isObjectLiteralExpression(command)) {
        const cmd = command.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(tree) === "cmd");
        command = cmd && ts.isPropertyAssignment(cmd) ? cmd.initializer : undefined;
      }
      if (command && ts.isArrayLiteralExpression(command)) command = command.elements[0];
      if (launches.has(name) && command && ts.isStringLiteralLike(command)) {
        const executable = command.text.trim().split(/\s/)[0]?.split("/").at(-1) ?? "";
        if (compiler.test(executable)) {
          findings.push({
            file,
            line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
            message: "Compile native test fixtures once at module load or in a preload, outside test and hook timers (#3182).",
          });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inFunction || ts.isFunctionLike(node)));
  };
  visit(tree, false);
  return findings;
}

export const rule: Rule = {
  name: "test-native-compilers",
  description: "Native test fixtures compile outside test and hook timers",
  run: async ({ workspaceRoot }) =>
    ["packages", "pwas", "docs-site/src", "scripts", "tests"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), testFiles))
      .sort()
      .flatMap((file) => checkTestNativeCompilersSource(file, readFileSync(file, "utf8"))),
};
