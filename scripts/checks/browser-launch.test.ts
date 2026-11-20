import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./browser-launch";

// Built from parts, so the root test runner takes this file for neither a browser nor an integration test.
const launcher = ["..", "..", "..", "ui", "test", "browser"].join("/");
const testInfra = ["..", "..", "..", "scripts", "fixtures", "test-infra"].join("/");

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-browser-launch-"));
  try {
    const sources: Record<string, string> = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/assistant", "packages/demo"] } }),
      "packages/assistant/package.json": JSON.stringify({ name: "assistant" }),
      "packages/demo/package.json": JSON.stringify({ name: "demo" }),
      ...files,
    };
    for (const [path, source] of Object.entries(sources)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "tests"));
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line ?? "-"}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("accepts tests that start their browser through the shared launcher", async () => {
  expect(
    await findings({
      "packages/demo/src/shared.browser.test.ts": `import { launchBrowser } from "${launcher}";\nconst browser = await launchBrowser();\n`,
      "packages/demo/src/flow.behavior.test.ts": `import type { Page } from "playwright";\nimport { launchBrowser } from "${launcher}";\n`,
      // Integration tests need CLOUD_TEST_* targets and stay in Chromium.
      "packages/demo/src/consent.integration.test.ts": `import "${testInfra}";\nimport { launchBrowser } from "${launcher}";\n`,
      "packages/assistant/src/chat-code/shared.browser.test.ts": `import { launchBrowser } from "${launcher}";\nawait launchBrowser();\n`,
    }),
  ).toEqual([]);
});

test("reports direct launches and Playwright tests that the WebKit run would not find", async () => {
  expect(
    await findings({
      "packages/assistant/src/chat-code/direct.browser.test.ts": `import { chromium } from "playwright";\nawait chromium.launch({ channel: "chrome" });\n`,
      "packages/demo/src/direct.browser.test.ts": `import { chromium } from "playwright";\nconst context = await chromium.launchPersistentContext("/tmp/profile");\n`,
      "packages/demo/src/cdp.browser-suite.ts": `import { webkit } from "playwright";\n\nawait webkit.connectOverCDP("ws://127.0.0.1:9222");\n`,
      "packages/demo/src/extension.browser.test.ts": `import { launchBrowser } from "${launcher}.ts";\n`,
      "packages/demo/src/helper.browser.test.ts": `import type { Page } from "playwright";\nimport { openPage } from "./open-page";\n`,
    }),
  ).toEqual([
    "packages/assistant/src/chat-code/direct.browser.test.ts:2",
    "packages/assistant/src/chat-code/direct.browser.test.ts:-",
    "packages/demo/src/cdp.browser-suite.ts:3",
    "packages/demo/src/direct.browser.test.ts:2",
    "packages/demo/src/direct.browser.test.ts:-",
    "packages/demo/src/extension.browser.test.ts:-",
    "packages/demo/src/helper.browser.test.ts:-",
  ]);
});

test("a hook that launches a browser keeps at least the launch hook budget (#3874)", async () => {
  const hook = (body: string, timeout = "") =>
    `import { beforeAll } from "bun:test";\nimport { launchBrowser, launchHookMs } from "${launcher}";\nlet browser;\nbeforeAll(async () => {\n  ${body}\n}${timeout});\n`;
  expect(
    await findings({
      "packages/demo/src/top-level.browser.test.ts": `import { launchBrowser } from "${launcher}";\nconst browser = await launchBrowser();\n`,
      "packages/demo/src/literal.browser.test.ts": hook("browser = await launchBrowser();", ", 30_000"),
      "packages/demo/src/longer.browser.test.ts": hook("browser = await launchBrowser();", ", 120000"),
      "packages/demo/src/named.browser.test.ts": hook("browser = await launchBrowser();", ", launchHookMs"),
      // A test that launches its own browser is outside this hook rule.
      "packages/demo/src/in-test.browser.test.ts": `import { test } from "bun:test";\nimport { launchBrowser } from "${launcher}";\ntest("x", async () => {\n  await launchBrowser();\n});\n`,
      // Bun's 5 s default is the close budget (#1473); the stalled launch in #3862 failed inside it.
      "packages/demo/src/default.browser.test.ts": hook("browser = await launchBrowser();"),
      "packages/demo/src/short.browser.test.ts": hook("browser = await Promise.all([launchBrowser()]);", ", 20_000"),
      "packages/demo/src/unknown.browser.test.ts": hook("browser = await launchBrowser();", ", budget"),
    }),
  ).toEqual([
    "packages/demo/src/default.browser.test.ts:5",
    "packages/demo/src/short.browser.test.ts:5",
    "packages/demo/src/unknown.browser.test.ts:5",
  ]);
});

