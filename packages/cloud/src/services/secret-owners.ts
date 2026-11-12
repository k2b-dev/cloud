import type { SQL } from "bun";
import type { SecretOwnerCheck, SecretRotationMetadata } from "../contracts/app-migration";
import { appSecretRingId, appSecretRootId } from "../runtime/app-secret";
import { sql } from "../runtime/clients";
import { connections } from "../runtime/connections";
import { decryptSecretBytes, decryptWithSecretRing, encryptSecretBytes } from "./settings/crypto";

export type SecretOwnerRow = { key: string[]; values: Record<string, string | null> };
/** Apps own their storage and post-commit invalidation. No plaintext leaves this process. */
export type SecretOwner = {
  id: string;
  scan(after: readonly string[] | null, limit: number): Promise<SecretOwnerRow[]>;
  compareAndSwap(row: SecretOwnerRow, values: Record<string, string | null>): Promise<boolean>;
  invalidate?(row: SecretOwnerRow): Promise<void>;
};

const identifier = (value: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Secret owner SQL identifiers must be lowercase identifiers");
  return `"${value}"`;
};

/** Declare existing PostgreSQL ciphertext columns; this never installs or owns their schema. */
export const createSecretOwner = (input: {
  id: string;
  table: `${string}.${string}`;
  primaryKey: readonly string[];
  columns: readonly string[];
  invalidate?: SecretOwner["invalidate"];
  db?: SQL;
}): SecretOwner => {
  if (!/^[a-z][a-z0-9.-]*$/.test(input.id)) throw new Error("Secret owner ID must be a stable lowercase name");
  const parts = input.table.split(".");
  if (parts.length !== 2 || !input.primaryKey.length || !input.columns.length)
    throw new Error("Secret owner requires a table, primary key and ciphertext columns");
  const table = parts.map(identifier).join(".");
  const keys = input.primaryKey.map(identifier);
  const columns = input.columns.map(identifier);
  const db = () => input.db ?? sql;
  return {
    id: input.id,
    invalidate: input.invalidate,
    scan: async (after, limit) => {
      const boundary = after ? `AND ROW(${keys.join(",")}) > ROW(${after.map((_, index) => `$${index + 1}`).join(",")})` : "";
      const values = input.columns.map((column, index) => `'${column}',${columns[index]}`).join(",");
      return db().unsafe<SecretOwnerRow[]>(
        `SELECT jsonb_build_array(${keys.map((key) => `${key}::text`).join(",")}) AS key, jsonb_build_object(${values}) AS values
         FROM ${table} WHERE (${columns.map((column) => `(${column} IS NOT NULL AND ${column} <> '')`).join(" OR ")}) ${boundary}
         ORDER BY ${keys.join(",")} LIMIT $${(after?.length ?? 0) + 1}`,
        [...(after ?? []), limit],
      );
    },
    compareAndSwap: async (row, values) => {
      const replacements = input.columns.map((column) => values[column] ?? null);
      const old = input.columns.map((column) => row.values[column] ?? null);
      const offset = replacements.length;
      const predicate = [
        ...keys.map((key, index) => `${key} = $${offset + index + 1}`),
        ...columns.map((column, index) => `${column} IS NOT DISTINCT FROM $${offset + keys.length + index + 1}::text`),
      ].join(" AND ");
      const updated = await db().unsafe<{ changed: number }[]>(
        `UPDATE ${table} SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(",")} WHERE ${predicate} RETURNING 1 AS changed`,
        [...replacements, ...row.key, ...old],
      );
      return updated.length === 1;
    },
  };
};

/** One bounded page per existing registry heartbeat, with no overlapping process work. */
export const createSecretMaintenance = (owners: readonly SecretOwner[] | undefined, changedAt = Date.now()) => {
  if (owners && new Set(owners.map((owner) => owner.id)).size !== owners.length) throw new Error("Duplicate secret owner IDs");
  const ring = connections().appSecret;
  const fingerprint = appSecretRingId(ring);
  type OwnerState = {
    owner: SecretOwner;
    after: readonly string[] | null;
    counts: { rows: number; previousOnly: number; unreadable: number };
    check: SecretOwnerCheck;
  };
  const state: OwnerState[] | undefined = owners?.map((owner) => ({
    owner,
    after: null,
    counts: { rows: 0, previousOnly: 0, unreadable: 0 },
    check: { id: owner.id, rows: 0, previousOnly: 0, unreadable: 0, checkedAt: null },
  }));
  let position = 0;
  let task: Promise<void> | undefined;
  let stopped = false;
  // The registry write budget is ten seconds. A page permits at most 100 row
  // CAS writes between heartbeats; large stores continue on the next heartbeat.
  const pageSize = 100;
  const step = async (): Promise<void> => {
    if (!state?.length || stopped) return;
    const entry = state[position % state.length]!;
    if (appSecretRingId(connections().appSecret) !== fingerprint) throw new Error("Restart secret maintenance after changing the ring");
    try {
      const rows = await entry.owner.scan(entry.after, pageSize);
      for (const row of rows) {
        if (stopped) return;
        let previousOnly = false;
        let unreadable = false;
        const replacements = { ...row.values };
        for (const [column, ciphertext] of Object.entries(row.values)) {
          if (ciphertext === null || ciphertext === "") continue;
          let decrypted: Awaited<ReturnType<typeof decryptWithSecretRing>>;
          try {
            decrypted = await decryptWithSecretRing(ciphertext);
          } catch {
            unreadable = true;
            continue;
          }
          if (ring.previous && decrypted.rootIndex > 0) {
            previousOnly = true;
            replacements[column] = await encryptSecretBytes(decrypted.plaintext);
            if ((await decryptSecretBytes(replacements[column]!, ring.current)) !== decrypted.plaintext)
              throw new Error("Secret rewrap did not preserve plaintext bytes");
          }
        }
        if (previousOnly && !unreadable && !stopped) {
          // The ciphertext predicate lets a concurrent user write, delete or
          // terminal payload redaction win. A conflict is retried on the next pass.
          if (await entry.owner.compareAndSwap(row, replacements)) previousOnly = false;
        }
        // Repeat even for current-root rows: repairs a crash after commit and
        // before cache invalidation. Advance the cursor only after invalidation.
        if (ring.previous && !unreadable) await entry.owner.invalidate?.(row);
        entry.counts.rows++;
        if (previousOnly) entry.counts.previousOnly++;
        if (unreadable) entry.counts.unreadable++;
        entry.after = row.key;
      }
      if (rows.length < pageSize) {
        entry.check = { id: entry.owner.id, ...entry.counts, checkedAt: new Date().toISOString() };
        entry.after = null;
        entry.counts = { rows: 0, previousOnly: 0, unreadable: 0 };
      }
      position++;
    } catch (error) {
      entry.check = { ...entry.check, checkedAt: null };
      throw error;
    }
  };
  return {
    metadata: (): SecretRotationMetadata => ({
      current: appSecretRootId(ring.current),
      previous: ring.previous ? appSecretRootId(ring.previous) : null,
      next: ring.next ? appSecretRootId(ring.next) : null,
      changedAt: new Date(changedAt).toISOString(),
      ...(state ? { owners: state.map((entry) => ({ ...entry.check })) } : {}),
    }),
    /** Caller reports rejection and retries on its next maintenance heartbeat. */
    tick: (): Promise<void> => {
      if (stopped) return Promise.resolve();
      if (!task)
        task = step().finally(() => {
          task = undefined;
        });
      return task;
    },
    stop: async (): Promise<void> => {
      stopped = true;
      await task;
    },
  };
};
