import { sql } from "@k2b/cloud";
import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import type { z } from "zod";
import { accessActorUser, actorViewerFor, type GridsAccessContext, gateBaseAtAccess } from "../api/permissions";
import type { AtomicRecordsInputSchema, CorrectionDraftInputSchema, FinalizeRecordInputSchema } from "../integrity-contracts";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { type AtomicRecordRef, lockAtomicRecords } from "./atomic-record-locks";
import type { SqlClient } from "./audit";
import { canonicalJson } from "./document-json";
import { listByTable } from "./field-read";
import { buildTrustedGqlResolverContext } from "./gql-resolver-context";
import { fromPublicRelationValues } from "./public-resources";
import { bindQueryData, captureQueryData } from "./query-capture";
import { notifyRecordEventOutbox } from "./record-event-outbox";
import { finalizeInTransaction, getStatus, requestFinalizationInTransaction } from "./record-finalization";
import { createInTransaction, updateInTransaction } from "./record-write";
import { resultTransaction } from "./transaction-rollback";

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw result.error;
  return result.data;
};
const message = (locale: string | undefined, en: string, de: string) => (locale?.startsWith("de") ? de : en);
export type IntegrityContext = GridsAccessContext & {
  locale?: string;
  dateConfig: { timeZone: string; locale: string; firstDayOfWeek: 1 };
  signal: AbortSignal;
};
const actorId = (context: IntegrityContext) => accessActorUser(context)?.id ?? null;

export const integrityTable = async (client: SqlClient, id: string, context: IntegrityContext, baseId?: string) => {
  const [table] = await client<Array<{ id: string; base_id: string; short_id: string }>>`
    SELECT t.id::text, t.base_id::text, t.short_id FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.short_id = ${id} AND t.kind = 'stored' AND t.deleted_at IS NULL
      AND (${baseId ?? null}::uuid IS NULL OR t.base_id = ${baseId ?? null}::uuid)
  `;
  if (!table) throw err.notFound(message(context.locale, "Table", "Tabelle"));
  unwrap(await gateBaseAtAccess(context, table.base_id, "write", client));
  return table;
};
const record = async (client: SqlClient, tableId: string, id: string, context: IntegrityContext) => {
  const [row] = await client<Array<{ id: string; version: number; finalized_at: Date | null; data: Record<string, unknown> }>>`
    SELECT id::text, version, finalized_at, data FROM grids.records
    WHERE short_id = ${id} AND table_id = ${tableId}::uuid AND deleted_at IS NULL
  `;
  if (!row) throw err.notFound(message(context.locale, "Record", "Datensatz"));
  return row;
};
export const integrityValues = async (client: SqlClient, tableId: string, values: Record<string, unknown>, context: IntegrityContext) => {
  const fields = await listByTable(tableId, false, client);
  const byId = new Map(fields.map((field) => [field.shortId, field]));
  const internal: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) throw err.badInput(message(context.locale, "Unknown Field ID", "Unbekannte Feld-ID"));
    if (field.type === "relation" && typeof field.config.targetTableId === "string") {
      const [target] = await client<
        Array<{ base_id: string }>
      >`SELECT base_id::text FROM grids.tables WHERE id = ${field.config.targetTableId}::uuid AND deleted_at IS NULL`;
      if (!target) throw err.notFound("Table");
      unwrap(await gateBaseAtAccess(context, target.base_id, "read", client));
    }
    internal[field.id] = value;
  }
  return { fields, values: unwrap(await fromPublicRelationValues(fields, internal, {}, client)) };
};
const version = (current: number, expected: number, context: IntegrityContext) => {
  if (current !== expected)
    throw err.conflict(message(context.locale, "Record changed; read it again.", "Der Datensatz wurde geändert; bitte erneut lesen."));
};
const options = (context: IntegrityContext, beforeWrite: () => Promise<void>) => ({
  dateConfig: context.dateConfig,
  locale: context.locale,
  viewer: actorViewerFor(context),
  beforeWrite,
});
export const integrityAttempt = async <T>(work: () => Promise<Result<T>>): Promise<Result<T>> => {
  try {
    return await work();
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    throw error;
  }
};

const recordTransaction = async <T>(work: (client: SqlClient, notify: (id: string | null) => void) => Promise<Result<T>>) => {
  const outboxIds: string[] = [];
  const result = await integrityAttempt(() =>
    resultTransaction((client) =>
      work(client, (id) => {
        if (id) outboxIds.push(id);
      }),
    ),
  );
  if (result.ok) for (const id of outboxIds) notifyRecordEventOutbox(id);
  return result;
};

