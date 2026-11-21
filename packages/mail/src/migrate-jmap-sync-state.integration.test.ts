import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { migrate } from "./migrate";
import baseline from "./schema.sql" with { type: "text" };
import { readJmapSyncState, serializeJmapSyncState } from "./service/connectors/jmap-account-state";

const suite = suiteFor("database", "nats");
const mailboxId = "00000000-0000-4000-8000-0000000003c1";
const resourceId = "00000000-0000-4000-8000-0000000003c2";
const state = serializeJmapSyncState({ version: 2, emailState: "opaque:/email", mailboxState: "opaque:/mailbox", scan: null });
const column = () => sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
  SELECT data_type, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = 'mail' AND table_name = 'remote_resources' AND column_name = 'sync_state'`;

suite("JMAP sync state schema", () => {
  test("baseline provides nullable object storage without a default", async () => {
    await migrate();
    await sql.begin(async (tx) => {
      const table = baseline.match(/CREATE TABLE mail\.remote_resources \([\s\S]*?\n\);/)?.[0];
      if (!table) throw new Error("baseline: remote resources definition missing");
      await tx.unsafe(table.replace("CREATE TABLE mail.remote_resources", "CREATE TEMP TABLE baseline_sync_resources")).simple();
      try {
        await tx<Record<string, unknown>[]>`INSERT INTO baseline_sync_resources
          (id, mailbox_id, remote_locator, server_identity, scope_fingerprint, created_at, updated_at)
          VALUES (${resourceId}::uuid, ${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)},
            '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`;
        expect(await tx<{ sync_state: unknown }[]>`SELECT sync_state FROM baseline_sync_resources`).toEqual([{ sync_state: null }]);
        await tx<Record<string, unknown>[]>`UPDATE baseline_sync_resources SET sync_state = ${state}::jsonb`;
        const [row] = await tx<{ sync_state: unknown }[]>`SELECT sync_state FROM baseline_sync_resources`;
        expect(readJmapSyncState(row?.sync_state)).toEqual(state);
        for (const invalid of ["[]", '"text"', "42", "null"]) {
          await expect(
            tx.savepoint(async (sp) => {
              await sp<Record<string, unknown>[]>`UPDATE baseline_sync_resources SET sync_state = ${invalid}::jsonb`;
            }),
          ).rejects.toMatchObject({ constraint: "remote_resources_sync_state_check" });
        }
      } finally {
        await tx<Record<string, unknown>[]>`DROP TABLE baseline_sync_resources`.simple();
      }
    });
  });

  test("two upgrades preserve existing rows and checkpoints; unsupported formats are never rewritten", async () => {
    await migrate();
    await sql<Record<string, unknown>[]>`INSERT INTO mail.mailboxes (id, short_id, name, created_at, updated_at)
      VALUES (${mailboxId}::uuid, 'JmpSC1', 'Sync state fixture', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`;
    try {
      await sql<Record<string, unknown>[]>`INSERT INTO mail.remote_resources
        (id, mailbox_id, remote_locator, server_identity, scope_fingerprint, created_at, updated_at)
        VALUES (${resourceId}::uuid, ${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)},
          '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`;
      // Reproduce the predecessor table, retaining its rows, constraints and migration ledger.
      await sql<Record<string, unknown>[]>`ALTER TABLE mail.remote_resources DROP COLUMN sync_state`.simple();
      const preserved = () => sql<{ row: Record<string, unknown> }[]>`
        SELECT to_jsonb(resource) - 'sync_state' AS row FROM mail.remote_resources resource
        WHERE id = ${resourceId}::uuid`;
      const before = await preserved();
      const checks = () => sql<{ oid: number }[]>`SELECT oid FROM pg_constraint
        WHERE conrelid = 'mail.remote_resources'::regclass AND conname = 'remote_resources_sync_state_check'`;
      await migrate();
      expect(await column()).toEqual([{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
      expect(await preserved()).toEqual(before);
      expect(await sql<{ sync_state: unknown }[]>`SELECT sync_state FROM mail.remote_resources WHERE id = ${resourceId}::uuid`).toEqual([
        { sync_state: null },
      ]);
      const firstCheck = await checks();
      await migrate();
      expect(await preserved()).toEqual(before);
      expect(await checks()).toEqual(firstCheck);
      await sql<Record<string, unknown>[]>`UPDATE mail.remote_resources SET sync_state = ${state}::jsonb WHERE id = ${resourceId}::uuid`;
      const withState = await preserved();
      await migrate();
      expect(await preserved()).toEqual(withState);
      expect(await sql<{ sync_state: unknown }[]>`SELECT sync_state FROM mail.remote_resources WHERE id = ${resourceId}::uuid`).toEqual([
        { sync_state: state },
      ]);
      await expect(
        sql.begin(async (tx) => {
          await tx<Record<string, unknown>[]>`UPDATE mail.remote_resources SET sync_state = '[]'::jsonb WHERE id = ${resourceId}::uuid`;
        }),
      ).rejects.toMatchObject({ constraint: "remote_resources_sync_state_check" });
      const unsupported = { ...state, version: 1 };
      await sql<
        Record<string, unknown>[]
      >`UPDATE mail.remote_resources SET sync_state = ${unsupported}::jsonb WHERE id = ${resourceId}::uuid`;
      const snapshot = await preserved();
      const [row] = await sql<{ sync_state: unknown }[]>`SELECT sync_state FROM mail.remote_resources WHERE id = ${resourceId}::uuid`;
      expect(() => readJmapSyncState(row?.sync_state)).toThrow("JMAP_SYNC_STATE_UNSUPPORTED");
      expect(await preserved()).toEqual(snapshot);
      expect(await sql<{ sync_state: unknown }[]>`SELECT sync_state FROM mail.remote_resources WHERE id = ${resourceId}::uuid`).toEqual([
        { sync_state: unsupported },
      ]);
    } finally {
      await migrate();
      await sql<Record<string, unknown>[]>`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
  });
});
