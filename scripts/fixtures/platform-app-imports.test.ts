import { expect, onTestFinished, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Import-time pools/fragments retain the pre-start placeholder or a closed test target.
// Exercise the module graph without initializing clients or opening infrastructure.
test("application data declarations load before platform startup", async () => {
  const root = resolve(import.meta.dir, "../..");
  const apps = [
    "accounts",
    "assistant",
    "chat",
    "contacts",
    "core",
    "dashboard",
    "faq",
    "filesv2",
    "gateway",
    "gateway-ops",
    "ipa-hosts",
    "notebooks",
    "oauth",
    "proxy-auth",
    "pulse",
    "quotes",
    "spaces",
    "tools",
    "venue",
    "weather",
  ];
  const modules = apps
    .flatMap((app) => ["config.ts", "migrate.ts", "service/index.ts"].map((entry) => `packages/${app}/src/${entry}`))
    .filter((path) => existsSync(resolve(root, path)));
  modules.push(
    "packages/assistant/src/artifacts/database.ts",
    "packages/gateway-ops/src/observability/telemetry/service.ts",
    "packages/notebooks/src/service/tree-levels.ts",
    "packages/spaces/src/service/item-templates.ts",
    "packages/spaces/src/service/items.ts",
    "packages/filesv2/src/service/templates.ts",
  );
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", `for (const path of ${JSON.stringify(modules)}) await import('./'+path);`],
    {
      cwd: root,
      env: { ...process.env, BUN_OPTIONS: "--no-env-file" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  onTestFinished(async () => {
    if (child.exitCode === null) child.kill();
    await child.exited;
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
