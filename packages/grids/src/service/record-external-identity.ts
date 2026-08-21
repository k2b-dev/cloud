import { createHash } from "node:crypto";
import { scheduler } from "@k2b/sync";
import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { logger } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { RecordMutationAudit } from "../contracts";
import type { SqlClient } from "./audit";
import { listByTable as listFields } from "./fields";
import { notifyRecordEventOutbox } from "./record-event-outbox";
import type { AuthorizedRecordAccess } from "./record-access";
import { recordUniqueConflict } from "./record-unique-conflicts";
import { createInTransaction, updateInTransaction } from "./record-write";
import type { ExpansionViewer } from "./relations";

export const EXTERNAL_RECORD_OPERATION_RETENTION_DAYS = 30;
const EXTERNAL_RECORD_OPERATION_DELETE_BATCH = 10_000;
const externalRecordOperationScheduler = scheduler({ id: "grids:external-record-operation-retention" });
const log = logger("grids:external-record-operation-retention");

export type ExternalRecordIdentity = {
  provider: string;
  providerAccount: string;
  resourceKind: string;
  externalId: string;
};

export type ExternalRecordPutResult = {
  recordShortId: string;
  version: number;
  created: boolean;
  changed: boolean;
  replayed: boolean;
};

type ConflictKind = "capability" | "standard";
type InternalPutResult = ExternalRecordPutResult & { outboxId: string | null };
type StoredOutcome = {
  request_hash: string;
  record_short_id: string;
  result_version: number;
  created: boolean;
  changed: boolean;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const externalRecordRequestHash = (value: unknown): string => sha256(JSON.stringify(stableValue(value)));

export const restExternalRecordOperationScope = (
  identity: Pick<ExternalRecordIdentity, "provider" | "providerAccount" | "resourceKind">,
): string => `rest:${JSON.stringify([identity.provider, identity.providerAccount, identity.resourceKind])}`;

const identityScope = (identity: ExternalRecordIdentity): string =>
  JSON.stringify([identity.provider, identity.providerAccount, identity.resourceKind, identity.externalId]);

const operationConflict = (kind: ConflictKind) =>
  kind === "capability"
    ? { code: "IDEMPOTENCY_CONFLICT" as const, message: "Idempotency-Key was already used with different input", status: 409 as const }
    : err.conflict("This idempotency key was already used for a different external Record request.");

const validateOperation = (input: { operationScope: string; operationKey: string; requestHash: string }): Result<void> => {
  if (!input.operationScope || input.operationScope.length > 1_000 || input.operationScope.includes("\0")) {
    return fail(err.badInput("operationScope is invalid"));
  }
  if (!input.operationKey || input.operationKey.length > 200 || input.operationKey.includes("\0")) {
    return fail(err.badInput("operationKey must contain between 1 and 200 characters"));
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) return fail(err.badInput("requestHash is invalid"));
  return ok();
};

const validateIdentity = (identity: ExternalRecordIdentity): Result<void> => {
  const parts: Array<[string, string, number]> = [
    ["provider", identity.provider, 100],
    ["providerAccount", identity.providerAccount, 200],
    ["resourceKind", identity.resourceKind, 100],
    ["externalId", identity.externalId, 500],
  ];
  for (const [name, value, maxLength] of parts) {
    if (!value || value.length > maxLength || value.trim() !== value || value.includes("\0")) {
      return fail(err.badInput(`${name} must contain between 1 and ${maxLength} characters without surrounding whitespace or NUL`));
    }
  }
  return ok();
};

const lockAdmission = async (
  client: SqlClient,
  identity: ExternalRecordIdentity,
  operationScopeHash: string,
  operationKeyHash: string,
): Promise<void> => {
  await client`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:external-operation:${operationScopeHash}:${operationKeyHash}`}, 0))`;
  await client`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:external-record:${identityScope(identity)}`}, 0))`;
};

