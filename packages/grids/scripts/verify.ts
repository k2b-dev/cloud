import { closeSync, openSync } from "node:fs";
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
  if (!Bun.which(process.env.PDFTOTEXT ?? "pdftotext")) {
    throw new Error("Grids verification requires Poppler pdftotext on PATH or an executable PDFTOTEXT path");
  }
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
    GRIDS_PDF_TEST: "1",
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
      "src/frontend/_components/workspace/WorkspaceMetadataRefresh.behavior.test.tsx",
      "src/frontend/_components/records-view/records-data-controller.behavior.test.tsx",
      "src/frontend/_components/documents/DocumentDetailsDialog.behavior.test.tsx",
      "src/frontend/_components/documents/DocumentSourcesDialog.behavior.test.tsx",
      "src/frontend/_components/documents/DocumentGenerateDialog.behavior.test.tsx",
      "src/frontend/_components/dialogs/PolicyDialogs.behavior.test.tsx",
      "src/frontend/_components/dialogs/ViewSettingsDialogs.behavior.test.tsx",
      "src/frontend/_components/forms/EditorDialogs.behavior.test.tsx",
      "src/frontend/_components/settings/settings-creation.behavior.test.tsx",
      "src/frontend/_components/records/RecordDialogs.behavior.test.tsx",
      "src/frontend/_components/workflows/WorkflowLauncherManager.behavior.test.tsx",
      "src/frontend/_components/workflows/WorkflowRunDetailPanel.behavior.test.tsx",
      "src/frontend/_components/workflows/FinancialWorkflowStarter.behavior.test.tsx",
      "src/frontend/_components/workflows/FinancialExportDialog.behavior.test.tsx",
      "src/frontend/_components/workflows/QueryExportStarter.behavior.test.tsx",
      "src/frontend/_components/fields/ObjectListConfigEditor.behavior.test.tsx",
      "src/frontend/_components/forms/ObjectListInput.behavior.test.tsx",
      "src/frontend/_components/forms/percent-input.behavior.test.tsx",
    ];
    const ownSync = ["src/service/evidence-exports.integration.test.ts"];
    const bundleChecks = ["src/frontend/_components/dialogs/AuditPolicyDialog.bundle.test.ts"];
    const pdf = ["src/service/document-query-pdf.integration.test.ts"];
    const packageRoot = join(root, "packages/grids");
    const all = [...new Bun.Glob("{src,scripts,test}/**/*.test.{ts,tsx}").scanSync(packageRoot)].sort();
    const phases = [
      // The outbox reconciler claims database-wide work, so test it before other suites enqueue events.
      // This suite owns its Sync lifecycle for the live burst test.
      { name: "outbox", files: special.slice(6), flags: [] },
      {
        name: "database-and-standard",
        files: all.filter(
          (file) =>
            !special.includes(file) &&
            !dom.includes(file) &&
            !ownSync.includes(file) &&
            !bundleChecks.includes(file) &&
            !pdf.includes(file),
        ),
        // These suites include multi-step migrations and history baselines;
        // their timeout is not a single-request latency budget.
        flags: ["--timeout", "30000", "--preload", "./packages/grids/scripts/verify-sync-preload.ts"],
      },
      { name: "sync", files: special.slice(0, 3), flags: [] },
      { name: "evidence-exports", files: ownSync, flags: ["--timeout", "30000"] },
      // Keep browser bundling isolated from process-global test plugins.
      { name: "browser-bundle", files: bundleChecks, flags: [] },
      { name: "pdf", files: pdf, flags: [] },
      { name: "recovery-and-cleanup", files: special.slice(3, 5), flags: [] },
      { name: "dom", files: dom, flags: ["--isolate", "--conditions=browser", "--preload", "./packages/ui/test/solid-dom-preload.ts"] },
    ];
    for (const phase of phases) {
      const report = join(reports, `${phase.name}.xml`);
      const log = join(reports, `${phase.name}.log`);
      console.log(`\nGrids verification: ${phase.name} (${phase.files.length} files); log: ${log}`);
      // Bun's JUnit output omits errors outside test cases. Keep the complete
      // process output as well, including module-load and unhandled errors.
      const output = openSync(log, "wx");
      let code: number;
      try {
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
          { cwd: root, env, stdout: output, stderr: output },
        );
        code = await child.exited;
      } finally {
        closeSync(output);
      }
      if (code !== 0) throw new Error(`${phase.name} failed (exit ${code}); report: ${report}; log: ${log}`);
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
