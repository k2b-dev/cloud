// These lifecycle tests must never migrate or mutate the shared development DB.
const name = `assistant-plan-test-${crypto.randomUUID()}`;
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(err);
  return out.trim();
}
let created = false;
try {
  await docker("run", "--detach", "--name", name, "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=cloud_working_plan_test", "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data", "postgres:17-alpine");
  created = true;
  for (let attempt = 0;; attempt++) {
    try { await docker("exec", name, "pg_isready", "-U", "postgres"); break; }
    catch (error) { if (attempt >= 40) throw error; await Bun.sleep(250); }
  }
  const port = (await docker("port", name, "5432/tcp")).split(":").at(-1);
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", new URL("../../cloud/src/ai/working-plan.integration.test.ts", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/cloud_working_plan_test`, APP_SECRET: "51".repeat(32) }, stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally { if (created) await docker("rm", "--force", "--volumes", name); }
