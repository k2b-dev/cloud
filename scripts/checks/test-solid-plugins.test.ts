import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkSource, rule } from "./test-solid-plugins";

test.each([
  'Bun.plugin(solidTestPlugin("ssr"));',
  'Bun["plugin"](solidTestPlugin("dom"));',
  "const register = Bun.plugin; register(plugin());",
  "const { plugin: register } = Bun; register(plugin());",
  'import { plugin as register } from "bun"; register(plugin());',
  'import "../../ui/test/solid-dom-preload";',
])("rejects process-wide compilation in a render test: %s", (source) => {
  expect(checkSource("packages/demo/src/page.render.test.tsx", source)).toHaveLength(1);
});

test("catches the #3626 pattern and the existing raw SSR preload", async () => {
  expect(
    checkSource(
      "packages/cloud/src/ssr/panel-slot.browser.test.ts",
      "const { plugin } = createConfig({ dev: true, rootDir: root });\nBun.plugin(plugin());",
    ).map(({ line }) => line),
  ).toEqual([2]);
  expect(
    checkSource(
      "packages/assistant/src/frontend/AssistantAuthoringStop.render.test.ts",
      'import { solidTestPlugin } from "../../../ui/test/solid-test-plugin";\nBun.plugin(solidTestPlugin("ssr"));',
    ).map(({ line }) => line),
  ).toEqual([2]);
  expect(
    checkSource(
      "packages/ui/test/solid-ssr-preload.ts",
      'import { solidTestPlugin } from "./solid-test-plugin";\nBun.plugin(solidTestPlugin("ssr"));',
    ),
  ).toHaveLength(1);
  const helper = await readFile(join(import.meta.dir, "../../packages/ui/test/ssr-test-plugin.ts"), "utf8");
  expect(checkSource("packages/ui/test/ssr-test-plugin.ts", helper)).toEqual([]);
});

test("allows the shared helper, runner preload and build-local server and browser compilers", () => {
  expect(checkSource("packages/ui/test/solid-dom-preload.ts", 'Bun.plugin(solidTestPlugin("dom"));')).toEqual([]);
  expect(
    checkSource(
      "packages/demo/src/page.browser.test.ts",
      `
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
registerSsrTestPlugin({ dev: true, rootDir: root });
await Bun.build({ plugins: [solidTestPlugin("dom")] });
await Bun.build({ plugins: [solidTestPlugin("ssr")] });
const child = "Bun.plugin(fixturePlugin())";
// Bun.plugin(fixturePlugin());
`,
    ),
  ).toEqual([]);
});

test("keeps the SSR helper out of the runner's DOM suites", () => {
  for (const file of ["packages/demo/src/page.behavior.test.tsx", "packages/ssr/test/browser/page.test.tsx"])
    for (const compiler of ["ssr-test-plugin", "solid-ssr-preload"])
      expect(checkSource(file, `import "../../../ui/test/${compiler}";`)).toHaveLength(1);
});

test("checks test helpers as well as test files, without interpreting child-process strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-test-solid-plugins-"));
  const files = {
    "packages/demo/src/page.render.test.tsx": "Bun.plugin(plugin());",
    "packages/demo/src/page.browser-harness.tsx": "Bun.plugin(plugin());",
    "packages/demo/src/page.shell-fixture.ts": "Bun.plugin(plugin());",
    "packages/demo/src/page.browser-server.ts": "Bun.plugin(plugin());",
    "packages/demo/test/preload.ts": "Bun.plugin(plugin());",
    "packages/demo/src/child.test.ts": 'const script = "Bun.plugin(plugin())";',
    "packages/demo/src/start.ts": "Bun.plugin(plugin());",
    "packages/ui/test/solid-dom-preload.ts": 'Bun.plugin(solidTestPlugin("dom"));',
  };
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
  expect(findings.map(({ file }) => file?.slice(root.length + 1)).sort()).toEqual([
    "packages/demo/src/page.browser-harness.tsx",
    "packages/demo/src/page.browser-server.ts",
    "packages/demo/src/page.render.test.tsx",
    "packages/demo/src/page.shell-fixture.ts",
    "packages/demo/test/preload.ts",
  ]);
});
