import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { behaviorTest, discoverTestSuites, listTestFiles } from "../../../scripts/run-tests";
import { mailIntegrationCommand } from "./test-integration";

const mailRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(mailRoot, "../..");

test("Mail integration selects every real infrastructure suite, including gated files without an integration suffix", async () => {
  const command = await mailIntegrationCommand();
  const selected = command.slice(10);
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
  expect(selected).not.toContain(resolve(mailRoot, "src/frontend/mail-shell-head.browser.test.ts"));
  expect(selected).not.toContain(resolve(mailRoot, "src/contracts.test.ts"));
  expect(selected).not.toContain(import.meta.path);
  expect(selected.some((file) => file.includes(".browser.") || behaviorTest.test(file))).toBe(false);
});

test("Mail isolates each file and keeps both preloads in their original order", async () => {
  expect((await mailIntegrationCommand()).slice(0, 10)).toEqual([
    process.execPath,
    "--no-env-file",
    "test",
    "--isolate",
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
  const selected = new Set((await mailIntegrationCommand()).slice(10));
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

// Exercise Bun's preload lifecycle without infrastructure: the Mail preload must
// acquire and release a different database/runtime for every selected file.
test("Mail's command runs preload setup and teardown separately for each file", async () => {
  const root = await mkdtemp(join(tmpdir(), "mail-file-isolation-"));
  const log = join(root, "lifecycle.log");
  const preload = join(root, "preload.ts");
  try {
    await writeFile(
      preload,
      `import { afterAll } from "bun:test";
import { appendFileSync } from "node:fs";
export const token = crypto.randomUUID();
appendFileSync(${JSON.stringify(log)}, "prepare:" + token + "\\n");
afterAll(() => appendFileSync(${JSON.stringify(log)}, "drop:" + token + "\\n"));`,
    );
    const files = ["first.test.ts", "second.test.ts"].map((file) => join(root, file));
    for (const file of files) {
      await writeFile(
        file,
        `import { expect, test } from "bun:test";
import { token } from "./preload";
test("has a file fixture", () => expect(token.length).toBe(36));`,
      );
    }
    const command = (await mailIntegrationCommand()).slice(0, 10);
    const child = Bun.spawn([...command, "--preload", preload, ...files], {
      cwd: root,
      env: { PATH: process.env.PATH, BUN_OPTIONS: "--no-env-file" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error: code === 0 ? "" : out + error }).toEqual({ code: 0, error: "" });
    const entries = readFileSync(log, "utf8").trim().split("\n");
    expect(entries).toHaveLength(4);
    expect(entries[0]).toStartWith("prepare:");
    expect(entries[1]).toBe(entries[0]!.replace("prepare:", "drop:"));
    expect(entries[2]).toStartWith("prepare:");
    expect(entries[2]).not.toBe(entries[0]);
    expect(entries[3]).toBe(entries[2]!.replace("prepare:", "drop:"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
