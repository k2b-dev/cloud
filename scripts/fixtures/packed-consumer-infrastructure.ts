/** Disposable Docker containers only; no shared compose project, ports or volumes. */
export const checkPackedRuntime = async (root: string, consumer: string, cleanEnv: NodeJS.ProcessEnv): Promise<void> => {
  const prefix = `cloud-consumer-${crypto.randomUUID()}`;
  const names = [`${prefix}-postgres`, `${prefix}-valkey`, `${prefix}-nats`] as const;
  const command = async (cmd: string[], env = process.env, cwd = root): Promise<string> => {
    const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`Fixture command ${cmd[0]} ${cmd[1]} failed (${code}): ${stdout}\n${stderr}`);
      return stdout.trim();
    } finally {
      clearTimeout(timer);
    }
  };
  const docker = (...args: string[]) => command(["docker", ...args]);
  const address = async (name: string, port: number) => docker("port", name, `${port}/tcp`);
  try {
    console.log("Start disposable Postgres, Valkey and NATS containers");
    await docker(
      "run",
      "-d",
      "--rm",
      "--name",
      names[0],
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_PASSWORD=consumer",
      "-e",
      "POSTGRES_DB=consumer",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "postgres:15-alpine",
    );
    await docker("run", "-d", "--rm", "--name", names[1], "-p", "127.0.0.1::6379", "valkey/valkey:8-alpine");
    await docker("run", "-d", "--rm", "--name", names[2], "-p", "127.0.0.1::4222", "nats:2.14.3-alpine", "-js", "-sd", "/data");
    const env = {
      ...cleanEnv,
      DATABASE_URL: `postgres://postgres:consumer@${await address(names[0], 5432)}/consumer`,
      REDIS_URL: `redis://${await address(names[1], 6379)}`,
      NATS_SERVERS: `nats://${await address(names[2], 4222)}`,
      SYNC_NAMESPACE: prefix,
      SYNC_REPLICAS: "1",
      NATS_CREDS_FILE: "",
      APP_SECRET: crypto.randomUUID(),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        await docker("exec", names[0], "pg_isready", "-U", "postgres", "-d", "consumer");
        await docker("exec", names[1], "valkey-cli", "ping");
        break;
      } catch (error) {
        if (attempt === 59) throw error;
        await Bun.sleep(500);
      }
    }
    // Initialize the platform with its real setup, not hand-written fixture tables.
    // Only this operator setup uses checkout source; the consumer stays package-only.
    console.log("Initialize isolated platform database using Core setup");
    await command(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        'import {runCoreSetup} from "./packages/core/src/runtime-helpers"; await runCoreSetup(); process.exit(0)',
      ],
      env,
    );
    console.log("Verify packed production app registration, HTTP and graceful shutdown");
    await command([process.execPath, "--no-env-file", "src/runtime-check.ts"], env, consumer);
  } finally {
    const results = await Promise.allSettled(names.map((name) => docker("rm", "-f", "-v", name)));
    for (const result of results) {
      if (result.status === "rejected" && !String(result.reason).includes("No such container")) throw result.reason;
    }
  }
};
