import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the infrastructure gate does not load platform clients without configured test targets", async () => {
  const root = resolve(import.meta.dir, "../..");
  const env = { ...process.env, BUN_OPTIONS: "--no-env-file" };
  for (const key of Object.keys(env)) if (key.startsWith("CLOUD_TEST_")) Reflect.deleteProperty(env, key);
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    await import("./scripts/fixtures/test-infra.ts");
    console.log(JSON.stringify(Object.keys(require.cache).filter(path => path.includes("/packages/cloud/src/runtime/"))));
  `,
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => child.kill(), 4_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
