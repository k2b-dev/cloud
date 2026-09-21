// Disposable Postgres and rsql: never connect these tests to the development database.
import { testRuntimeEnv } from "../../../scripts/fixtures/test-infra-env";

if (Bun.argv.includes("--help")) {
  console.log(`Usage: bun packages/assistant/scripts/test-artifacts.ts

Runs the artifact integration tests on disposable Postgres and rsql Docker containers.
eval-code-mode.ts sets ASSISTANT_EVAL_* for the model evaluation; the variables are forwarded to the test process.
`);
  process.exit(0);
}
const name = `assistant-artifact-test-${crypto.randomUUID()}`;
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status) throw new Error(error);
  return output.trim();
}
let created = false,
  rsqlCreated = false;
try {
  await docker(
    "run",
    "--detach",
    "--name",
    name,
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    "POSTGRES_DB=cloud_assistant_artifacts_test",
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "postgres:17-alpine",
  );
  created = true;
  for (let attempt = 0; ; attempt++) {
    try {
      await docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      await Bun.sleep(250);
    }
  }
  const port = (await docker("port", name, "5432/tcp")).split(":").at(-1);
  const rsqlName = name + "-rsql";
  await docker(
    "run",
    "--detach",
    "--name",
    rsqlName,
    "--env",
    "RSQL_API_TOKEN=artifact-test-only",
    "--publish",
    "127.0.0.1::8080",
    "--tmpfs",
    "/data:uid=1000,gid=1000,mode=0700",
    "--entrypoint",
    "/usr/local/bin/rsql",
    "ghcr.io/k2b-dev/rsql:1.0.0",
    "serve",
    "--listen=0.0.0.0:8080",
    "--data-dir=/data",
  );
  rsqlCreated = true;
  const rsqlPort = (await docker("port", rsqlName, "8080/tcp")).split(":").at(-1);
  const rsqlUrl = `http://127.0.0.1:${rsqlPort}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(rsqlUrl + "/healthz");
      if (!response.ok) throw new Error("rsql unhealthy");
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      await Bun.sleep(250);
    }
  }
  const testTargets = {
    CLOUD_TEST_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/cloud_assistant_artifacts_test`,
    CLOUD_TEST_RSQL_URL: rsqlUrl,
    CLOUD_TEST_VALKEY_URL: process.env.CLOUD_TEST_VALKEY_URL,
  };
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test",
      "--preload",
      new URL("../../../scripts/fixtures/test-infra.ts", import.meta.url).pathname,
      "--timeout",
      "20000",
      new URL("../src/artifacts/service.integration.test.ts", import.meta.url).pathname,
    ],
    {
      env: {
        PATH: process.env.PATH,
        ASSISTANT_EVAL_FILES: process.env.ASSISTANT_EVAL_FILES,
        ASSISTANT_EVAL_URL: process.env.ASSISTANT_EVAL_URL,
        ASSISTANT_EVAL_TOKEN: process.env.ASSISTANT_EVAL_TOKEN,
        ASSISTANT_EVAL_MODEL: process.env.ASSISTANT_EVAL_MODEL,
        NODE_ENV: "test",
        CLOUD_CORE_INTERNAL_ORIGIN: "http://127.0.0.1:1",
        ...testTargets,
        // Bun binds its default `redis` handle to REDIS_URL before the preload runs (#39).
        ...testRuntimeEnv(testTargets),
        APP_SECRET: "51".repeat(32),
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await child.exited;
} catch (error) {
  if (rsqlCreated) console.error(await docker("logs", name + "-rsql"));
  throw error;
} finally {
  if (rsqlCreated) await docker("rm", "--force", "--volumes", name + "-rsql");
  if (created) await docker("rm", "--force", "--volumes", name);
}
