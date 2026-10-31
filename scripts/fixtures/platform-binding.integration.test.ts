import { expect } from "bun:test";
import { resolve } from "node:path";
import { testFor } from "./test-infra";

testFor("database")("a mismatched platform handle is rejected even when the Bun handle is still unbound", async () => {
  const root = resolve(import.meta.dir, "../..");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
      import { SQL } from "bun";
      const { mock } = await import("bun:test");
      mock.module("./scripts/fixtures/platform.ts", () => ({ initializeTestPlatform: async () => {} }));
      mock.module("./packages/cloud/src/runtime/clients.ts", () => ({ sql: async () => [{ name: "wrong_platform_test" }] }));
      const { useFreshDatabase } = await import("./scripts/fixtures/test-infra.ts");
      try {
        await useFreshDatabase("platform_binding");
        throw new Error("Accepted the wrong platform database");
      } catch (error) {
        if (!String(error).includes('the platform sql handle is already bound to "wrong_platform_test"')) throw error;
        const admin = new SQL(process.env.CLOUD_TEST_DATABASE_URL);
        try {
          const name = new URL(process.env.DATABASE_URL).pathname.slice(1);
          const remaining = await admin.unsafe("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
          if (remaining.length) throw new Error("Mismatched database was not dropped");
        } finally {
          await admin.close();
        }
        console.log("wrong platform target rejected and dropped");
      }
    `,
    ],
    { cwd: root, env: { ...process.env, BUN_OPTIONS: "--no-env-file" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("wrong platform target rejected and dropped");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