export const changeRecordsAtomically = (input: z.infer<typeof AtomicRecordsInputSchema>, context: IntegrityContext) =>
  recordTransaction(async (client, notify) => {
    context.signal.throwIfAborted();
    const [base] = await client<
      Array<{ id: string }>
    >`SELECT id::text FROM grids.bases WHERE short_id = ${input.baseId} AND deleted_at IS NULL`;
    if (!base) return fail(err.notFound("Base"));
    const authorize = async () => {
      context.signal.throwIfAborted();
      unwrap(await gateBaseAtAccess(context, base.id, "write", client));
    };
    await authorize();
    const tables = new Map<string, Awaited<ReturnType<typeof integrityTable>>>();
    for (const target of [...input.locks, ...input.checks.filter((check) => "tableId" in check), ...input.changes]) {
      if (!tables.has(target.tableId)) tables.set(target.tableId, await integrityTable(client, target.tableId, context, base.id));
    }
    const targets = [
      ...input.locks,
      ...input.checks.filter((check) => "tableId" in check),
      ...input.changes.filter((change) => change.kind === "update"),
    ];
    const locks: AtomicRecordRef[] = [];
    for (const target of targets) {
      const table = tables.get(target.tableId)!;
      const loaded = await record(client, table.id, target.recordId, context);
      locks.push({ tableId: table.id, recordId: loaded.id, required: "write" });
    }
    if (new Set(locks.map((lock) => lock.recordId)).size > 100) return fail(err.badInput("At most 100 distinct Record locks."));
    await lockAtomicRecords(
      client,
      locks,
      async () => {},
      [...tables.values()].map((table) => table.id),
    );
    await authorize();
    for (const check of input.checks) {
      if ("query" in check) {
        const parsed = parseGridsQueryDsl(check.query);
        if (!parsed.ok) throw err.badInput(message(context.locale, "Invalid assertion query.", "Ungültige Bedingungsabfrage."));
        const resolver = await buildTrustedGqlResolverContext({ baseId: base.id, ast: parsed.ast, purpose: "workflow-query", client });
        const bound = unwrap(bindQueryData(check.query, resolver, {}, context.locale));
        const captured = unwrap(
          await captureQueryData(
            {
              baseId: base.id,
              binding: bound.binding,
              values: {},
              timeZone: context.dateConfig.timeZone,
              locale: context.locale,
              signal: context.signal,
              createTableAccess: async (tx) => async (id) => {
                const [target] = await tx<
                  Array<{ base_id: string }>
                >`SELECT base_id::text FROM grids.tables WHERE id = ${id}::uuid AND deleted_at IS NULL`;
                return target?.base_id === base.id && (await gateBaseAtAccess(context, base.id, "read", tx)).ok;
              },
            },
            client,
          ),
        );
        if ((check.assert === "empty") !== (captured.rowCount === 0))
          throw err.conflict(message(context.locale, "Atomic assertion failed.", "Die atomare Bedingung ist nicht erfüllt."));
        continue;
      }
      const table = tables.get(check.tableId)!;
      const current = await record(client, table.id, check.recordId, context);
      version(current.version, check.ifVersion, context);
      if (check.values) {
        const expected = await integrityValues(client, table.id, check.values, context);
        // Relations are stored separately and are checked against their current ordered links.
        for (const [id, value] of Object.entries(expected.values)) {
          const field = expected.fields.find((field) => field.id === id)!;
          const actual =
            field.type === "relation"
              ? (
                  await client<
                    Array<{ id: string }>
                  >`SELECT to_record_id::text AS id FROM grids.record_links WHERE from_record_id = ${current.id}::uuid AND from_field_id = ${id}::uuid ORDER BY position`
                ).map((row) => row.id)
              : (current.data[id] ?? null);
          const normalized = field.type === "relation" ? (typeof value === "string" ? [value] : (value ?? [])) : value;
          if (canonicalJson({ value: actual }).sha256 !== canonicalJson({ value: normalized }).sha256)
            throw err.conflict(message(context.locale, "Atomic assertion failed.", "Die atomare Bedingung ist nicht erfüllt."));
        }
      }
    }
    const records: Array<{ id: string; tableId: string; version: number }> = [];
    for (const change of input.changes) {
      const table = tables.get(change.tableId)!;
      const values = await integrityValues(client, table.id, change.values, context);
      const opts = options(context, authorize);
      const result =
        change.kind === "create"
          ? await createInTransaction(client, table.id, values.values, actorId(context), "direct", opts)
          : await updateInTransaction(
              client,
              table.id,
              (await record(client, table.id, change.recordId, context)).id,
              values.values,
              actorId(context),
              "direct",
              change.ifVersion,
              { ...opts, audit: change.audit },
            );
      const effect = unwrap(result);
      notify(effect.outboxId);
      const changed = effect.record;
      records.push({ id: changed.shortId, tableId: table.short_id, version: changed.version });
    }
    return ok({ records });
  });

