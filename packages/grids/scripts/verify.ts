/**
 * Grids certification runner. Runs every Grids test phase against a disposable
 * database and fails when any test is skipped, so the report proves that the
 * whole suite ran. Reports (JUnit XML plus complete process logs) are kept
 * under `GRIDS_VERIFY_REPORTS_DIR` (default: the system temp directory).
 *
 * Infrastructure comes from the shared `CLOUD_TEST_*` gate (scripts/fixtures/test-infra.ts):
 *   CLOUD_TEST_DATABASE_URL   local Postgres; the database name must end in `_test` and the
 *                             role must be allowed to CREATE DATABASE. A disposable
 *                             `grids_verify_<id>_test` database is created next to it and
 *                             always dropped, also on SIGINT/SIGTERM.
 *   CLOUD_TEST_NATS_SERVERS   local NATS JetStream
 *   CLOUD_TEST_GOTENBERG_URL  local Gotenberg
 *   PDFTOTEXT                 optional path to Poppler pdftotext (phases `pdf` and
 *                             `database-and-standard` require it)
 *
 * Options:
 *   --phase <name>     run one phase only
 *   --shard <i>/<n>    run every n-th phase starting at the i-th (1-based), so CI can
 *                      split the phases across n jobs; combines with --phase
 *   --bootstrap        internal: migrate and seed the database named by DATABASE_URL
 *
 * Phases in order: outbox, workflow-concurrency, workflow-kernel, database-and-standard,
 * sync, evidence-exports, browser-bundle, pdf, process-crashes, recovery-and-cleanup, dom.
 * Every Grids test file runs in exactly one phase; see `verificationPhases` in ./verification-phases.ts.
 */
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { SQL, sql } from "bun";
import { assertVerificationReport, localVerificationUrl, selectPhases } from "./verification";
import { verificationPhases } from "./verification-phases";

