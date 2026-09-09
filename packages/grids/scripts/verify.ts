import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";

const root = resolve(import.meta.dir, "../../..");
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "ipa_postgres"].includes(databaseUrl.hostname)) {
  throw new Error("Grids verification requires local PostgreSQL");
}
const syncUrl = new URL(process.env.SYNC_TEST_SERVERS ?? "nats://127.0.0.1:4222");
if (!["localhost", "127.0.0.1", "nats"].includes(syncUrl.hostname)) {
  throw new Error("Grids verification requires local NATS");
}

if (process.argv.includes("--bootstrap")) {
  if (!/^\/grids_verify_[a-f0-9]{32}$/.test(databaseUrl.pathname)) throw new Error("Unexpected verification database");
  const { sql } = await import("bun");
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
  const name = `grids_verify_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  const reports = await mkdtemp(join(tmpdir(), "grids-verification-"));
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
    SYNC_TEST_SERVERS: syncUrl.toString(),
    GRIDS_DB_TEST: "1",
    GRIDS_SYNC_TEST: "1",
    GRIDS_RECORD_EVENTS_DB_TEST: "1",
    GRIDS_EVIDENCE_CLEANUP_DB_TEST: "1",
  };
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const bootstrap = Bun.spawn([process.execPath, import.meta.path, "--bootstrap"], {
      cwd: root,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await bootstrap.exited) throw new Error("Verification database setup failed");

    const special = [
      "src/service/workflow-run-events.integration.test.ts",
      "src/service/record-events.integration.test.ts",
      "src/service/record-event-retry.integration.test.ts",
      "src/service/record-event-runtime.integration.test.ts",
      "src/service/evidence-cleanup.integration.test.ts",
      "src/frontend/_components/records/RecordReferencedBy.behavior.test.ts",
      "src/service/record-event-outbox.integration.test.ts",
    ];
    const dom = [
      special[5]!,
      "src/frontend/_components/custom-apps/CustomAppBlockPreview.behavior.test.tsx",
      "src/frontend/_components/workspace/BaseOverview.behavior.test.tsx",
      "src/frontend/_components/documents/DocumentDetailsDialog.behavior.test.tsx",
    ];
    const packageRoot = join(root, "packages/grids");
    const all = [...new Bun.Glob("{src,scripts}/**/*.test.{ts,tsx}").scanSync(packageRoot)].sort();
    const phases = [
      // The outbox reconciler claims database-wide work, so test it before other suites enqueue events.
      { name: "outbox", files: special.slice(6), flags: ["--preload", "./packages/grids/scripts/verify-sync-preload.ts"] },
      {
        name: "database-and-standard",
        files: all.filter((file) => !special.includes(file) && !dom.includes(file)),
        flags: ["--preload", "./packages/grids/scripts/verify-sync-preload.ts"],
      },
      { name: "sync", files: special.slice(0, 3), flags: [] },
      { name: "recovery-and-cleanup", files: special.slice(3, 5), flags: [] },
      { name: "dom", files: dom, flags: ["--conditions=browser", "--preload", "./packages/ui/test/solid-dom-preload.ts"] },
    ];
    for (const phase of phases) {
      const report = join(reports, `${phase.name}.xml`);
      console.log(`\nGrids verification: ${phase.name} (${phase.files.length} files)`);
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          ...phase.flags,
          "--max-concurrency",
          "1",
          "--reporter=junit",
          `--reporter-outfile=${report}`,
          ...phase.files.map((file) => `./packages/grids/${file}`),
        ],
        { cwd: root, env, stdout: "inherit", stderr: "inherit" },
      );
      const code = await child.exited;
      if (code !== 0) throw new Error(`${phase.name} failed (exit ${code}); report: ${report}`);
      const xml = await Bun.file(report).text();
      if (!xml.includes("<testcase") || /<skipped[\s/>]/.test(xml)) {
        throw new Error(`${phase.name} ran no tests or skipped tests; report: ${report}`);
      }
    }
    console.log("\nAll Grids test phases passed without skips.");
  } finally {
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close({ timeout: 5 });
    // Keep reports when a phase fails so the exact failure remains inspectable.
  }
}