export const finalizeRecord = (input: z.infer<typeof FinalizeRecordInputSchema>, context: IntegrityContext, close = false) =>
  integrityAttempt(async () => {
    let outboxId: string | null = null;
    // Like approveFinalization, commit resolver housekeeping on a rejected stale request.
    // The domain finalizer rolls back rejected allocations with its own savepoint.
    const result = await sql.begin(
      async (client): Promise<Result<{ id: string; tableId: string; version: number; state: "requested" | "finalized" }>> => {
        const table = await integrityTable(client, input.tableId, context);
        const current = await record(client, table.id, input.recordId, context);
        await lockAtomicRecords(client, [{ tableId: table.id, recordId: current.id, required: "write" }], async () => {});
        version((await record(client, table.id, input.recordId, context)).version, input.ifVersion, context);
        const authorize = async () => {
          context.signal.throwIfAborted();
          unwrap(await gateBaseAtAccess(context, table.base_id, "write", client));
        };
        await authorize();
        const policy = unwrap(await getStatus(table.id, client, context.locale));
        if (!policy.enabled || policy.policyRevision !== input.expectedPolicyRevision)
          return fail(err.conflict(message(context.locale, "Finalization policy changed.", "Die Abschlussregel wurde geändert.")));
        if (close && policy.mode === "fourEyes" && !input.approvalRequestId) {
          const userId = actorId(context);
          if (!userId)
            return fail(
              err.forbidden(
                message(
                  context.locale,
                  "A person must request Four-eyes finalization.",
                  "Eine Person muss den Vier-Augen-Abschluss beantragen.",
                ),
              ),
            );
          unwrap(
            await requestFinalizationInTransaction(client, {
              tableId: table.id,
              recordId: current.id,
              actorId: userId,
              expectedPolicyRevision: input.expectedPolicyRevision,
              dateConfig: context.dateConfig,
              locale: context.locale,
            }),
          );
          return ok({ id: input.recordId, tableId: input.tableId, version: current.version, state: "requested" as const });
        }
        const finalized = await finalizeInTransaction(client, {
          tableId: table.id,
          recordId: current.id,
          actorId: actorId(context),
          origin: "direct",
          expectedPolicyRevision: input.expectedPolicyRevision,
          approvalRequestId: input.approvalRequestId,
          ...options(context, authorize),
        });
        if (!finalized.ok) return finalized;
        outboxId = finalized.data.outboxId;
        return ok({ id: input.recordId, tableId: input.tableId, version: finalized.data.record.version, state: "finalized" as const });
      },
    );
    if (result.ok && outboxId) notifyRecordEventOutbox(outboxId);
    return result;
  });

export const createCorrectionDraft = (input: z.infer<typeof CorrectionDraftInputSchema>, context: IntegrityContext) =>
  recordTransaction(async (client, notify) => {
    const table = await integrityTable(client, input.tableId, context);
    const original = await record(client, table.id, input.recordId, context);
    await lockAtomicRecords(client, [{ tableId: table.id, recordId: original.id, required: "read" }], async () => {});
    const current = await record(client, table.id, input.recordId, context);
    version(current.version, input.ifVersion, context);
    if (!current.finalized_at)
      return fail(err.conflict(message(context.locale, "The original must be finalized.", "Das Original muss abgeschlossen sein.")));
    const fields = await listByTable(table.id, false, client);
    const type = fields.find((field) => field.shortId === input.typeFieldId);
    const relation = fields.find((field) => field.shortId === input.originalFieldId);
    const option = type?.config.options;
    if (
      type?.type !== "select" ||
      type.config.multiple === true ||
      !Array.isArray(option) ||
      !option.some((value) => value && typeof value === "object" && "id" in value && value.id === input.typeValue) ||
      relation?.type !== "relation" ||
      relation.config.targetTableId !== table.id ||
      relation.config.cardinality !== "single"
    )
      return fail(err.badInput(message(context.locale, "Invalid correction Fields.", "Ungültige Korrekturfelder.")));
    if (input.typeFieldId in input.values || input.originalFieldId in input.values)
      return fail(
        err.badInput(
          message(
            context.locale,
            "Reserved correction Fields cannot be overridden.",
            "Reservierte Korrekturfelder dürfen nicht überschrieben werden.",
          ),
        ),
      );
    const values = await integrityValues(client, table.id, input.values, context);
    const beforeWrite = async () => {
      context.signal.throwIfAborted();
      unwrap(await gateBaseAtAccess(context, table.base_id, "write", client));
    };
    const created = unwrap(
      await createInTransaction(
        client,
        table.id,
        { ...values.values, [type.id]: [input.typeValue], [relation.id]: original.id },
        actorId(context),
        "direct",
        options(context, beforeWrite),
      ),
    );
    notify(created.outboxId);
    return ok({ id: created.record.shortId, tableId: input.tableId, version: created.record.version });
  });