const root = resolve(import.meta.dir, "../../..");
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes("--bootstrap")) {
  // Callers (this script and scripts/diagnostics.ts) pass the isolated database as DATABASE_URL.
  const databaseUrl = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);
  if (!/^\/grids_verify_[a-f0-9]{16,32}(?:_test)?$/.test(databaseUrl.pathname)) throw new Error("Unexpected verification database");
  for (const path of ["auth", "audit", "logging", "settings", "notifications", "workflows"]) {
    const { migrate } = await import(`${root}/packages/core/src/migrate/core/${path}.ts`);
    await migrate();
  }
  const { migrate } = await import("../src/migrate");
  await migrate();
  await sql`INSERT INTO auth.users (uid, provider, profile, given_name, sn, display_name)
    VALUES ('grids-verification', 'local', 'user', 'Grids', 'Verification', 'Grids Verification')`;
  await sql.close();
} else {
  const allPhases = await verificationPhases(root);
  const { connectTestNats, createDisposableDatabase, requireInfra, testInfra } = await import("../../../scripts/fixtures/test-infra");
  await requireInfra("database", "nats", "gotenberg");
  const adminUrl = localVerificationUrl("PostgreSQL", testInfra.database);
  const syncUrl = localVerificationUrl("NATS", testInfra.nats);
  const pdfUrl = localVerificationUrl("Gotenberg", testInfra.gotenberg);
  const pdftotext = process.env.PDFTOTEXT ?? "pdftotext";
  const reportRoot = process.env.GRIDS_VERIFY_REPORTS_DIR ?? tmpdir();
  await mkdir(reportRoot, { recursive: true });
  const reports = await mkdtemp(join(reportRoot, "grids-verification-"));
  console.log(`Grids verification reports: ${reports}`);
  const phases = selectPhases(allPhases, { phase: option("--phase"), shard: option("--shard") });
  if (phases.some((phase) => phase.pdftotext) && !Bun.which(pdftotext)) {
    throw new Error("Grids verification requires Poppler pdftotext on PATH or an executable PDFTOTEXT path");
  }
  const admin = new SQL(adminUrl, { connectionTimeout: 5 });
  let isolated: Awaited<ReturnType<typeof createDisposableDatabase>> | undefined;
  let current: Bun.Subprocess | undefined;
  const interrupted = (signal: NodeJS.Signals) => {
    current?.kill();
    void (isolated?.drop() ?? Promise.resolve()).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const [postgres] = await admin<{ version: string }[]>`SELECT version()`;
    const nats = await connectTestNats({ timeout: 5_000, reconnect: false, ignoreClusterUpdates: true });
    let natsVersion: string | undefined;
    try {
      const manager = await jetstreamManager(nats);
      await manager.getAccountInfo();
      natsVersion = nats.info?.version;
    } finally {
      await nats.close();
    }
    // Readiness can start Chromium; use the PDF integration's renderer budget.
    const health = await fetch(new URL("/health", pdfUrl), { signal: AbortSignal.timeout(30_000) }).catch((cause) => {
      throw new Error("Gotenberg health check failed", { cause });
    });
    if (!health.ok) throw new Error(`Gotenberg health check failed (${health.status})`);
    const renderer = await fetch(new URL("/version", pdfUrl), { signal: AbortSignal.timeout(30_000) }).catch((cause) => {
      throw new Error("Gotenberg version check failed", { cause });
    });
    if (!renderer.ok) throw new Error(`Gotenberg version check failed (${renderer.status})`);
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
    if (commit.exitCode !== 0) throw new Error("Cannot record verification commit");
    const poppler = Bun.which(pdftotext) ? Bun.spawnSync([pdftotext, "-v"]) : undefined;
    await Bun.write(
      join(reports, "environment.json"),
      JSON.stringify(
        {
          commit: commit.stdout.toString().trim(),
          dirty: Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString().trim() !== "",
          bun: Bun.version,
          platform: process.platform,
          arch: process.arch,
          lockfileSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(join(root, "bun.lock")).arrayBuffer()).digest("hex"),
          postgres: postgres?.version,
          nats: natsVersion,
          gotenberg: (await renderer.text()).trim(),
          poppler: poppler ? `${poppler.stdout}${poppler.stderr}`.trim() : null,
          phases: phases.map((phase) => phase.name),
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    isolated = await createDisposableDatabase("grids_verify");
    const env = {
      ...process.env,
      CLOUD_TEST_DATABASE_URL: isolated.url,
      CLOUD_TEST_NATS_SERVERS: syncUrl.toString(),
      CLOUD_TEST_GOTENBERG_URL: pdfUrl.toString(),
    };
    current = Bun.spawn([process.execPath, import.meta.path, "--bootstrap"], {
      cwd: root,
      env: { ...env, DATABASE_URL: isolated.url },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await current.exited) throw new Error("Verification database setup failed");

    for (const phase of phases) {
      const report = join(reports, `${phase.name}.xml`);
      const log = join(reports, `${phase.name}.log`);
      console.log(`\nGrids verification: ${phase.name} (${phase.files.length} files); log: ${log}`);
      // Bun's JUnit output omits errors outside test cases. Keep the complete
      // process output as well, including module-load and unhandled errors.
      const output = openSync(log, "wx");
      let code: number;
      try {
        current = Bun.spawn(
          [process.execPath, "test", ...phase.flags, "--reporter=junit", `--reporter-outfile=${report}`, ...phase.files],
          { cwd: root, env, stdout: output, stderr: output },
        );
        code = await current.exited;
      } finally {
        closeSync(output);
      }
      if (code !== 0) throw new Error(`${phase.name} failed (exit ${code}); report: ${report}; log: ${log}`);
      const xml = await Bun.file(report).text();
      assertVerificationReport(xml, phase.name);
    }
    console.log(`\nAll ${phases.length} selected Grids test phases passed without skips.`);
  } finally {
    if (isolated) await isolated.drop();
    await admin.close({ timeout: 5 });
    // Keep reports when a phase fails so the exact failure remains inspectable.
  }
}
