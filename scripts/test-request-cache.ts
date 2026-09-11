import { resolve } from "node:path";

// Dedicated disposable services: never inherit the developer's DB/Valkey target.
const root = resolve(import.meta.dir, "..");
const prefix = `cloud-cache-test-${crypto.randomUUID()}`;
const owned: string[] = [];
const command = async (args: string[]) => {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${error.trim()}`);
  return out.trim();
};
const docker = (...args: string[]) => command(["docker", ...args]);
const run = async (args: string[], env: NodeJS.ProcessEnv) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Cache check failed: ${args.join(" ")}`);
};
try {
  for (const [kind, image, args] of [
    [
      "pg",
      "postgres:17-alpine",
      [
        "--env",
        "POSTGRES_PASSWORD=cache-test-only",
        "--env",
        "POSTGRES_DB=cloud_cache_test",
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql/data",
      ],
    ],
    ["redis", "valkey/valkey:8-alpine", ["--publish", "127.0.0.1::6379", "--tmpfs", "/data"]],
  ] as const) {
    const name = `${prefix}-${kind}`;
    owned.push(name);
    await docker("run", "--detach", "--name", name, ...args, image);
  }
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker("exec", `${prefix}-pg`, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "cloud_cache_test");
      if ((await docker("exec", `${prefix}-redis`, "valkey-cli", "PING")) !== "PONG") throw new Error("Valkey not ready");
      ready = true;
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
  if (!ready) throw new Error("Cache fixtures did not become ready");
  const pgPort = (await docker("port", `${prefix}-pg`, "5432/tcp")).split(":").at(-1);
  const redisPort = (await docker("port", `${prefix}-redis`, "6379/tcp")).split(":").at(-1);
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    DATABASE_URL: `postgres://postgres:cache-test-only@127.0.0.1:${pgPort}/cloud_cache_test`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    VALKEY_URL: `redis://127.0.0.1:${redisPort}`,
    APP_SECRET: "51".repeat(32),
    CLOUD_CACHE_TEST: "1",
  };
  await run(["scripts/cache-tests/setup.ts"], env);
  // Separate processes avoid mock/module-state leakage. Fixed global keys are
  // safe because both services are exclusively owned by this invocation.
  for (const path of [
    "packages/cloud/src/services/cache-fill.integration.test.ts",
    "packages/cloud/src/services/settings/store.integration.test.ts",
    "packages/cloud/src/services/announcements/cache.integration.test.ts",
    "packages/cloud/src/services/session/cache-policy.integration.test.ts",
    "packages/core/src/migrate/core/settings.cache.integration.test.ts",
  ])
    await run(["test", path], env);
  await run(["scripts/cache-tests/outage.ts"], env);
} finally {
  const cleanup = await Promise.allSettled(owned.reverse().map((name) => docker("rm", "--force", "--volumes", name)));
  for (const result of cleanup)
    if (result.status === "rejected") {
      console.error("Could not remove an owned cache-test container:", result.reason);
      process.exitCode = 1;
    }
}