const storedOutcome = async (
  client: SqlClient,
  operationScopeHash: string,
  operationKeyHash: string,
): Promise<StoredOutcome | null> => {
  const [stored] = await client<StoredOutcome[]>`
    SELECT operation.request_hash, record.short_id AS record_short_id,
           operation.result_version, operation.created, operation.changed
    FROM grids.record_external_operations operation
    JOIN grids.record_external_bindings binding ON binding.id = operation.binding_id
    JOIN grids.records record ON record.id = binding.record_id
    WHERE operation.operation_scope_hash = ${operationScopeHash}
      AND operation.operation_key_hash = ${operationKeyHash}
  `;
  return stored ?? null;
};

const toReplay = (stored: StoredOutcome): ExternalRecordPutResult => ({
  recordShortId: stored.record_short_id,
  version: stored.result_version,
  created: stored.created,
  changed: stored.changed,
  replayed: true,
});

/** Check an immutable receipt before schema-dependent public Field IDs are resolved. */
export const replay = async (input: {
  operationScope: string;
  operationKey: string;
  requestHash: string;
  conflictKind?: ConflictKind;
}): Promise<Result<ExternalRecordPutResult | null>> => {
  const valid = validateOperation(input);
  if (!valid.ok) return valid;
  const stored = await storedOutcome(sql, sha256(input.operationScope), sha256(input.operationKey));
  if (!stored) return ok(null);
  return stored.request_hash === input.requestHash ? ok(toReplay(stored)) : fail(operationConflict(input.conflictKind ?? "standard"));
};

export const put = async (input: {
  tableId: string;
  identity: ExternalRecordIdentity;
  operationScope: string;
  operationKey: string;
  requestHash: string;
  conflictKind?: ConflictKind;
  values: Record<string, unknown>;
  ifVersion?: number;
  audit?: RecordMutationAudit;
  actorId: string | null;
  dateConfig?: DateContext;
  viewer?: ExpansionViewer;
  recordAccess?: AuthorizedRecordAccess;
}): Promise<Result<ExternalRecordPutResult>> => {
  const validOperation = validateOperation(input);
  if (!validOperation.ok) return validOperation;
  const validIdentity = validateIdentity(input.identity);
  if (!validIdentity.ok) return validIdentity;
  const operationScopeHash = sha256(input.operationScope);
  const operationKeyHash = sha256(input.operationKey);
  const transaction = await sql
    .begin(async (tx): Promise<Result<InternalPutResult>> => {
      await lockAdmission(tx, input.identity, operationScopeHash, operationKeyHash);
      const stored = await storedOutcome(tx, operationScopeHash, operationKeyHash);
      if (stored) {
        return stored.request_hash === input.requestHash
          ? ok({ ...toReplay(stored), outboxId: null })
          : fail(operationConflict(input.conflictKind ?? "standard"));
      }

      const [binding] = await tx<Array<{ id: string; table_id: string; record_id: string; deleted_at: string | null }>>`
        SELECT binding.id::text, binding.table_id::text, binding.record_id::text, record.deleted_at::text
        FROM grids.record_external_bindings binding
        JOIN grids.records record ON record.id = binding.record_id
        WHERE binding.provider = ${input.identity.provider}
          AND binding.provider_account = ${input.identity.providerAccount}
          AND binding.resource_kind = ${input.identity.resourceKind}
          AND binding.external_id = ${input.identity.externalId}
      `;

      if (binding) {
        if (binding.table_id !== input.tableId || binding.deleted_at) {
          return fail(err.conflict("This external identity is bound to a Record that is no longer available."));
        }
        if (input.ifVersion === undefined) {
          return fail(err.conflict("This external identity already exists; supply its current Record version to update it."));
        }
        const updated = await updateInTransaction(
          tx,
          input.tableId,
          binding.record_id,
          input.values,
          input.actorId,
          "direct",
          input.ifVersion,
          {
            dateConfig: input.dateConfig,
            viewer: input.viewer,
            audit: input.audit,
            recordAccess: input.recordAccess,
          },
        );
        if (!updated.ok) return updated;
        const changed = updated.data.outboxId !== null;
        await tx`
          INSERT INTO grids.record_external_operations (
            operation_scope_hash, operation_key_hash,
            binding_id, request_hash, result_version, created, changed
          ) VALUES (
            ${operationScopeHash}, ${operationKeyHash}, ${binding.id}::uuid, ${input.requestHash},
            ${updated.data.record.version}, FALSE, ${changed}
          )
        `;
        return ok({
          recordShortId: updated.data.record.shortId,
          version: updated.data.record.version,
          created: false,
          changed,
          replayed: false,
          outboxId: updated.data.outboxId,
        });
      }

      if (input.ifVersion !== undefined) {
        return fail(err.conflict("This external identity does not exist at the expected Record version."));
      }
      const created = await createInTransaction(tx, input.tableId, input.values, input.actorId, "direct", {
        dateConfig: input.dateConfig,
        viewer: input.viewer,
        recordAccess: input.recordAccess,
      });
      if (!created.ok) return created;
      const [newBinding] = await tx<Array<{ id: string }>>`
        INSERT INTO grids.record_external_bindings (
          provider, provider_account, resource_kind, external_id, table_id, record_id
        ) VALUES (
          ${input.identity.provider}, ${input.identity.providerAccount}, ${input.identity.resourceKind}, ${input.identity.externalId},
          ${input.tableId}::uuid, ${created.data.record.id}::uuid
        )
        RETURNING id::text
      `;
      if (!newBinding) throw new Error("external Record binding insert returned no row");
      await tx`
        INSERT INTO grids.record_external_operations (
          operation_scope_hash, operation_key_hash,
          binding_id, request_hash, result_version, created, changed
        ) VALUES (
          ${operationScopeHash}, ${operationKeyHash}, ${newBinding.id}::uuid, ${input.requestHash},
          ${created.data.record.version}, TRUE, TRUE
        )
      `;
      return ok({
        recordShortId: created.data.record.shortId,
        version: created.data.record.version,
        created: true,
        changed: true,
        replayed: false,
        outboxId: created.data.outboxId,
      });
    })
    .catch(async (error: unknown) => {
      const conflict = recordUniqueConflict<InternalPutResult>(error, await listFields(input.tableId));
      if (conflict) return conflict;
      throw error;
    });

  if (!transaction.ok) return transaction;
  if (transaction.data.outboxId) notifyRecordEventOutbox(transaction.data.outboxId);
  const { outboxId: _outboxId, ...result } = transaction.data;
  return ok(result);
};

