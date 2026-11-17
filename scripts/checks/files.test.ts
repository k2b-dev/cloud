import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { checkSource } from "./cookie-store";
import { parseSource } from "./files";

// A generic arrow function reads as a JSX tag in TSX. In a `.ts` file the parse must go on past it.
const genericFirst = ["const first = <T>(items: T[]): T | undefined => items[0];", "const cookies = await context.cookies();"].join("\n");

test("a .ts file with a generic arrow parses to its end, and a rule still finds what follows", () => {
  const { sourceFile, findings } = parseSource("cookies.browser.test.ts", genericFirst);
  expect(findings).toEqual([]);
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(sourceFile));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  expect(calls).toEqual(["context.cookies"]);
  expect(checkSource("cookies.browser.test.ts", genericFirst).map(({ line }) => line)).toEqual([2]);
});

test("a .tsx file still reads JSX", () => {
  expect(parseSource("view.tsx", 'const view = <div class="a">{label}</div>;').findings).toEqual([]);
});

test("a file that does not parse is reported with its line instead of being skipped", () => {
  const [finding] = parseSource("broken.ts", "const fine = 1;\nconst broken = (;\n").findings;
  expect(finding?.file).toBe("broken.ts");
  expect(finding?.line).toBe(2);
  expect(finding?.message).toContain("Does not parse as TS");
  expect(finding?.message).toContain("the rule cannot check the rest of this file");
});

test("no rule parses with a fixed TSX grammar; rules parse through parseSource", () => {
  const fixed = readdirSync(import.meta.dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "files.ts")
    .filter((name) => /ScriptKind\.TSX\s*,?\s*\)/.test(readFileSync(join(import.meta.dir, name), "utf8")));
  expect(fixed).toEqual([]);
});
