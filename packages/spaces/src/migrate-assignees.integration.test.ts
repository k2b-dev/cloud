import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import { newShortId } from "./lib/short-id";
import { backfillClaimAssignees, migrateAssigneePrincipals } from "./migrate";

const suite = databaseSuite();
const CLAIMED_AT = "2026-10-01T09:00:00.000Z";

suite("Spaces assignee migration", () => {
  test("converges old user-only tables without changing rows and is a no-op on a second start", async () => {
    const schema = `assignee_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const userIds = [crypto.randomUUID(), crypto.randomUUID()];
    const accountId = crypto.randomUUID();
    const ownerIds = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      for (const userId of userIds) {
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
          VALUES (${userId}::uuid, ${`assignee-migration-${userId}`}, 'local', 'user', 'Existing assignee')`;
      }
      await sql`INSERT INTO auth.service_accounts (id, name, kind) VALUES (${accountId}::uuid, ${`Migration agent ${accountId}`}, 'agent')`;
      await sql.unsafe(`CREATE SCHEMA ${schema}`).simple();
      await sql.unsafe(`CREATE TABLE ${schema}.owners (id UUID PRIMARY KEY)`).simple();
      for (const id of ownerIds) await sql.unsafe(`INSERT INTO ${schema}.owners VALUES ($1::uuid)`, [id]);

      // Running the full app migration against shared tables would disrupt parallel suites. These isolated tables
      // reproduce the old shape and run the exact convergence helper called by migrate(), including both FKs.
      for (const table of ["item_assignees", "item_template_assignees"] as const) {
        const ownerColumn = table === "item_assignees" ? "item_id" : "template_id";
        const relation = `${schema}.${table}`;
        await sql
          .unsafe(`CREATE TABLE ${relation} (
          ${ownerColumn} UUID NOT NULL REFERENCES ${schema}.owners(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
          PRIMARY KEY (${ownerColumn}, user_id)
        )`)
          .simple();
        for (const userId of userIds) {
          for (const ownerId of ownerIds) {
            await sql.unsafe(`INSERT INTO ${relation} VALUES ($1::uuid, $2::uuid)`, [ownerId, userId]);
          }
        }
        const originalRows = await sql.unsafe(`SELECT ${ownerColumn}, user_id, xmin::text, ctid::text FROM ${relation}
          ORDER BY ${ownerColumn}, user_id`);
        await migrateAssigneePrincipals({ table, schema });
        expect(
          await sql.unsafe(`SELECT ${ownerColumn}, user_id, xmin::text, ctid::text FROM ${relation}
            ORDER BY ${ownerColumn}, user_id`),
        ).toEqual(originalRows);
        const constraints = () => sql<{ oid: number; conname: string; contype: string; definition: string }[]>`
          SELECT oid, conname, contype, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conrelid = ${relation}::regclass ORDER BY conname
        `;
        const firstConstraints = await constraints();
        expect(firstConstraints.filter((row) => row.contype === "p")).toEqual([]);
        expect(
          firstConstraints
            .filter((row) => row.contype === "u")
            .map((row) => row.conname)
            .sort(),
        ).toEqual([`${table}_user_key`, `${table}_service_account_key`].sort());
        expect(firstConstraints.find((row) => row.conname === `${table}_principal_check`)?.definition).toContain("num_nonnulls");
        expect(firstConstraints.filter((row) => row.contype === "f")).toHaveLength(3);
        expect(firstConstraints.filter((row) => row.contype === "f").every((row) => row.definition.includes("ON DELETE CASCADE"))).toBe(
          true,
        );
        const indexes = () => sql<{ indexname: string; indexdef: string }[]>`
          SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ${schema} AND tablename = ${table} ORDER BY indexname
        `;
        const firstIndexes = await indexes();
        expect(firstIndexes.some((index) => index.indexname === `idx_${table}_service_account`)).toBe(true);
        await migrateAssigneePrincipals({ table, schema });
        expect(await constraints()).toEqual(firstConstraints);
        expect(await indexes()).toEqual(firstIndexes);
        expect(
          await sql.unsafe(`SELECT ${ownerColumn}, user_id, xmin::text, ctid::text FROM ${relation}
            ORDER BY ${ownerColumn}, user_id`),
        ).toEqual(originalRows);

        await sql.unsafe(`INSERT INTO ${relation} (${ownerColumn}, service_account_id) VALUES ($1::uuid, $2::uuid)`, [
          ownerIds[0]!,
          accountId,
        ]);
        // Bun runs a query when it is awaited; awaiting it inside the callback makes the rejection observable.
        const rejects = (query: string, params: string[]) =>
          expect(
            (async () => {
              await sql.unsafe(query, params);
            })(),
          ).rejects.toThrow();
        await rejects(`INSERT INTO ${relation} (${ownerColumn}, service_account_id) VALUES ($1::uuid, $2::uuid)`, [
          ownerIds[0]!,
          accountId,
        ]);
        await rejects(`INSERT INTO ${relation} (${ownerColumn}, user_id) VALUES ($1::uuid, $2::uuid)`, [ownerIds[0]!, userIds[0]!]);
        await rejects(`INSERT INTO ${relation} (${ownerColumn}) VALUES ($1::uuid)`, [ownerIds[0]!]);
        await rejects(`INSERT INTO ${relation} (${ownerColumn}, user_id, service_account_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, [
          ownerIds[0]!,
          userIds[0]!,
          accountId,
        ]);
      }
      for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
      for (const table of ["item_assignees", "item_template_assignees"]) {
        expect(await sql.unsafe<Record<string, unknown>[]>(`SELECT * FROM ${schema}.${table}`)).toEqual([]);
      }
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).simple();
      for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
    }
  });

  test("backfill assigns existing agents once and skips delegated, deleted and malformed account holders", async () => {
    const spaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const delegatedId = crypto.randomUUID();
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
        VALUES (${userId}::uuid, ${`assignee-backfill-${userId}`}, 'local', 'user', 'Delegating person')`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind) VALUES (${agentId}::uuid, 'Backfill agent', 'agent')`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind, delegated_user_id)
        VALUES (${delegatedId}::uuid, 'Personal automation', 'user_delegated', ${userId}::uuid)`;
      await sql`INSERT INTO spaces.spaces (id, short_id, name) VALUES (${spaceId}::uuid, ${newShortId()}, 'Assignee backfill')`;
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Open') RETURNING id`;
      const itemIds: string[] = [];
      for (const accountId of [agentId, delegatedId, crypto.randomUUID(), "not-a-uuid"]) {
        const [item] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${column!.id}::uuid, 'Legacy claim') RETURNING id`;
        itemIds.push(item!.id);
        const claim = { id: crypto.randomUUID(), actor: { kind: "service_account", id: accountId }, claimedAt: CLAIMED_AT };
        await sql`INSERT INTO spaces.task_work (item_id, claim) VALUES (${item!.id}::uuid, ${claim}::jsonb)`;
      }
      expect(await backfillClaimAssignees()).toBeGreaterThanOrEqual(1);
      const assignees = () => sql<{ item_id: string; user_id: string | null; service_account_id: string | null }[]>`
        SELECT ia.item_id, ia.user_id, ia.service_account_id FROM spaces.item_assignees ia
        JOIN spaces.items i ON i.id = ia.item_id WHERE i.space_id = ${spaceId}::uuid ORDER BY ia.item_id
      `;
      expect(await assignees()).toEqual([{ item_id: itemIds[0]!, user_id: null, service_account_id: agentId }]);
      await backfillClaimAssignees();
      expect(await assignees()).toEqual([{ item_id: itemIds[0]!, user_id: null, service_account_id: agentId }]);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
      for (const id of [agentId, delegatedId]) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
