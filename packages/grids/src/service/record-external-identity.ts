import { createHash } from "node:crypto";
import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import type { Worker } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import type { RecordMutationAudit } from "../contracts";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { listByTable as listFields } from "./fields";
import { notifyRecordEventOutbox } from "./record-event-outbox";
import { recordUniqueConflict } from "./record-unique-conflicts";
import { createInTransaction, updateInTransaction } from "./record-write";
import type { ExpansionViewer } from "./relations";

export const EXTERNAL_RECORD_OPERATION_RETENTION_DAYS = 30;
const EXTERNAL_RECORD_OPERATION_DELETE_BATCH = 10_000;
const externalRecordOperationScheduler = lazySync((sync) =>
  sync.scheduler({ id: "grids:external-record-operation-retention", delivery: { maxAttempts: 4, backoffMs: [5_000, 20_000, 60_000] } }),
);
let retentionWorker: Worker | undefined;
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

const operationConflict = (kind: ConflictKind, locale?: string) => {
  const messages = getGridsCrudMessages(locale);
  return kind === "capability"
    ? { code: "IDEMPOTENCY_CONFLICT" as const, message: messages.capabilityIdempotencyConflict, status: 409 as const }
    : err.conflict(messages.idempotencyConflict);
};

const validateOperation = (input: { operationScope: string; operationKey: string; requestHash: string; locale?: string }): Result<void> => {
  const messages = getGridsCrudMessages(input.locale);
  if (!input.operationScope || input.operationScope.length > 1_000 || input.operationScope.includes("\0")) {
    return fail(err.badInput(messages.operationScopeInvalid));
  }
  if (!input.operationKey || input.operationKey.length > 200 || input.operationKey.includes("\0")) {
    return fail(err.badInput(messages.operationKeyInvalid));
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) return fail(err.badInput(messages.requestHashInvalid));
  return ok();
};

const validateIdentity = (identity: ExternalRecordIdentity, locale?: string): Result<void> => {
  const messages = getGridsCrudMessages(locale);
  const parts: Array<[string, string, number]> = [
    ["provider", identity.provider, 100],
    ["providerAccount", identity.providerAccount, 200],
    ["resourceKind", identity.resourceKind, 100],
    ["externalId", identity.externalId, 500],
  ];
  for (const [name, value, maxLength] of parts) {
    if (!value || value.length > maxLength || value.trim() !== value || value.includes("\0")) {
      return fail(err.badInput(messages.boundedText({ name, max: maxLength })));
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

const storedOutcome = async (client: SqlClient, operationScopeHash: string, operationKeyHash: string): Promise<StoredOutcome | null> => {
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
  locale?: string;
}): Promise<Result<ExternalRecordPutResult | null>> => {
  const valid = validateOperation(input);
  if (!valid.ok) return valid;
  const stored = await storedOutcome(sql, sha256(input.operationScope), sha256(input.operationKey));
  if (!stored) return ok(null);
  return stored.request_hash === input.requestHash
    ? ok(toReplay(stored))
    : fail(operationConflict(input.conflictKind ?? "standard", input.locale));
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
  locale?: string;
}): Promise<Result<ExternalRecordPutResult>> => {
  const messages = getGridsCrudMessages(input.locale);
  const validOperation = validateOperation(input);
  if (!validOperation.ok) return validOperation;
  const validIdentity = validateIdentity(input.identity, input.locale);
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
          : fail(operationConflict(input.conflictKind ?? "standard", input.locale));
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
          return fail(err.conflict(messages.externalRecordUnavailable));
        }
        if (input.ifVersion === undefined) {
          return fail(err.conflict(messages.externalIdentityNeedsVersion));
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
            locale: input.locale,
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
        return fail(err.conflict(messages.externalIdentityVersionMissing));
      }
      const created = await createInTransaction(tx, input.tableId, input.values, input.actorId, "direct", {
        dateConfig: input.dateConfig,
        viewer: input.viewer,
        locale: input.locale,
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
      const conflict = recordUniqueConflict<InternalPutResult>(error, await listFields(input.tableId), input.locale);
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
    retentionWorker = await externalRecordOperationScheduler().process();
    retentionStarted = true;
  }
  await externalRecordOperationScheduler().create({
    id: "grids:external-record-operations:cleanup",
    cron: "23 * * * *",
    timezone: "UTC",
    meta: { appId: "grids", family: "maintenance", label: "External Record idempotency retention" },
    process: async (context) => {
      // A drain stops the loop between batches; the next slot resumes the backlog.
      while (!context.signal.aborted) {
        const deleted = await deleteExpiredExternalRecordOperations();
        if (deleted < EXTERNAL_RECORD_OPERATION_DELETE_BATCH) return;
        await context.heartbeat();
      }
    },
  });
};

export const stopExternalRecordOperationRetention = async (): Promise<void> => {
  if (!retentionStarted) return;
  await retentionWorker?.drain({ timeoutMs: 30_000 });
  retentionWorker = undefined;

  retentionStarted = false;
};
