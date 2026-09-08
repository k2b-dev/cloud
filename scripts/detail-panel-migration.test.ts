import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

test("application JSX no longer consumes removed detail utilities", async () => {
  const root = resolve(import.meta.dir, "..");
  const violations: string[] = [];
  const legacy = /(?:^|[\s"'`])detail-(?:stack|header|section(?:-compact|-label)?|row(?:-icon|-label)?|facts|fact-key)(?=[\s"'`]|$)/;
  for await (const file of new Bun.Glob("packages/**/src/**/*.tsx").scan(root)) {
    if (file.includes(".test.")) continue;
    const source = ts.createSourceFile(file, readFileSync(resolve(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(source) === "class" &&
        node.initializer &&
        legacy.test(node.initializer.getText(source))
      ) {
        violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
