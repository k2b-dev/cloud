import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { cpus, freemem, loadavg, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { SQL } from "bun";
import { type DiagnosticReport, writeDiagnosticReport } from "./diagnostics-report";
import { localVerificationUrl } from "./verification";

// Parent owns the disposable database and the worker's hard deadline. Domain
// modules are loaded only in children with the isolated DATABASE_URL.
const root = resolve(import.meta.dir, "../../..");
const source = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);
const nats = localVerificationUrl("NATS", process.env.SYNC_TEST_SERVERS ?? "nats://127.0.0.1:4222");
const pdf = localVerificationUrl("Gotenberg", process.env.GRIDS_PDF_URL ?? "http://localhost:3001");
const name = `grids_verify_${crypto.randomUUID().replaceAll("-", "")}`;
const namespace = `grids-diagnostics-${crypto.randomUUID()}`;
const cacheName = `${namespace}-cache`;
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const admin = new SQL(adminUrl, { connectionTimeout: 5, max: 1 });
source.pathname = `/${name}`;
const parent = process.env.GRIDS_DIAGNOSTICS_DIR ?? tmpdir();
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "grids-diagnostics-"));
const env = {
  ...process.env,
  DATABASE_URL: source.toString(),
  SYNC_TEST_SERVERS: nats.toString(),
  GRIDS_PDF_URL: pdf.toString(),
  GRIDS_DIAGNOSTICS_REPORT: directory,
  GRIDS_DIAGNOSTICS_NAMESPACE: namespace,
  REDIS_URL: "",
  VALKEY_URL: "",
};
await Bun.write(
  join(directory, "environment.json"),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpus().length,
      loadAverage: loadavg(),
      memoryBytes: { total: totalmem(), free: freemem() },
      commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim(),
      dirty: Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.length > 0,
      lockfileSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(join(root, "bun.lock")).arrayBuffer()).digest("hex"),
      measuredBudgetMs: 180_000,
      services: "Existing local PostgreSQL, NATS and Gotenberg; isolated temporary Valkey cache",
    },
    null,
    2,
  ),
);
console.log(`Diagnostic reports: ${directory}`);
let created = false;
let cacheStarted = false;
try {
  if (!Bun.which(process.env.PDFTOTEXT ?? "pdftotext")) throw new Error("Install pdftotext before running diagnostics");
  const cache = Bun.spawnSync([
    "docker",
    "run",
    "--rm",
    "--pull=never",
    "--detach",
    "--name",
    cacheName,
    "--publish",
    "127.0.0.1::6379",
    "valkey/valkey:8-alpine",
    "valkey-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  if (cache.exitCode) throw new Error(`Cannot start isolated Valkey (requires local valkey/valkey:8-alpine): ${cache.stderr}`);
  cacheStarted = true;
  const port = Bun.spawnSync(["docker", "port", cacheName, "6379"]).stdout.toString().trim();
  assertLocalCachePort(port);
  env.REDIS_URL = env.VALKEY_URL = `redis://${port}`;
  const health = await fetch(new URL("/health", pdf), { signal: AbortSignal.timeout(30_000) });
  if (!health.ok) throw new Error(`Gotenberg health: ${health.status}`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  created = true;
  for (const [label, args] of [
    ["bootstrap", ["packages/grids/scripts/verify.ts", "--bootstrap"]],
    ["measurement", ["packages/grids/scripts/diagnostics-worker.ts"]],
  ] as const) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let setup: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const log = openSync(join(directory, `${label}.log`), "w");
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      env,
      stdout: log,
      stderr: log,
      ipc(message: unknown, subprocess) {
        if (message === "measuring") {
          clearTimeout(setup);
          console.log("Fixtures ready; starting the three-minute measurement budget.");
          timer = setTimeout(() => {
            expired = true;
            subprocess.kill();
          }, 180_000);
        }
      },
    });
    // Setup has its own finite budget; it is not counted as query latency.
    setup = setTimeout(() => {
      expired = true;
      child.kill();
    }, 300_000);
    const code = await child.exited;
    closeSync(log);
    clearTimeout(setup);
    clearTimeout(timer);
    if (code || expired) throw new Error(`${label} ${expired ? "exceeded its budget" : `failed (${code})`}; see ${directory}`);
  }
  console.log(`Complete: ${join(directory, "report.html")}`);
} catch (error) {
  const previous = Bun.file(join(directory, "results.json"));
  const report: DiagnosticReport = (await previous.exists())
    ? await previous.json()
    : {
        environment: await Bun.file(join(directory, "environment.json")).json(),
        samples: [],
        status: "failed",
      };
  report.status = "failed";
  report.error = [report.error, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n");
  await writeDiagnosticReport(directory, report);
  throw error;
} finally {
  try {
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
    try {
      // The parent also cleans up after a killed worker, whose finally cannot run.
      const connection = await connect({ servers: nats.toString(), timeout: 5_000, reconnect: false, ignoreClusterUpdates: true });
      try {
        const manager = await jetstreamManager(connection);
        for await (const stream of manager.streams.list()) {
          if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
        }
      } finally {
        await connection.drain();
      }
    } finally {
      if (cacheStarted) {
        const stopped = Bun.spawnSync(["docker", "stop", cacheName]);
        if (stopped.exitCode) throw new Error(`Could not remove diagnostic cache ${cacheName}`);
      }
    }
  }
}

function assertLocalCachePort(port: string): void {
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error("Unexpected diagnostic cache binding");
}
