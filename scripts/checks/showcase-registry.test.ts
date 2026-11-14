import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { exampleRegistrySource } from "../../docs-site/src/ui/demo-sections/charts/examples/generate";
import { rule } from "./showcase-registry";

const folder = "docs-site/src/ui/demo-sections/charts/examples";

test("default-budget showcase geometry tests use the server-only loader", async () => {
  const source = await readFile(new URL("../../docs-site/src/ui/charts-showcase.browser.test.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("charts-showcase.browser.test.ts", source, ts.ScriptTarget.Latest, true);
  let guarded = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test" && node.arguments.length === 2) {
      const callback = node.arguments[1]!;
      const calls: string[] = [];
      const collect = (child: ts.Node): void => {
        if (ts.isCallExpression(child)) calls.push(child.expression.getText(ast));
        ts.forEachChild(child, collect);
      };
      collect(callback);
      expect(calls, node.arguments[0]!.getText(ast)).not.toContain("page.goto");
      expect(calls, node.arguments[0]!.getText(ast)).not.toContain("open");
      expect(calls, node.arguments[0]!.getText(ast)).toContain("openServerGeometry");
      guarded++;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(guarded).toBeGreaterThan(0);
});

/** A repository with the given example files and committed registry; returns the findings and the registry after. */
const check = async (files: string[], registry: string | undefined, fix = false) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-showcase-registry-"));
  try {
    const examples = join(root, folder);
    await mkdir(examples, { recursive: true });
    // Support files sit in the folder too and never reach the registry.
    for (const file of [...files, "index.ts", "files.ts", "generate.ts", "types.ts", "registry.test.ts"])
      await writeFile(join(examples, file), "export {};\n");
    if (registry !== undefined) await writeFile(join(examples, "registry.generated.ts"), registry);
    const findings = await rule.run({ workspaceRoot: root, fix, flags: new Set() });
    return {
      findings: findings.map((finding) => `${relative(root, finding.file ?? "")}: ${finding.message}`),
      registry: await readFile(join(examples, "registry.generated.ts"), "utf8").catch(() => undefined),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a registry generated from the example files passes", async () => {
  const files = ["area.ts", "bar.ts", "bar-basic.ts"];
  expect((await check(files, exampleRegistrySource(files))).findings).toEqual([]);
});

test("a registry that misses a new example file or lists a removed one names them and the generator", async () => {
  const { findings } = await check(["area.ts", "balance.ts", "bar.ts"], exampleRegistrySource(["bar.ts", "pie.ts"]));
  expect(findings).toEqual([
    `${folder}/registry.generated.ts: registry.generated.ts is not what its example files generate (misses area, balance; lists pie, which no example file provides). Run \`bun ${folder}/generate.ts\` and commit the result.`,
  ]);
});

test("a hand-edited or missing registry is reported, and --fix writes the generated one", async () => {
  const files = ["area.ts", "bar.ts"];
  const edited = exampleRegistrySource(files).replace("areaExamples,\n  barExamples", "barExamples,\n  areaExamples");
  expect((await check(files, edited)).findings).toHaveLength(1);
  expect((await check(files, undefined)).findings).toHaveLength(1);
  expect(await check(files, edited, true)).toEqual({ findings: [], registry: exampleRegistrySource(files) });
});
