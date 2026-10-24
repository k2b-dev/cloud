import { decryptSecret, encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { PULSE_INTERNAL_INGEST_BATCH_LIMIT } from "../ingest-limits";
import { BASE_STORE_OPERATIONS, BASE_STORE_STATES, READ_PROFILE_NAMES } from "./admin-contracts";
import { assertStoreName, BASE_SCHEMA_VERSIONS, baseStoreNames, baseTtlStatements, DATA_TABLES, READ_VIEWS } from "./base-schema";
import { clickhouseQuery, type QueryOptions, StoreQueryError } from "./client";
import { MaintenanceBusy, maintenanceQuery } from "./maintenance-query";
import { storeConnection } from "./service";
import { hashServicePassword, randomHex } from "./setup-sql";
import { quoteIdentifier as q, StorePrefix } from "./validation";

const RowSchema = z.object({
  base_id: z.string(),
  state: z.enum(BASE_STORE_STATES),
  operation: z.enum(BASE_STORE_OPERATIONS).nullable(),
  database_name: z.string(),
  read_user: z.string(),
  read_password_encrypted: z.string().nullable(),
  profile: z.enum(READ_PROFILE_NAMES),
  schema_version: z.number(),
  // Keep Postgres microseconds when comparing operation revisions; Date truncates them.
  updated_at_version: z.string(),
  retention_days: z.number(),
  rollup_retention_days: z.number(),
  sensitive_retention_hours: z.number(),
  reset_generation: z.coerce.string(),
  checkpoint_id: z.string().nullable(),
  pending_checkpoint_id: z.string().nullable(),
  write_block_reason: z.string().nullable(),
});
export type StoreRow = z.infer<typeof RowSchema>;
export const loadStoreRow = async (baseId: string, db: typeof sql = sql, lock = false) => {
  const [row] =
    await db`SELECT s.*,s.updated_at::text AS updated_at_version,b.retention_days,b.rollup_retention_days,b.sensitive_retention_hours FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id WHERE s.base_id=${baseId}::uuid ${lock ? sql`FOR UPDATE OF b,s` : sql``}`;
  return row ? RowSchema.parse(row) : null;
};
export class BaseStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class BaseOperationSuperseded extends Error {}
export const storeErrorCode = (error: unknown): string =>
  error instanceof MaintenanceBusy
    ? "MAINTENANCE_BUSY"
    : error instanceof BaseStoreError
      ? error.code
      : error instanceof StoreQueryError && error.kind === "clickhouse"
        ? `CLICKHOUSE_ERROR:${error.code}`
        : "STORE_UNREACHABLE";
export type StoreOperation = "provision" | "clear" | "delete" | "reconcile";
export const createBaseStore = ({
  connection = storeConnection,
  prefix = "pulse_",
  clock = () => new Date(),
  beforeStep,
  transport,
  queryRunner = clickhouseQuery,
}: {
  connection?: () => Promise<{ url: string; user: string; password: string } | null>;
  prefix?: string;
  transport?: QueryOptions["transport"];
  queryRunner?: (options: QueryOptions, workload: "maintenance" | "ingest") => ReturnType<typeof clickhouseQuery>;
  clock?: () => Date;
  beforeStep?: (operation: StoreOperation, step: string) => void | Promise<void>;
} = {}) => {
  StorePrefix.parse(prefix);
  const query = async (
    query: string,
    params?: Record<string, string | number>,
    resolved?: Awaited<ReturnType<typeof connection>>,
    workload: "maintenance" | "ingest" = "maintenance",
  ) => {
    const value = resolved === undefined ? await connection() : resolved;
    if (!value) throw new BaseStoreError("STORE_NOT_CONFIGURED");
    return queryRunner(
      {
        ...value,
        query,
        params,
        transport,
        settings: { insert_deduplicate: 0, async_insert: 0 },
        timeoutMs: 30_000,
        maxResponseBytes: PULSE_INTERNAL_INGEST_BATCH_LIMIT * 128,
      },
      workload,
    );
  };
  const ctx = (row: StoreRow) => ({
    database: row.database_name,
    prefix,
    rawRetentionDays: row.retention_days,
    rollupRetentionDays: row.rollup_retention_days,
    sensitiveRetentionHours: row.sensitive_retention_hours,
  });
  const names = (row: StoreRow) => {
    const expected = baseStoreNames(row.base_id, prefix);
    if (expected.database !== row.database_name || expected.readUser !== row.read_user) throw new BaseStoreError("STORE_UNREACHABLE");
    return { database: assertStoreName(row.database_name, prefix), reader: assertStoreName(row.read_user, prefix, true) };
  };
  const store = {
    prefix,
    clock,
    query,
    /** Resolve settings before reserving a SQL connection, including on a cold cache. */
    async prepare(workload: "maintenance" | "ingest" = "maintenance") {
      const value = await connection();
      const query = this.query;
      return (statement: string, params?: Record<string, string | number>) => query(statement, params, value, workload);
    },
    /** Lock one step, then re-read. A delete can supersede a clear between any two steps. */
    async step(
      baseId: string,
      operation: StoreOperation,
      step: string,
      run: (row: StoreRow, db: typeof sql) => Promise<void>,
      expectedVersion?: string,
    ) {
      await beforeStep?.(operation, step);
      await sql.begin(async (tx) => {
        const row = await loadStoreRow(baseId, tx, true);
        const expected =
          operation === "reconcile"
            ? "active"
            : operation === "provision"
              ? "provisioning"
              : operation === "clear"
                ? "clearing"
                : "deleting";
        if (
          !row ||
          row.state !== expected ||
          (expectedVersion !== undefined && row.updated_at_version !== expectedVersion) ||
          (operation !== "reconcile" && row.operation !== operation)
        )
          throw new BaseOperationSuperseded();
        names(row);
        await run(row, tx);
      });
    },
    async password(row: StoreRow, db: typeof sql) {
      if (row.read_password_encrypted) return;
      const encrypted = await encryptSecret(randomHex(24));
      await db`UPDATE pulse.base_stores SET read_password_encrypted=${encrypted} WHERE base_id=${row.base_id}::uuid`;
    },
    async database(row: StoreRow, db: typeof sql) {
      const database = names(row).database;
      // CREATE DATABASE can survive a rollback of this step. An empty database
      // still needs version 0 even when Postgres retains the old schema ledger.
      const [exists] = await this.query(`EXISTS TABLE ${database}._sources`);
      if (!Number(exists?.result)) await db`UPDATE pulse.base_stores SET schema_version=0 WHERE base_id=${row.base_id}::uuid`;
      await this.query(`CREATE DATABASE IF NOT EXISTS ${database}`);
    },
    async schema(row: StoreRow, db: typeof sql) {
      if (row.schema_version === 0) {
        // Rebuilding an empty database invalidates every control-plane mirror.
        // Commit these flags with the first schema version, so retries cannot lose them.
        await db`UPDATE pulse.sources SET mirror_pending=true WHERE base_id=${row.base_id}::uuid AND NOT deleted`;
        await db`UPDATE pulse.metric_series SET mirrored=false WHERE base_id=${row.base_id}::uuid`;
      }
      for (const version of BASE_SCHEMA_VERSIONS) {
        if (row.schema_version >= version.version) continue;
        for (const statement of version.statements(ctx(row))) await this.query(statement);
        await db`UPDATE pulse.base_stores SET schema_version=${version.version} WHERE base_id=${row.base_id}::uuid`;
        // One version per committed step; later versions re-read the durable ledger.
        return;
      }
    },
    async ttl(row: StoreRow) {
      for (const statement of baseTtlStatements(ctx(row))) await this.query(statement);
    },
    async reader(row: StoreRow) {
      const { reader } = names(row);
      if (!row.read_password_encrypted) throw new BaseStoreError("STORE_UNREACHABLE");
      const hash = await hashServicePassword(await decryptSecret<string>(row.read_password_encrypted));
      const identification = `IDENTIFIED WITH sha256_hash BY '${hash.sha256Hex}' SALT '${hash.saltHex}' SETTINGS PROFILE '${prefix}read_${row.profile}'`;
      await this.query(`CREATE USER IF NOT EXISTS ${reader} ${identification}`);
      await this.query(`ALTER USER ${reader} ${identification}`);
    },
    async grants(row: StoreRow) {
      const { database, reader } = names(row);
      for (const view of READ_VIEWS) await this.query(`GRANT SELECT ON ${database}.${q(view)} TO ${reader}`);
    },
    async truncate(row: StoreRow) {
      const { database } = names(row);
      for (const table of DATA_TABLES) await this.query(`TRUNCATE TABLE IF EXISTS ${database}.${q(table)}`);
    },
    async dropReader(row: StoreRow) {
      await this.query(`DROP USER IF EXISTS ${names(row).reader}`);
    },
    async dropDatabase(row: StoreRow) {
      await this.query(`DROP DATABASE IF EXISTS ${names(row).database} SYNC`);
    },
    async readUserCredentials(baseId: string) {
      const row = await loadStoreRow(baseId);
      if (!row?.read_password_encrypted) throw new BaseStoreError("STORE_UNREACHABLE");
      names(row);
      return { user: row.read_user, password: await decryptSecret<string>(row.read_password_encrypted) };
    },
  };
  return store;
};
export const baseStore = createBaseStore({ queryRunner: maintenanceQuery });
export const readUserCredentials = baseStore.readUserCredentials;
