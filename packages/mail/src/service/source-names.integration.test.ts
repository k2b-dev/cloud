import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrateSourceNames } from "./source-names-migrate";

suiteFor("database")("retained Mail source names", () => {
  test("backfills existing versions idempotently and captures only Mail sources", async () => {
    // Recreate an old installation inside one transaction. On failure the original
    // capture triggers and all fixture data roll back together.
    await sql.begin(async (db) => {
      await db`LOCK TABLE workflows.workflow, workflows.version IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
      await db`DROP TRIGGER IF EXISTS mail_capture_workflow_version_source ON workflows.version`;
      await db`DROP TRIGGER IF EXISTS mail_capture_workflow_source ON workflows.workflow`;
      await db`DROP FUNCTION IF EXISTS mail.capture_workflow_source_name()`;
      const sources: { appId: string; workflowId: string; versionId: string }[] = [];
      for (const appId of ["mail", "grids"]) {
        const [workflow] = await db<{ id: string }[]>`INSERT INTO workflows.workflow (app_id, scope_id, key, name, created_by_kind)
          VALUES (${appId}, 'source-names-test', ${crypto.randomUUID()}, 'Existing source', 'system') RETURNING id`;
        const [version] = await db<{ id: string }[]>`INSERT INTO workflows.version
          (workflow_id, revision, source, source_hash, plan, language_id, language_version, manifest_hash, created_by_kind)
          VALUES (${workflow!.id}::uuid, 1, 'source', ${"a".repeat(64)}, '{}', 'test', 1, ${"b".repeat(64)}, 'system') RETURNING id`;
        await db`UPDATE workflows.workflow SET active_version_id = ${version!.id}::uuid WHERE id = ${workflow!.id}::uuid`;
        sources.push({ appId, workflowId: workflow!.id, versionId: version!.id });
      }
      await migrateSourceNames(db);
      await migrateSourceNames(db);
      for (const { appId, workflowId, versionId } of sources) {
        const rows = await db`SELECT version_id, workflow_id, name, active FROM mail.workflow_source_names
          WHERE workflow_id = ${workflowId}::uuid`;
        expect(rows).toEqual(
          appId === "mail" ? [{ version_id: versionId, workflow_id: workflowId, name: "Existing source", active: false }] : [],
        );
        await db`DELETE FROM workflows.workflow WHERE id = ${workflowId}::uuid`;
        await db`DELETE FROM mail.workflow_source_names WHERE workflow_id = ${workflowId}::uuid`;
      }
    });
  });

  test("an already migrated Mail restart takes no workflow DDL locks", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = sql.begin(async (db) => {
      await db`LOCK TABLE workflows.workflow, workflows.version IN ROW EXCLUSIVE MODE`;
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      await sql.begin(async (db) => {
        await db`SET LOCAL lock_timeout = '100ms'`;
        await migrateSourceNames(db);
      });
    } finally {
      release.resolve();
      await writer;
    }
  });
});
