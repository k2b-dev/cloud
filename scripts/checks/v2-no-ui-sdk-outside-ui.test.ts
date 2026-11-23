import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule, uiSdkDependencies, uiSdkImports, uiSdkStylesheetImports } from "./v2-no-ui-sdk-outside-ui";

test("finds every way a source can name @ui-sdk/*", () => {
  const source = [
    'import { createMenu } from "@ui-sdk/core";',
    'export { attrs } from "@ui-sdk/core/renderer";',
    'const lazy = await import("@ui-sdk/core");',
    'const old = require("@ui-sdk/core");',
    'type Api = import("@ui-sdk/core").Api;',
    'const path = require.resolve("@ui-sdk/core");',
    'const url = import.meta.resolve("@ui-sdk/core/renderer");',
    'mock.module("@ui-sdk/core", () => ({}));',
    'vi.mock("@ui-sdk/core");',
    'import { Menu } from "@k2b/ui/v2";',
    'const text = "@ui-sdk/core is only a string here";',
    'other.module("@ui-sdk/core");',
  ].join("\n");
  expect(uiSdkImports("app.ts", source)).toEqual([
    { line: 1, specifier: "@ui-sdk/core" },
    { line: 2, specifier: "@ui-sdk/core/renderer" },
    { line: 3, specifier: "@ui-sdk/core" },
    { line: 4, specifier: "@ui-sdk/core" },
    { line: 5, specifier: "@ui-sdk/core" },
    { line: 6, specifier: "@ui-sdk/core" },
    { line: 7, specifier: "@ui-sdk/core/renderer" },
    { line: 8, specifier: "@ui-sdk/core" },
    { line: 9, specifier: "@ui-sdk/core" },
  ]);
});

test("finds @ui-sdk/* in a stylesheet, not in a comment", () => {
  const css = [
    '@import "@ui-sdk/core/styles.css";',
    "/* @import '@ui-sdk/core/old.css'; */",
    "@import url(@ui-sdk/core/theme.css);",
    '.x { background: url("@ui-sdk/core/grip.svg"); }',
    '@import "@k2b/ui/v2.css";',
  ].join("\n");
  expect(uiSdkStylesheetImports(css)).toEqual([
    { line: 1, specifier: "@ui-sdk/core/styles.css" },
    { line: 3, specifier: "@ui-sdk/core/theme.css" },
    { line: 4, specifier: "@ui-sdk/core/grip.svg" },
  ]);
});

test("finds ui-sdk in any dependency field of a manifest", () => {
  const manifest = JSON.stringify({
    dependencies: { "@ui-sdk/core": "0.1.0-beta.14", "solid-js": "1.9.18" },
    devDependencies: { "@ui-sdk/solid": "1.0.0" },
  });
  expect(uiSdkDependencies(manifest)).toEqual(["@ui-sdk/core", "@ui-sdk/solid"]);
});

test("red: an app and its manifest that reach ui-sdk; green: packages/ui itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-no-ui-sdk-"));
  try {
    await mkdir(join(root, "packages/mail/src"), { recursive: true });
    await mkdir(join(root, "packages/ui/src/v2/behavior"), { recursive: true });
    await writeFile(
      join(root, "packages/mail/src/List.tsx"),
      'import { createReorder } from "@ui-sdk/core";\nexport const List = () => null;\n',
    );
    await writeFile(join(root, "packages/mail/package.json"), JSON.stringify({ dependencies: { "@ui-sdk/core": "0.1.0-beta.14" } }));
    await writeFile(join(root, "packages/ui/src/v2/behavior/adapter.ts"), 'import { attrs } from "@ui-sdk/core/renderer";\n');
    await writeFile(join(root, "packages/ui/package.json"), JSON.stringify({ dependencies: { "@ui-sdk/core": "0.1.0-beta.14" } }));
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings).toEqual([
      {
        file: "packages/mail/src/List.tsx",
        line: 1,
        message: "imports @ui-sdk/core; use the matching @k2b/ui/v2 primitive; only packages/ui imports ui-sdk",
      },
      {
        file: "packages/mail/package.json",
        message: "depends on @ui-sdk/core; use the matching @k2b/ui/v2 primitive; only packages/ui imports ui-sdk",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("green: a tree whose apps use only @k2b/ui/v2", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-no-ui-sdk-"));
  try {
    await mkdir(join(root, "packages/mail/src"), { recursive: true });
    await writeFile(join(root, "packages/mail/src/List.tsx"), 'import { Menu } from "@k2b/ui/v2";\nexport const List = () => Menu;\n');
    expect(await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
