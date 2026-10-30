import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Match the integration runner: BUN_OPTIONS reaches every nested Bun process.
test("a subprocess can select its final target after inheriting the infrastructure preload", async () => {
  const root = resolve(import.meta.dir, "../..");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CLOUD_TEST_")) delete env[key];
  const directory = await mkdtemp(resolve(tmpdir(), "cloud-preload-"));
  const entry = resolve(directory, "child.ts");
  await Bun.write(
    entry,
    `
    const { connections } = await import(${JSON.stringify(resolve(root, "packages/cloud/src/runtime/connections.ts"))});
    const { initializeTestPlatform } = await import(${JSON.stringify(resolve(root, "scripts/fixtures/platform.ts"))});
    if (connections().appId !== "integration-test") throw new Error("Preload did not initialize");
    process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:9/cloud_final_test";
    await initializeTestPlatform("grids");
    const snapshot = connections();
    if (snapshot.appId !== "grids" || !snapshot.database.url.endsWith("/cloud_final_test")) {
      throw new Error("Subprocess retained the preload target");
    }
    console.log("final target selected");
  `,
  );
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, entry], {
      cwd: root,
      env: {
        ...env,
        BUN_OPTIONS: `--no-env-file --preload=${resolve(import.meta.dir, "test-infra.ts")}`,
        CLOUD_TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:9/cloud_preload_test",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    timeout = setTimeout(() => child?.kill(), 4_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("final target selected");
  } finally {
    clearTimeout(timeout);
    if (child?.exitCode === null) child.kill();
    await child?.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
