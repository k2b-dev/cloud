import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { behaviorTest, discoverTestSuites, listTestFiles } from "../../../scripts/run-tests";
import { mailIntegrationCommand } from "./test-integration";

const mailRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(mailRoot, "../..");

test("Mail integration selects every real infrastructure suite, including gated files without an integration suffix", async () => {
  const command = await mailIntegrationCommand();
  const selected = command.slice(9);
  const inventory = await listTestFiles(mailRoot);
  const gateImport = ["scripts", "fixtures", "test-infra"].join("/");
  const expected = inventory.filter(
    (file) => file.includes(".integration.test.") || readFileSync(resolve(mailRoot, file), "utf8").includes(gateImport),
  );
  expect(selected).toEqual(expected.map((file) => resolve(mailRoot, file)));
  expect(selected).toContain(resolve(mailRoot, "src/api/drafts-public-boundary.test.ts"));
  expect(selected).toContain(resolve(mailRoot, "src/api/focus.test.ts"));
  expect(selected).toContain(resolve(mailRoot, "src/service/performance.integration.test.ts"));
  expect(selected).toContain(resolve(mailRoot, "src/service/connectors/connector-conformance.integration.test.ts"));
  expect(selected).toContain(resolve(mailRoot, "test/workflow-kernel.integration.test.ts"));
  expect(selected).not.toContain(resolve(mailRoot, "src/frontend/mail-shell.browser.test.ts"));
  expect(selected).not.toContain(resolve(mailRoot, "src/contracts.test.ts"));
  expect(selected).not.toContain(import.meta.path);
  expect(selected.some((file) => file.includes(".browser.") || behaviorTest.test(file))).toBe(false);
});

test("Mail keeps one isolated integration process and both preloads in their original order", async () => {
  expect((await mailIntegrationCommand()).slice(0, 9)).toEqual([
    process.execPath,
    "--no-env-file",
    "test",
    "--timeout",
    "30000",
    "--preload",
    resolve(workspaceRoot, "scripts", "fixtures", "test-infra.ts"),
    "--preload",
    resolve(mailRoot, "test/integration-preload.ts"),
  ]);
  const suites = await discoverTestSuites(workspaceRoot, { integration: true, filter: "packages/mail" });
  expect(suites).toEqual([{ name: "@k2b/cloud-app-mail", cwd: mailRoot, command: ["bun", "run", "test:integration"] }]);
});

test("excluded Mail files retain normal CI coverage and the package entry point lists only concrete integration files", async () => {
  const packageJson = JSON.parse(readFileSync(resolve(mailRoot, "package.json"), "utf8"));
  expect(packageJson.scripts.test).toBe(
    "bun --cwd=../.. test --path-ignore-patterns '**/*.behavior.test.*' packages/mail/src packages/mail/scripts packages/mail/test",
  );
  const suites = await discoverTestSuites(workspaceRoot, { integration: false, filter: "packages/mail" });
  expect(suites.find((suite) => suite.name === "@k2b/cloud-app-mail")?.command).toEqual(["bun", "run", "test"]);
  const behavior = suites.find((suite) => suite.name === "@k2b/cloud-app-mail behavior");
  const selected = new Set((await mailIntegrationCommand()).slice(9));
  for (const file of await listTestFiles(mailRoot)) {
    if (selected.has(resolve(mailRoot, file))) continue;
    if (behaviorTest.test(file)) expect(behavior?.command).toContain(resolve(mailRoot, file));
    else expect(file).toMatch(/^(src|scripts|test)\//);
  }
  const listed = Bun.spawnSync([process.execPath, "--no-env-file", "run", "test:integration", "--list"], {
    cwd: mailRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ code: listed.exitCode, error: listed.exitCode === 0 ? "" : listed.stderr.toString() }).toEqual({ code: 0, error: "" });
  expect(listed.stdout.toString().trim().split("\n")).toEqual([...selected]);
});
