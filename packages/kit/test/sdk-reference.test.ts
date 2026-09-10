import { compileHelp } from "../../cloud/src/_internal/help";
import { expect, test } from "bun:test";
import ts from "typescript";
import { sdkReference } from "../src/sdk";
import { kitHelp } from "../src/help";
import { ChartOptions } from "../src/runtime/chart-schema";
import { compile } from "../src/runtime/compile";
import { money } from "@k2b/stdlib";

test("reference covers actual worker constructors, money exports and handle methods", async () => {
  const source = ts.createSourceFile(
    "worker.ts",
    await Bun.file(`${import.meta.dir}/../src/runtime/worker.ts`).text(),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  const walk = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "kit" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const visit = (object: ts.ObjectLiteralExpression, prefix = "") => {
        for (const p of object.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const name = prefix + p.name.getText(source);
          if (ts.isObjectLiteralExpression(p.initializer)) visit(p.initializer, name + ".");
          else names.push(name);
        }
      };
      visit(node.initializer);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  names.push(...Object.keys(money).map((key) => `money.${key}`));
  expect([...Object.keys(sdkReference.details)].sort()).toEqual([...names].sort());
  expect(sdkReference.methods.map(([name]) => name).sort()).toEqual(names.sort());
  const handle = source.statements.find((n) => ts.isTypeAliasDeclaration(n) && n.name.text === "Handle");
  if (!handle || !ts.isTypeAliasDeclaration(handle) || !ts.isTypeLiteralNode(handle.type)) throw Error("Handle contract missing");
  const methods = handle.type.members
    .filter(ts.isPropertySignature)
    .map((n) => n.name.getText(source))
    .filter((n) => n !== "id");
  expect(sdkReference.handleMethods.map(([sig]) => sig.split("(")[0]).sort()).toEqual(methods.sort());
});

test("every method example compiles as a real Kit entrypoint", async () => {
  for (const [name, detail] of Object.entries({
    ...sdkReference.details,
    ...sdkReference.tableMethods,
    ...Object.fromEntries(Object.entries(sdkReference.handleExamples).map(([name, example]) => [name, { returns: "void", example }])),
  })) {
    expect(detail.returns.length, name).toBeGreaterThan(0);
    expect(detail.example.length, name).toBeGreaterThan(0);
    const content = name === "script" ? detail.example : `export default kit.script({name:"Example",async run(){\n${detail.example}\n}});`;
    await compile({ name: "Example", files: [{ path: "main.script.js", content }] }, "main.script.js");
  }
}, 30000);

test("all chart variants have valid examples and documentation follows schemas", () => {
  expect(sdkReference.chartExamples.map((c) => c.kind).sort()).toEqual(ChartOptions.options.map((s) => s.shape.kind.value).sort());
  for (const example of sdkReference.chartExamples) expect(ChartOptions.safeParse(example).success, example.kind).toBe(true);
  for (const [name, schema] of Object.entries(sdkReference.schemas)) {
    const page = name.startsWith("Modal.")
      ? "modals"
      : name === "ChartOptions"
        ? "charts"
        : ["TableDefinition", "SchemaChanges", "RowQuery", "ImportOptions"].includes(name)
          ? "db"
          : "ui-types";
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if ("enum" in value && Array.isArray(value.enum))
        for (const item of value.enum)
          for (const locale of ["en", "de"]) expect(kitHelp.getMarkdown(`kit-sdk-${page}`, locale)).toContain(String(item));
      Object.values(value).forEach(visit);
    };
    visit(schema);
  }
});

test("localized corpus stays bounded and internal article references resolve", () => {
  const locales = kitHelp.documentsByLocale!;
  expect(locales.en!.map((d) => d.id).sort()).toEqual(locales.de!.map((d) => d.id).sort());
  const compiled = compileHelp({ appId: "kit", appName: "Kit", appIcon: "ti ti-code", basePath: "/app/kit", definition: kitHelp });
  expect(new TextEncoder().encode(JSON.stringify(compiled.registryEntry)).length).toBeLessThan(512 * 1024);
  for (const [locale, docs] of Object.entries(locales))
    for (const doc of docs) {
      for (const [, id, fragment] of doc.markdown.matchAll(/\/app\/kit\/help\/([a-z0-9-]+)(?:#([a-z0-9-]+))?/g)) {
        expect(kitHelp.getMarkdown(id!, locale).length).toBeGreaterThan(0);
        if (fragment) expect(docs.find((d) => d.id === id)?.html).toContain(`id="${fragment}"`);
      }
      expect(doc.markdown).not.toContain("undefined\n");
    }
});
