import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./test-error-causes";

// Built from parts, so the root test runner does not take this file for a browser test.
const launcher = ["..", "..", "..", "ui", "test", "browser"].join("/");

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-test-error-causes-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports a Playwright test that throws a new error in place of the one it caught", async () => {
  const head = `import { launchBrowser } from "${launcher}";\n`;
  expect(
    await findings({
      // #4121's shape: the `.catch` names no error, so Playwright's reason is gone.
      "packages/demo/hydrate.browser.test.ts": `${head}await page.waitForFunction(ready).catch(() => {\n  throw new Error("did not hydrate");\n});\n`,
      "packages/demo/bare.browser.test.ts": `${head}try { await load(); } catch {\n  throw new Error("no load");\n}\n`,
      "packages/demo/unused.browser.test.ts": `${head}try { await load(); } catch (error) {\n  throw new Error("no load");\n}\n`,
    }),
  ).toEqual(["packages/demo/bare.browser.test.ts:3", "packages/demo/hydrate.browser.test.ts:3", "packages/demo/unused.browser.test.ts:3"]);
});

test("accepts an error kept as cause, in the message, rethrown, or carried by a local; ignores tests without Playwright", async () => {
  const head = `import type { Page } from "playwright";\n`;
  expect(
    await findings({
      "packages/demo/cause.browser.test.ts": `${head}try { await load(); } catch (cause) {\n  throw new Error("no load", { cause });\n}\n`,
      "packages/demo/message.browser.test.ts": `${head}await wait().catch((error) => {\n  throw new Error(\`no load: \${String(error)}\`);\n});\n`,
      "packages/demo/rethrow.browser.test.ts": `${head}try { await load(); } catch (error) {\n  await close();\n  throw error;\n}\n`,
      "packages/demo/carrier.browser.test.ts": `${head}try { await load(); } catch (error) {\n  const report = new Error("no load", { cause: error });\n  throw report;\n}\n`,
      "packages/demo/silent.browser.test.ts": `${head}await close().catch(() => {});\n`,
      "packages/demo/unit.test.ts": `try { parse(); } catch {\n  throw new Error("redacted: no secret in the message");\n}\n`,
    }),
  ).toEqual([]);
});
