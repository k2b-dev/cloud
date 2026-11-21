import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./no-barrel-dynamic-import";

const barrel = {
  "node_modules/fixture-ui/package.json": JSON.stringify({
    name: "fixture-ui",
    type: "module",
    sideEffects: false,
    exports: { ".": "./index.js", "./sheet": "./sheet.js" },
  }),
  "node_modules/fixture-ui/index.js": `// The root entry.\nexport * from "./sheet.js";\nexport { used } from "./used.js";\n`,
  "node_modules/fixture-ui/sheet.js": `export { Sheet } from "./Sheet-impl.js";\n`,
  "node_modules/fixture-ui/Sheet-impl.js": `export const Sheet = () => "sheet";\n`,
  "node_modules/fixture-ui/used.js": `export const used = () => "used";\n`,
  "packages/app/src/Static.tsx": `import { used } from "fixture-ui";\nimport { Sheet } from "fixture-ui/sheet";\nexport const value = used() + Sheet();\n`,
};

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-barrel-import-"));
  try {
    for (const [file, source] of Object.entries({ ...barrel, ...files })) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map(
      (finding) => `${relative(root, finding.file ?? "")}:${finding.line} ${finding.message.split(" loads")[0]}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports an on-demand import of a statically imported re-export entry with its line", async () => {
  expect(
    await findings({
      "packages/app/src/Lazy.ts": `export const load = async () => {\n  const { used } = await import("fixture-ui");\n  return used();\n};\n`,
    }),
  ).toEqual(['packages/app/src/Lazy.ts:2 import("fixture-ui")']);
});

test("accepts a narrow local module, a single-module entry, an entry nobody imports statically, and test support", async () => {
  expect(
    await findings({
      "packages/app/src/used-only.ts": `export { used } from "fixture-ui";\n`,
      "packages/app/src/Lazy.ts": `export const load = () => import("./used-only");\nexport const sheet = () => import("fixture-ui/sheet");\n`,
      "packages/other/src/Only.ts": `export const load = () => import("other-barrel");\n`,
      "packages/app/src/lazy.test-fixture.tsx": `export const load = () => import("fixture-ui");\n`,
      "packages/app/src/lazy.test.ts": `export const load = () => import("fixture-ui");\n`,
    }),
  ).toEqual([]);
});
