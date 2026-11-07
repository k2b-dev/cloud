import { sql } from "@k2b/cloud";
import type { Area, HomeProvisioningResult, HomeProvisioningState, HomeProvisioningStatus, HomeReconciliationResult } from "../contracts";

type Row = {
  user_id: string;
  username: string | null;
  area: HomeProvisioningStatus["area"];
  state: HomeProvisioningState;
  operation_id: string | null;
  event_id: string | null;
  error_code: string | null;
  updated_at: Date;
};
const project = (row: Row): HomeProvisioningStatus => ({
  userId: row.user_id,
  username: row.username,
  area: row.area,
  state: row.state,
  operationId: row.operation_id,
  eventId: row.event_id,
  errorCode: row.error_code,
  updatedAt: row.updated_at.toISOString(),
});
// Match the account identity service's bounded administration page.
export const HOME_PROVISIONING_PAGE_SIZE = 50;
export const homeProvisioning = {
  async get(userId: string): Promise<HomeProvisioningStatus | null> {
    const [row] = await sql<Row[]>`
      SELECT * FROM filesv2.home_provisioning WHERE user_id = ${userId}::uuid
    `;
    return row ? project(row) : null;
  },
  async set(input: Omit<HomeProvisioningStatus, "updatedAt">): Promise<HomeProvisioningStatus> {
    const [row] = await sql<Row[]>`
      INSERT INTO filesv2.home_provisioning(user_id, username, area, state, operation_id, event_id, error_code)
      VALUES (${input.userId}::uuid, ${input.username}, ${input.area}, ${input.state},
        ${input.operationId}::uuid, ${input.eventId}::uuid, ${input.errorCode})
      ON CONFLICT(user_id) DO UPDATE SET username = EXCLUDED.username, area = EXCLUDED.area, state = EXCLUDED.state,
        operation_id = EXCLUDED.operation_id, event_id = COALESCE(EXCLUDED.event_id, filesv2.home_provisioning.event_id),
        error_code = EXCLUDED.error_code, updated_at = now()
      WHERE filesv2.home_provisioning.state <> 'done' OR filesv2.home_provisioning.area IS DISTINCT FROM EXCLUDED.area
      RETURNING *
    `;
    return row ? project(row) : (await this.get(input.userId))!;
  },
  async page(input: {
    area?: Area;
    after?: string;
    state?: HomeProvisioningState;
    pendingOnly?: boolean;
  }): Promise<HomeProvisioningResult> {
    const [rows, grouped, reconciliation] = await Promise.all([
      sql<Row[]>`
        SELECT * FROM filesv2.home_provisioning
        WHERE (${input.after ?? null}::uuid IS NULL OR user_id > ${input.after ?? null}::uuid)
          AND (${input.state ?? null}::text IS NULL OR state = ${input.state ?? null})
          AND (${input.area ?? null}::text IS NULL OR area = ${input.area ?? null})
          AND (${input.pendingOnly ?? false} = false OR state <> 'done')
        ORDER BY user_id LIMIT ${HOME_PROVISIONING_PAGE_SIZE + 1}
      `,
      sql<{ area: Area; state: HomeProvisioningState; count: number }[]>`
        SELECT area, state, count(*)::double precision AS count
        FROM filesv2.home_provisioning GROUP BY area, state
      `,
      sql<{ last_run_at: Date | null; last_result: HomeReconciliationResult | null; running: boolean }[]>`
        SELECT last_run_at, last_result, (running AND COALESCE(running_until > now(), false)) AS running
        FROM filesv2.home_reconciliation WHERE singleton = true
      `,
    ]);
    const counts: HomeProvisioningResult["counts"] = { cloud: {}, freeipa: {} };
    for (const group of grouped) counts[group.area][group.state] = group.count;
    const latest = reconciliation[0];
    return {
      items: rows.slice(0, HOME_PROVISIONING_PAGE_SIZE).map(project),
      nextCursor: rows.length > HOME_PROVISIONING_PAGE_SIZE ? rows[HOME_PROVISIONING_PAGE_SIZE - 1]!.user_id : null,
      counts,
      reconcile: {
        lastRunAt: latest?.last_run_at?.toISOString() ?? null,
        lastResult: latest?.last_result ?? null,
        running: latest?.running ?? false,
      },
    };
  },
  async cursor() {
    await sql`INSERT INTO filesv2.home_reconciliation(singleton) VALUES(true) ON CONFLICT DO NOTHING`;
    return (
      await sql<{ after_id: string | null; revision: number }[]>`
        SELECT after_id, revision FROM filesv2.home_reconciliation WHERE singleton = true
      `
    )[0]!;
  },
  async advance(after: string | null, revision: number) {
    await sql`
      UPDATE filesv2.home_reconciliation SET after_id = ${after}::uuid
      WHERE singleton = true AND revision = ${revision}
    `;
  },
  async start() {
    await this.renew();
  },
  async renew() {
    await sql`
      UPDATE filesv2.home_reconciliation SET running = true, running_until = now() + interval '120 seconds'
      WHERE singleton = true
    `;
  },
  async finish(result: HomeReconciliationResult) {
    await sql`
      UPDATE filesv2.home_reconciliation SET running = false, running_until = NULL,
        last_run_at = now(), last_result = ${JSON.stringify(result)}::text::jsonb
      WHERE singleton = true
    `;
  },
  async request() {
    await sql`
      INSERT INTO filesv2.home_reconciliation(singleton, after_id) VALUES(true, NULL)
      ON CONFLICT(singleton) DO UPDATE SET after_id = NULL, revision = filesv2.home_reconciliation.revision + 1
    `;
  },
};

export async function migrateHomeProvisioning() {
  await sql`
    CREATE TABLE IF NOT EXISTS filesv2.home_provisioning (
      user_id UUID PRIMARY KEY,
      username TEXT,
      area TEXT NOT NULL CHECK(area IN ('cloud', 'freeipa')),
      state TEXT NOT NULL CHECK(state IN ('not_configured', 'auto_create_off', 'posix_incomplete', 'done', 'failed', 'inactive')),
      operation_id UUID,
      event_id UUID,
      error_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS filesv2_home_provisioning_state ON filesv2.home_provisioning(state, user_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS filesv2_home_provisioning_area_state ON filesv2.home_provisioning(area, state, user_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS filesv2.home_reconciliation (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
      after_id UUID,
      revision INTEGER NOT NULL DEFAULT 0
    )
  `.simple();
  await sql`
    ALTER TABLE filesv2.home_reconciliation ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_result JSONB,
      ADD COLUMN IF NOT EXISTS running BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS running_until TIMESTAMPTZ
  `.simple();
}
