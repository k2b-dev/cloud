import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cloud = resolve(import.meta.dir, "..");
const childOutput = async (child: ReturnType<typeof Bun.spawn>) => {
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      typeof child.stdout === "number" || !child.stdout ? "" : new Response(child.stdout).text(),
      typeof child.stderr === "number" || !child.stderr ? "" : new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`Fixture command failed (${status}): ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
};

export const platformStartFixture = async ({
  appId = "inventory",
  lifecycle = false,
  database,
  valkey,
  nats,
  creds,
  namespace,
  bootstrap,
}: {
  appId?: string;
  lifecycle?: boolean;
  database?: string;
  valkey?: string;
  nats?: string;
  creds?: string;
  namespace?: string;
  /** Custom-server seam; full app.start key-only operation waits for the import migration. */
  bootstrap?: { key: string; origin: string; now: number };
} = {}): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "cloud-platform-start-"));
  let runtime: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const archive = join(root, "cloud.tgz");
    await childOutput(Bun.spawn([process.execPath, "pm", "pack", "--filename", archive], { cwd: cloud, stdout: "pipe", stderr: "pipe" }));
    const appDir = join(root, "consumer");
    const packageDir = join(appDir, "node_modules", "@k2b", "cloud");
    await mkdir(packageDir, { recursive: true });
    await childOutput(Bun.spawn(["tar", "-xzf", archive, "--strip-components=1", "-C", packageDir], { stdout: "pipe", stderr: "pipe" }));
    // Consume the packed public files with the pinned workspace dependency closure.
    await symlink(join(cloud, "node_modules"), join(packageDir, "node_modules"), "dir");
    // The JSX transform resolves its runtime from the consuming application.
    await symlink(join(cloud, "node_modules", "solid-js"), join(appDir, "node_modules", "solid-js"), "dir");
    await mkdir(join(appDir, "src"));
    await writeFile(join(appDir, "package.json"), JSON.stringify({ type: "module", dependencies: { "@k2b/cloud": "file:../cloud.tgz" } }));
    await writeFile(
      join(appDir, "src/config.ts"),
      `
      import { defineApp } from "@k2b/cloud";
      export const app = defineApp({ id: ${JSON.stringify(appId)}, name: "Inventory", icon: "ti ti-box", baseUrl: "http://inventory:3000", routes: ["/inventory"] });
    `,
    );
    await writeFile(
      join(appDir, "src/index.ts"),
      `
      import { sql, redis, connections } from "@k2b/cloud";
      import { app } from "./config";
      import { SQL, RedisClient } from "bun";
      const reference = new SQL({ url: connections().database.url });
      if (Object.getPrototypeOf(sql) !== Object.getPrototypeOf(reference) || !(redis instanceof RedisClient)) throw new Error("app imported before native clients");
      await reference.close();
      if (process.env.FIXTURE_BOOTSTRAP === "true") {
        await sql\`SELECT 1\`;
        await redis.ping();
      }
      const callback = () => {}; redis.onconnect = callback;
      const native = typeof sql.listen === "function" && redis.onconnect === callback;
      const fetch = async (request, server) => {
        if (new URL(request.url).pathname === "/socket" && server.upgrade(request)) return;
        if (new URL(request.url).pathname === "/_cloud/ready") return Response.json({ status: "ready", appId: connections().appId });
        return Response.json({ native, appId: connections().appId });
      };
      const started = process.env.FIXTURE_LIFECYCLE === "true"
        ? await app.start({ port: Number(process.env.FIXTURE_PORT), skipSetup: true, fetch })
        : { port: Number(process.env.FIXTURE_PORT), hostname: "127.0.0.1", fetch };
      export default { ...started, websocket: { message(socket, message) { socket.send(message); } } };
    `,
    );
    // A fixed clock keeps proofs deterministic across the parent Core and child runtime.
    const clock = join(appDir, "clock.ts");
    if (bootstrap) await writeFile(clock, `Date.now = () => ${bootstrap.now};`);
    // Production config/plugin discovery must remain offline, even with no infrastructure values.
    const env = { PATH: process.env.PATH, NODE_ENV: "production", APP_ID: appId, APP_DIR: appDir };
    if (appId === "inventory") {
      for (const script of ["build.ts", "preload.ts"]) {
        await expect(
          childOutput(
            Bun.spawn([process.execPath, "--no-env-file", join(packageDir, "scripts", script)], {
              cwd: appDir,
              env: { ...env, APP_ID: "gateway", DATABASE_URL: "postgres://127.0.0.1:1/unused_test", REDIS_URL: "redis://127.0.0.1:1" },
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        ).rejects.toThrow('does not match declared app "inventory"');
      }
    }
    await childOutput(
      Bun.spawn([process.execPath, "--no-env-file", join(packageDir, "scripts/build.ts")], {
        cwd: appDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const bundle = join(appDir, "dist/server.js");
    expect((await readFile(bundle, "utf8")).length).toBeGreaterThan(0);
    const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    for (const dev of [false, true]) {
      runtime = Bun.spawn(
        dev
          ? [
              process.execPath,
              "--no-env-file",
              ...(bootstrap ? ["--preload", clock] : []),
              "--preload",
              join(packageDir, "scripts/preload.ts"),
              join(appDir, "src/index.ts"),
            ]
          : [process.execPath, "--no-env-file", ...(bootstrap ? ["--preload", clock] : []), bundle],
        {
          cwd: dev ? appDir : dirname(bundle),
          env: {
            ...env,
            FIXTURE_PORT: String(port),
            CLOUD_APP_KEY: bootstrap?.key,
            CLOUD_CORE_INTERNAL_ORIGIN: bootstrap?.origin,
            DATABASE_URL: bootstrap ? undefined : lifecycle ? database! : "postgres://127.0.0.1:1/unused_test",
            REDIS_URL: bootstrap ? undefined : lifecycle ? valkey! : "redis://127.0.0.1:1",
            NATS_SERVERS: bootstrap ? undefined : lifecycle ? nats! : "",
            NATS_CREDS_FILE: lifecycle ? creds : undefined,
            SYNC_NAMESPACE: bootstrap ? undefined : lifecycle ? namespace! : "",
            SYNC_REPLICAS: bootstrap ? undefined : "1",
            APP_SECRET: bootstrap ? undefined : (process.env.APP_SECRET ?? "fixture-only-secret"),
            FIXTURE_LIFECYCLE: String(lifecycle),
            FIXTURE_BOOTSTRAP: String(!!bootstrap),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const address = `http://127.0.0.1:${port}`;
      const deadline = performance.now() + 15_000;
      while (true) {
        if (runtime.exitCode !== null) {
          const stderr = runtime.stderr;
          throw new Error(
            `Fixture exited before listening: ${typeof stderr === "number" || !stderr ? "" : await new Response(stderr).text()}`,
          );
        }
        try {
          await fetch(address, { signal: AbortSignal.timeout(500) });
          break;
        } catch {
          if (performance.now() >= deadline) throw new Error("Fixture did not listen");
          await Bun.sleep(50);
        }
      }
      const response = await fetch(address, { signal: AbortSignal.timeout(5_000) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ native: true, appId });
      const socket = new WebSocket(`${address.replace("http:", "ws:")}/socket`);
      let socketTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const message = new Promise((resolve, reject) => {
          socket.onopen = () => socket.send("platform-start-echo");
          socket.onmessage = (event) => resolve(event.data);
          socket.onerror = () => reject(new Error("Fixture WebSocket failed"));
        });
        expect(
          await Promise.race([
            message,
            new Promise<never>((_, reject) => {
              socketTimer = setTimeout(() => reject(new Error("Fixture WebSocket timed out")), 3_000);
            }),
          ]),
        ).toBe("platform-start-echo");
      } finally {
        clearTimeout(socketTimer);
        socket.close();
      }
      if (lifecycle || bootstrap) {
        const readiness = await fetch(`${address}/_cloud/ready`);
        expect(readiness.status).toBe(200);
        expect(await readiness.json()).toMatchObject({ status: "ready", appId });
      }
      runtime.kill();
      const stopped = setTimeout(() => runtime?.kill("SIGKILL"), 10_000);
      try {
        const code = await runtime.exited;
        if (lifecycle) expect(code).toBe(0);
      } finally {
        clearTimeout(stopped);
      }
      runtime = undefined;
    }
  } finally {
    if (runtime && runtime.exitCode === null) {
      runtime.kill();
      const stopped = setTimeout(() => runtime?.kill("SIGKILL"), 10_000);
      try {
        await runtime.exited;
      } finally {
        clearTimeout(stopped);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
};
