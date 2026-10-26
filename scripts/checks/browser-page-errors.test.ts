import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./browser-page-errors";

// Built from parts so the test runner does not discover this rule test as a browser suite.
const launcher = ["..", "..", "ui", "test", "browser"].join("/");
const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-browser-page-errors-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map((finding) => ({
      ...finding,
      file: relative(root, finding.file ?? ""),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("rejects raw page-error collectors across packages and shared browser suites", async () => {
  const found = await findings({
    "packages/assistant/flow.browser.test.ts":
      'import type { Page } from "playwright";\npage.on("pageerror", error => errors.push(error.message));',
    "packages/cloud/flow.browser-suite.ts": `import { launchBrowser } from "${launcher}";\npage\n .once(\n "pageerror", onError);`,
    "packages/demo/flow.browser.test.ts": 'import { fixture } from "./fixture";\nfixture.page.on("pageerror", onError);',
    "packages/ui/flow.spec.tsx": `import { launchBrowser } from "${launcher}.ts";\npage?.["addListener"]?.(\`pageerror\`, onError);\npage.prependListener('pageerror', onError);\npage.prependOnceListener('pageerror', onError);`,
  });
  expect(found.map(({ file, line }) => `${file}:${line}`)).toEqual([
    "packages/assistant/flow.browser.test.ts:2",
    "packages/cloud/flow.browser-suite.ts:2",
    "packages/demo/flow.browser.test.ts:2",
    "packages/ui/flow.spec.tsx:2",
    "packages/ui/flow.spec.tsx:3",
    "packages/ui/flow.spec.tsx:4",
  ]);
});

test("rejects context error collectors and raw listeners inside browser fixtures and harnesses", async () => {
  const found = await findings({
    "packages/demo/flow.browser-suite.tsx": 'context.on("weberror", error => errors.push(error.error().message));',
    "packages/demo/flow.browser-fixture.ts": 'page.on("pageerror", onError);',
    "packages/demo/flow-browser-harness.tsx": 'page.on("pageerror", onError);',
    "packages/demo/browser-harness.ts": 'page.once("pageerror", onError);',
    "packages/ui/test/app-host-fixture.ts": 'context.on("weberror", onError);',
    "packages/ui/test/workspace-host-fixture.ts": 'page.on("pageerror", onError);',
  });
  expect(found.map(({ file }) => file)).toEqual([
    "packages/demo/browser-harness.ts",
    "packages/demo/flow-browser-harness.tsx",
    "packages/demo/flow.browser-fixture.ts",
    "packages/demo/flow.browser-suite.tsx",
    "packages/ui/test/app-host-fixture.ts",
    "packages/ui/test/workspace-host-fixture.ts",
  ]);
});

test("allows the shared collector, console probes and awaited error events without mistaking prose for code", async () => {
  const source = `import { pageErrors } from "${launcher}";
const errors = pageErrors(page);
page.on("console", message => errors.push(message.text()));
await page.waitForEvent("pageerror");
// page.on("pageerror", onError);
const example = 'page.on("pageerror", onError)';`;
  expect(await findings({ "flow.browser.test.ts": source })).toEqual([]);
});

test("does not scan non-browser tests, non-test sources or generated code", async () => {
  const source = 'import type { Page } from "playwright"; page.on("pageerror", onError);';
  expect(
    await findings({
      "unit.test.ts": 'emitter.on("pageerror", onError);',
      "src/browser.ts": source,
      ...Object.fromEntries(["node_modules", "dist", "build", "_ssr", ".local"].map((dir) => [`${dir}/flow.test.ts`, source])),
    }),
  ).toEqual([]);
});

test("allows only the existing diagnostic probes once, not arbitrary listeners in those files", async () => {
  const probe = 'page.on("pageerror", (error) => reported.push(`${error.name}:/${error.message}`));';
  const waitingProbe =
    'page.on("pageerror", (error) => { if (error.message.endsWith(" due to access control checks.")) refused.push(error.message); });';
  const found = await findings({
    "packages/ui/test/browser.browser.test.ts": `import type { Page } from "playwright";\n${probe}\npage.on("pageerror", onError);\n${probe}`,
    "packages/assistant/src/frontend/AssistantWaitingStrip.browser.test.ts": `import { launchBrowser } from "${launcher}";\n${waitingProbe}\npage.on("pageerror", onError);`,
    "packages/demo/flow.test.ts": `import type { Page } from "playwright";\n${probe}`,
  });
  expect(found.map(({ file, line }) => `${file}:${line}`)).toEqual([
    "packages/assistant/src/frontend/AssistantWaitingStrip.browser.test.ts:3",
    "packages/demo/flow.test.ts:2",
    "packages/ui/test/browser.browser.test.ts:3",
    "packages/ui/test/browser.browser.test.ts:4",
  ]);
});
