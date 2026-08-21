import { createHash } from "node:crypto";
import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { RecordMutationAudit } from "../contracts";
import type { SqlClient } from "./audit";
import { listByTable as listFields } from "./fields";
import { notifyRecordEventOutbox } from "./record-event-outbox";
import { createInTransaction, updateInTransaction } from "./record-write";
import { get } from "./record-read";
import { recordUniqueConflict } from "./record-unique-conflicts";
import type { AuthorizedRecordAccess } from "./record-access";
import type { ExpansionViewer } from "./relations";
import type { GridRecord } from "./types";

export type ExternalRecordIdentity = {
  provider: string;
  providerAccount: string;
  resourceKind: string;
  externalId: string;
};

export type ExternalRecordPutResult = {
  record: GridRecord;
  created: boolean;
  changed: boolean;
  replayed: boolean;
};

type InternalPutResult = Omit<ExternalRecordPutResult, "record"> & {
  recordId: string;
  outboxId: string | null;
};

type StoredOutcome = {
  request_hash: string;
  table_id: string;
  record_id: string;
  deleted_at: string | null;
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

const requestHash = (input: {
  tableId: string;
  identity: ExternalRecordIdentity;
  values: Record<string, unknown>;
  ifVersion?: number;
  audit?: RecordMutationAudit;
}): string => sha256(JSON.stringify(stableValue(input)));

const operationScope = (identity: ExternalRecordIdentity): string =>
  JSON.stringify([identity.provider, identity.providerAccount, identity.resourceKind]);

const identityScope = (identity: ExternalRecordIdentity): string =>
  JSON.stringify([identity.provider, identity.providerAccount, identity.resourceKind, identity.externalId]);

const lockAdmission = async (client: SqlClient, identity: ExternalRecordIdentity, operationKeyHash: string): Promise<void> => {
  await client`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:external-operation:${operationScope(identity)}:${operationKeyHash}`}, 0))`;
  await client`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:external-record:${identityScope(identity)}`}, 0))`;
};

const unavailableBinding = () => fail(err.conflict("This external identity is bound to a Record that is no longer available."));

export const put = async (input: {
  tableId: string;
  identity: ExternalRecordIdentity;
  operationKey: string;
  values: Record<string, unknown>;
  ifVersion?: number;
  audit?: RecordMutationAudit;
  actorId: string | null;
  dateConfig?: DateContext;
  viewer?: ExpansionViewer;
  recordAccess?: AuthorizedRecordAccess;
}): Promise<Result<ExternalRecordPutResult>> => {
  const identityParts: Array<[string, string, number]> = [
    ["provider", input.identity.provider, 100],
    ["providerAccount", input.identity.providerAccount, 200],
    ["resourceKind", input.identity.resourceKind, 100],
    ["externalId", input.identity.externalId, 500],
  ];
  for (const [name, value, maxLength] of identityParts) {
    if (!value || value.length > maxLength || value.trim() !== value) {
      return fail(err.badInput(`${name} must contain between 1 and ${maxLength} characters without surrounding whitespace`));
    }
  }
  if (!input.operationKey || input.operationKey.length > 200) {
    return fail(err.badInput("operationKey must contain between 1 and 200 characters"));
  }
  const operationKeyHash = sha256(input.operationKey);
  const expectedRequestHash = requestHash({
    tableId: input.tableId,
    identity: input.identity,
    values: input.values,
    ifVersion: input.ifVersion,
    audit: input.audit,
  });
  const transaction = await sql
    .begin(async (tx): Promise<Result<InternalPutResult>> => {
      await lockAdmission(tx, input.identity, operationKeyHash);

      const [storedOperation] = await tx<StoredOutcome[]>`
        SELECT operation.request_hash, binding.table_id::text, binding.record_id::text,
               record.deleted_at::text, operation.created, operation.changed
        FROM grids.record_external_operations operation
        JOIN grids.record_external_bindings binding ON binding.id = operation.binding_id
        JOIN grids.records record ON record.id = binding.record_id
        WHERE operation.provider = ${input.identity.provider}
          AND operation.provider_account = ${input.identity.providerAccount}
          AND operation.resource_kind = ${input.identity.resourceKind}
          AND operation.operation_key_hash = ${operationKeyHash}
      `;
      if (storedOperation) {
        if (storedOperation.request_hash !== expectedRequestHash) {
          return fail(err.conflict("This idempotency key was already used for a different external Record request."));
        }
        if (storedOperation.table_id !== input.tableId || storedOperation.deleted_at) return unavailableBinding();
        return ok({
          recordId: storedOperation.record_id,
          created: storedOperation.created,
          changed: storedOperation.changed,
          replayed: true,
          outboxId: null,
        });
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
        if (binding.table_id !== input.tableId || binding.deleted_at) return unavailableBinding();
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
            provider, provider_account, resource_kind, operation_key_hash,
            binding_id, request_hash, created, changed
          ) VALUES (
            ${input.identity.provider}, ${input.identity.providerAccount}, ${input.identity.resourceKind}, ${operationKeyHash},
            ${binding.id}::uuid, ${expectedRequestHash}, FALSE, ${changed}
          )
        `;
        return ok({ recordId: binding.record_id, created: false, changed, replayed: false, outboxId: updated.data.outboxId });
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
          provider, provider_account, resource_kind, operation_key_hash,
          binding_id, request_hash, created, changed
        ) VALUES (
          ${input.identity.provider}, ${input.identity.providerAccount}, ${input.identity.resourceKind}, ${operationKeyHash},
          ${newBinding.id}::uuid, ${expectedRequestHash}, TRUE, TRUE
        )
      `;
      return ok({ recordId: created.data.record.id, created: true, changed: true, replayed: false, outboxId: created.data.outboxId });
    })
    .catch(async (error: unknown) => {
      const conflict = recordUniqueConflict<InternalPutResult>(error, await listFields(input.tableId));
      if (conflict) return conflict;
      throw error;
    });

  if (!transaction.ok) return transaction;
  const record = await get(input.tableId, transaction.data.recordId, {
    dateConfig: input.dateConfig,
    viewer: input.viewer,
    recordAccess: input.recordAccess,
  });
  if (!record) return unavailableBinding();
  if (transaction.data.outboxId) notifyRecordEventOutbox(transaction.data.outboxId);
  return ok({
    record,
    created: transaction.data.created,
    changed: transaction.data.changed,
    replayed: transaction.data.replayed,
  });
};
