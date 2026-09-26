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
 */
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { SQL, sql } from "bun";
import { assertVerificationReport, localVerificationUrl, selectPhases } from "./verification";

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
  const { createDisposableDatabase, requireInfra, testInfra } = await import("../../../scripts/fixtures/test-infra");
  await requireInfra("database", "nats", "gotenberg");
  const adminUrl = localVerificationUrl("PostgreSQL", testInfra.database);
  const syncUrl = localVerificationUrl("NATS", testInfra.nats);
  const pdfUrl = localVerificationUrl("Gotenberg", testInfra.gotenberg);
  const pdftotext = process.env.PDFTOTEXT ?? "pdftotext";
  const reportRoot = process.env.GRIDS_VERIFY_REPORTS_DIR ?? tmpdir();
  await mkdir(reportRoot, { recursive: true });
  const reports = await mkdtemp(join(reportRoot, "grids-verification-"));
  console.log(`Grids verification reports: ${reports}`);
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
    "src/frontend/_components/table/ResourceValue.behavior.test.tsx",
    "src/frontend/_components/records/RecordReadView.behavior.test.tsx",
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
    "src/frontend/_components/forms/PublicFormSubmit.behavior.test.tsx",
    "src/frontend/custom-app/RecordDetails.behavior.test.tsx",
    "src/frontend/custom-app/DocumentPreviewDialog.behavior.test.tsx",
    "src/frontend/custom-app/WorkflowActionDialog.behavior.test.tsx",
    "src/frontend/custom-app/WorkflowActionRecovery.behavior.test.tsx",
    "src/frontend/custom-app/BackgroundAction.behavior.test.tsx",
    "src/frontend/custom-app/RecordsTable.actions.behavior.test.tsx",
    "src/frontend/custom-app/FormWorkspace.behavior.test.tsx",
    "src/frontend/custom-app/FormDialog.behavior.test.tsx",
    "src/frontend/custom-app/SidebarActions.behavior.test.tsx",
    "src/frontend/custom-app/Actions.behavior.test.tsx",
    "src/frontend/custom-app/RecordsTable.behavior.test.tsx",
    "src/frontend/custom-app/RecordsTable.presentation.behavior.test.tsx",
    "src/frontend/custom-app/calendar-date-base.behavior.test.tsx",
    "src/frontend/_components/table/ObjectListValue.behavior.test.tsx",
    "src/frontend/_components/forms/FormInputValidation.behavior.test.tsx",
    "src/frontend/_components/dialogs/DocumentTemplatesManagerDialog.behavior.test.tsx",
    "src/frontend/_components/settings/settings-creation.behavior.test.tsx",
    "src/frontend/_components/settings/DocumentDefaultsForm.behavior.test.tsx",
    "src/frontend/_components/records/RecordDialogs.behavior.test.tsx",
    "src/frontend/_components/workflows/WorkflowLauncherManager.behavior.test.tsx",
    "src/frontend/_components/workflows/WorkflowInputFields.behavior.test.tsx",
    "src/frontend/_components/workflows/WorkflowRunDetailPanel.behavior.test.tsx",
    "src/frontend/_components/workflows/FinancialWorkflowStarter.behavior.test.tsx",
    "src/frontend/_components/workflows/FinancialExportDialog.behavior.test.tsx",
    "src/frontend/_components/workflows/QueryExportStarter.behavior.test.tsx",
    "src/frontend/_components/fields/ObjectListConfigEditor.behavior.test.tsx",
    "src/frontend/_components/forms/ObjectListInput.behavior.test.tsx",
    "src/frontend/_components/forms/percent-input.behavior.test.tsx",
  ];
  const workflowConcurrency = ["src/service/workflow-concurrency.integration.test.ts"];
  const ownSync = ["src/service/evidence-exports.integration.test.ts"];
  const bundleChecks = ["src/frontend/_components/dialogs/AuditPolicyDialog.bundle.test.ts"];
  const pdf = ["src/service/document-query-pdf.integration.test.ts"];
  const crashes = ["src/service/document-workflow-crash.integration.test.ts"];
  const packageRoot = join(root, "packages/grids");
  const all = [...new Bun.Glob("{src,scripts,test}/**/*.test.{ts,tsx}").scanSync(packageRoot)].sort();
  const allPhases = [
    // The outbox reconciler claims database-wide work, so test it before other suites enqueue events.
    // This suite owns its Sync lifecycle for the live burst test.
    { name: "outbox", files: special.slice(6), flags: [] },
    {
      name: "workflow-concurrency",
      files: workflowConcurrency,
      flags: ["--timeout", "120000", "--preload", "./packages/grids/scripts/verify-sync-preload.ts"],
    },
    {
      name: "workflow-kernel",
      files: [
        ...new Bun.Glob("packages/cloud/src/workflows/store/*.integration.test.ts").scanSync(root),
        "packages/cloud/src/workflows/store/worker-pool.test.ts",
        ...new Bun.Glob("packages/cloud/src/workflows/runtime/*.test.ts").scanSync(root),
      ]
        .sort()
        .map((file) => resolve(root, file)),
      // packages/cloud runs these files with --isolate, so a module mock in one of them must not leak into the next.
      flags: ["--isolate", "--timeout", "30000"],
    },
    {
      name: "database-and-standard",
      files: all.filter(
        (file) =>
          !workflowConcurrency.includes(file) &&
          !special.includes(file) &&
          !dom.includes(file) &&
          !ownSync.includes(file) &&
          !bundleChecks.includes(file) &&
          !crashes.includes(file) &&
          !pdf.includes(file),
      ),
      // These suites include multi-step migrations and history baselines;
      // their timeout is not a single-request latency budget.
      flags: ["--timeout", "30000", "--preload", "./packages/grids/scripts/verify-sync-preload.ts"],
      pdftotext: true,
    },
    { name: "sync", files: special.slice(0, 3), flags: [] },
    { name: "evidence-exports", files: ownSync, flags: ["--timeout", "30000"] },
    // Keep browser bundling isolated from process-global test plugins.
    { name: "browser-bundle", files: bundleChecks, flags: [] },
    { name: "pdf", files: pdf, flags: [], pdftotext: true },
    { name: "process-crashes", files: crashes, flags: [] },
    { name: "recovery-and-cleanup", files: special.slice(3, 5), flags: [] },
    { name: "dom", files: dom, flags: ["--isolate", "--conditions=browser", "--preload", "./packages/ui/test/solid-dom-preload.ts"] },
  ];
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
    const nats = await connect({ servers: syncUrl.toString(), timeout: 5_000, reconnect: false, ignoreClusterUpdates: true });
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
          [
            process.execPath,
            "test",
            ...phase.flags,
            "--reporter=junit",
            `--reporter-outfile=${report}`,
            ...phase.files.map((file) => resolve(packageRoot, file)),
          ],
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