test("the launch hook budget reaches every hook, nested callbacks, function expressions, TSX, and browser suites (#3874)", async () => {
  const inHook = (hook: string, body: string, timeout = "", fn = "async () =>") =>
    `import { ${hook} } from "bun:test";\nimport { launchBrowser } from "${launcher}";\nlet browser;\n${hook}(${fn} {\n  ${body}\n}${timeout});\n`;
  const launch = "browser = await launchBrowser();";
  const nested = "browser = await Promise.all([1, 2].map(() => launchBrowser()));";
  const inDescribe = (timeout: string) =>
    `import { beforeAll, describe } from "bun:test";\nimport { launchBrowser } from "${launcher}";\ndescribe("view", () => {\n  beforeAll(async () => {\n    await launchBrowser();\n  }${timeout});\n});\n`;
  expect(
    await findings({
      "packages/demo/src/describe-ok.browser.test.ts": inDescribe(", 30_000"),
      "packages/demo/src/nested-ok.browser.test.ts": inHook("beforeAll", nested, ", 30_000"),
      "packages/demo/src/each-ok.browser.test.ts": inHook("beforeEach", launch, ", launchHookMs"),
      "packages/demo/src/suite-ok.browser-suite.ts": inHook("beforeAll", launch, ", 60_000"),
      // A helper that a hook calls is outside the rule: it checks what is lexically inside the hook.
      "packages/demo/src/helper-ok.browser.test.ts": `import { beforeAll } from "bun:test";\nimport { launchBrowser } from "${launcher}";\nconst open = () => launchBrowser();\nbeforeAll(open);\n`,
      "packages/demo/src/describe.browser.test.ts": inDescribe(""),
      "packages/demo/src/each.browser.test.ts": inHook("beforeEach", launch),
      "packages/demo/src/after-all.browser.test.ts": inHook("afterAll", launch, ", 5_000"),
      "packages/demo/src/after-each.browser.test.ts": inHook("afterEach", launch),
      "packages/demo/src/nested.browser.test.ts": inHook("beforeAll", nested),
      "packages/demo/src/function.browser.test.ts": inHook("beforeAll", launch, "", "async function ()"),
      "packages/demo/src/view.browser.test.tsx": `import { beforeAll } from "bun:test";\nimport { launchBrowser } from "${launcher}";\nconst view = () => <p>ready</p>;\nbeforeAll(async () => {\n  await launchBrowser();\n});\n`,
      "packages/demo/src/flow.browser-suite.ts": inHook("beforeAll", launch),
    }),
  ).toEqual([
    "packages/demo/src/after-all.browser.test.ts:5",
    "packages/demo/src/after-each.browser.test.ts:5",
    "packages/demo/src/describe.browser.test.ts:5",
    "packages/demo/src/each.browser.test.ts:5",
    "packages/demo/src/flow.browser-suite.ts:5",
    "packages/demo/src/function.browser.test.ts:5",
    "packages/demo/src/nested.browser.test.ts:5",
    "packages/demo/src/view.browser.test.tsx:5",
  ]);
});
