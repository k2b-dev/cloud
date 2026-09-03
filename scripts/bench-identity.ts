import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchmarkConfiguration } from "../packages/core/bench/configuration";

// Disposable containers share an offline namespace. No development services,
// published ports or persistent volumes are used or changed.
const root = resolve(import.meta.dir, "..");
const configuration = benchmarkConfiguration(process.env);
const output = await mkdtemp(join(tmpdir(), "cloud-identity-perf-"));
const prefix = `cloud-identity-bench-${crypto.randomUUID()}`;
const database = `cloud_identity_bench_${crypto.randomUUID().replaceAll("-", "")}`;
const images = { postgres: "postgres:15-alpine", redis: "valkey/valkey:8-alpine", bun: "cloud-app-core:latest" };
const names = { postgres: `${prefix}-pg`, redis: `${prefix}-redis`, bun: `${prefix}-bun` };
const owned: string[] = [];
const docker = async (args: string[]) => {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Benchmark Docker command failed: ${stderr.trim()}`);
  return stdout.trim();
};
const imageIds: Record<string, string> = {};
for (const [kind, image] of Object.entries(images)) imageIds[kind] = await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
const sourceRevision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
await Bun.write(
  join(output, "environment.json"),
  JSON.stringify(
    {
      images,
      imageIds,
      sourceRevision,
      configuration,
      topology: "Offline Docker namespace; read-only working tree; PostgreSQL tmpfs; no shared dev services",
    },
    null,
    2,
  ),
);
try {
  owned.push(names.postgres);
  await docker([
    "run",
    "--detach",
    "--pull=never",
    "--name",
    names.postgres,
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--env",
    "POSTGRES_PASSWORD=benchmark-only",
    "--env",
    `POSTGRES_DB=${database}`,
    images.postgres,
  ]);
  owned.push(names.redis);
  await docker([
    "run",
    "--detach",
    "--pull=never",
    "--name",
    names.redis,
    "--network",
    `container:${names.postgres}`,
    images.redis,
    "valkey-server",
    "--bind",
    "127.0.0.1",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await docker([
        "exec",
        names.postgres,
        "pg_isready",
        "--quiet",
        "--host",
        "127.0.0.1",
        "--username",
        "postgres",
        "--dbname",
        database,
      ]);
      assert.equal(await docker(["exec", names.redis, "valkey-cli", "PING"]), "PONG");
      ready = true;
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
  assert(ready, "Isolated benchmark services did not become ready");
  owned.push(names.bun);
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--pull=never",
      "--name",
      names.bun,
      "--network",
      `container:${names.postgres}`,
      "--volume",
      `${root}:/workspace:ro`,
      "--volume",
      `${output}:/results:rw`,
      "--workdir",
      "/workspace/packages/core",
      "--env",
      `DATABASE_URL=postgres://postgres:benchmark-only@127.0.0.1:5432/${database}?sslmode=disable`,
      "--env",
      "REDIS_URL=redis://127.0.0.1:6379",
      "--env",
      "APP_ID=core",
      "--env",
      "NODE_ENV=development",
      "--env",
      `APP_SECRET=${"51".repeat(32)}`,
      "--env",
      `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY=${"43".repeat(32)}`,
      "--env",
      "CLOUD_IDENTITY_PREVIOUS_KEY=",
      "--env",
      "CLOUD_IDENTITY_NEXT_KEY=",
      "--env",
      "IDENTITY_BENCH_REPORT=/results/report.json",
      "--env",
      `IDENTITY_BENCH_SAMPLES=${configuration.samples}`,
      "--env",
      `IDENTITY_BENCH_MODE=${configuration.mode}`,
      "--entrypoint",
      "bun",
      images.bun,
      ...(configuration.mode === "profile"
        ? ["--cpu-prof", "--cpu-prof-md", "--cpu-prof-name=identity.cpuprofile", "--cpu-prof-dir=/results"]
        : []),
      "bench/identity-search.ts",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = await child.exited;
  console.log(`Benchmark artifacts: ${output}`);
} finally {
  // Exact generated names only; release the shared namespace last.
  for (const name of owned.reverse()) {
    try {
      await docker(["rm", "--force", name]);
    } catch (error) {
      console.error(`Could not remove owned benchmark container ${name}:`, error);
      process.exitCode = 1;
    }
  }
}