export const deleteExpiredExternalRecordOperations = async (): Promise<number> => {
  const rows = await sql<{ id: string }[]>`
    WITH expired AS (
      SELECT id
      FROM grids.record_external_operations
      WHERE created_at < now() - (${EXTERNAL_RECORD_OPERATION_RETENTION_DAYS} * interval '1 day')
      ORDER BY created_at, id
      LIMIT ${EXTERNAL_RECORD_OPERATION_DELETE_BATCH}
    )
    DELETE FROM grids.record_external_operations operation
    USING expired
    WHERE operation.id = expired.id
    RETURNING operation.id::text
  `;
  if (rows.length > 0) log.info("Removed expired external Record operation receipts", { count: rows.length });
  return rows.length;
};

let retentionStarted = false;

export const startExternalRecordOperationRetention = async (): Promise<void> => {
  if (!retentionStarted) {
    externalRecordOperationScheduler.start();
    retentionStarted = true;
  }
  await externalRecordOperationScheduler.create({
    id: "grids:external-record-operations:cleanup",
    cron: "23 * * * *",
    tz: "UTC",
    meta: { appId: "grids", family: "maintenance", label: "External Record idempotency retention" },
    process: async () => ({ deleted: await deleteExpiredExternalRecordOperations() }),
    after: ({ ctx }) => {
      if (ctx.error && ctx.failureCount < 3) {
        ctx.reschedule({ delayMs: ctx.expBackoff({ baseMs: 5_000, maxMs: 60_000 }) });
        return;
      }
      if (ctx.error) {
        log.error("External Record idempotency retention exhausted retries", {
          failureCount: ctx.failureCount,
          error: ctx.error.message,
        });
        return;
      }
      if (ctx.data?.deleted === EXTERNAL_RECORD_OPERATION_DELETE_BATCH) ctx.reschedule({ delayMs: 0 });
    },
  });
};

export const stopExternalRecordOperationRetention = async (): Promise<void> => {
  if (!retentionStarted) return;
  await externalRecordOperationScheduler.stop();
  retentionStarted = false;
};
