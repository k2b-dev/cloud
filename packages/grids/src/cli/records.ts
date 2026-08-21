import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { arg, command, confirmFlag, flag } from "@valentinkolb/cloud/cli";
import type {
  PublicGridRecord as GridRecord,
  PublicRecordChangeFeedItem,
  PublicRecordChangeFeedPage,
  PublicTableQueryResult as TableQueryResult,
} from "../api/public-dto";
import type { PublicRecordFinalizationReadiness, PublicRecordFinalizationRequest } from "../api/record-finalization";
import {
  type CombinedAuditResponse,
  type CreateRecordSnapshotResponse,
  combinedAuditRows,
  type GridFile,
  type GridFileListResponse,
  gridFileRows,
  normalizeRecordImportBody,
  type RecordAuditResponse,
  type RecordRevisionPage,
  type PublicRecordSnapshot as RecordSnapshot,
  type RecordSnapshotListResponse,
  recordRevisionRows,
  recordRows,
  snapshotRows,
} from "./records-support";
import {
  baseArgs,
  baseFlag,
  listFields,
  requirePublicId,
  resolveBaseFromCommand,
  resolveField,
  resolveTable,
  resolveTableFromFlags,
  tableArgs,
  tableFlag,
} from "./resources";
import {
  applyDefined,
  JSON_BODY_INPUT,
  jsonRequest,
  type MessageResponse,
  printCliStructured,
  printJsonOrMessage,
  printJsonOrTable,
  queryString,
  readApi,
  readJsonInput,
  requireRestArg,
  writeApiFile,
} from "./runtime";
import { printRecordShape, recordShapeForFields } from "./schema-support";

type RecordListBodyFlags = {
  source?: string;
  cursor?: string;
  limit?: number;
  q?: string;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  finalization?: "draft" | "awaiting-review" | "finalized";
};

type ExternalRecordPutResponse = {
  recordId: string;
  tableId: string;
  version: number;
  created: boolean;
  changed: boolean;
  replayed: boolean;
};

const AUDIT_INPUT = flag.input({
  name: "audit",
  fileName: "audit-file",
  valueLabel: "json",
  description: "Audit answers as JSON keyed by audit-question id",
});

export const composeRecordListBody = (query: Record<string, unknown>, flags: RecordListBodyFlags): Record<string, unknown> => {
  const recordMeta =
    query.recordMeta && typeof query.recordMeta === "object" && !Array.isArray(query.recordMeta)
      ? (query.recordMeta as Record<string, unknown>)
      : {};
  const finalizationRecordMeta = flags.finalization
    ? {
        ...recordMeta,
        finalizationStates: [flags.finalization === "awaiting-review" ? "awaitingReview" : flags.finalization],
      }
    : undefined;
  if (flags.source) {
    const sourceQuery = applyDefined({ ...query }, { recordMeta: finalizationRecordMeta });
    return { source: flags.source, query: Object.keys(sourceQuery).length > 0 ? sourceQuery : undefined, cursor: flags.cursor };
  }
  return {
    query: applyDefined(
      { ...query },
      {
        limit: flags.limit ?? (query.limit === undefined ? 100 : undefined),
        search: flags.q ? { q: flags.q } : undefined,
        includeDeleted: flags.includeDeleted ? true : undefined,
        deletedOnly: flags.deletedOnly ? true : undefined,
        recordMeta: finalizationRecordMeta,
      },
    ),
    cursor: flags.cursor,
  };
};

type RecordExportBodyFlags = {
  format?: "csv" | "json";
  delimiter?: string;
  markdown?: "raw" | "html";
  limit?: number;
  q?: string;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
};

const exportDelimiter = (value: string | undefined): string | undefined =>
  value === "comma" ? "," : value === "semicolon" ? ";" : value === "tab" ? "\t" : value === "pipe" ? "|" : value;

export const composeRecordExportBody = (suppliedBody: Record<string, unknown>, flags: RecordExportBodyFlags): Record<string, unknown> => {
  const body = { ...suppliedBody };
  const delimiter = exportDelimiter(flags.delimiter);
  const existingCsv = body.csv && typeof body.csv === "object" && !Array.isArray(body.csv) ? (body.csv as Record<string, unknown>) : {};
  applyDefined(body, {
    format: flags.format ?? (body.format === undefined ? "csv" : undefined),
    markdown: flags.markdown,
    csv: delimiter ? { ...existingCsv, delimiter } : undefined,
  });
  if (flags.q || flags.limit || flags.includeDeleted || flags.deletedOnly) {
    const existingQuery =
      body.query && typeof body.query === "object" && !Array.isArray(body.query) ? (body.query as Record<string, unknown>) : {};
    body.query = applyDefined(
      { ...existingQuery },
      {
        limit: flags.limit,
        search: flags.q ? { q: flags.q } : undefined,
        includeDeleted: flags.includeDeleted ? true : undefined,
        deletedOnly: flags.deletedOnly ? true : undefined,
      },
    );
  }
  return body;
};

export const recordCommands = [
  command("records changes", {
    summary: "Resume recent Record changes in a Base",
    description:
      "Returns public Record identities and versions from the last 30 days. Save the cursor and read current Record values separately.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      cursor: flag.string({ description: "Resume cursor from the previous page" }),
      limit: flag.int({ min: 1, max: 100, description: "Events in one page (default: 50)" }),
      all: flag.boolean({ description: "Follow cursors until the feed ends or --max-events is reached" }),
      maxEvents: flag.int({ name: "max-events", min: 1, max: 10_000, description: "Safety cap for --all (default: 10000)" }),
    },
    examples: [
      "cld grids records changes Operations --limit 100 --json",
      "cld grids records changes --base Operations --table Requests --cursor <cursor> --all --max-events 1000 --jsonl",
    ],
    async run({ ctx, args, flags }) {
      if (flags.maxEvents !== undefined && !flags.all) throw new Error("--max-events requires --all.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const table = await resolveTableFromFlags(ctx, base, flags.table);
      const pageSize = flags.limit ?? 50;
      const readPage = (cursor: string | undefined, limit: number) =>
        readApi<PublicRecordChangeFeedPage>(
          ctx,
          `/records/by-base/${encodeURIComponent(base.id)}/changes${queryString({
            tableId: table?.id,
            cursor,
            limit,
          })}`,
        );

      const maxEvents = flags.all ? (flags.maxEvents ?? 10_000) : pageSize;
      let payload = await readPage(flags.cursor, Math.min(pageSize, maxEvents));
      if (flags.all) {
        const items = [...payload.items];
        while (payload.hasMore && items.length < maxEvents) {
          if (!payload.cursor) throw new Error("Record change feed returned more events without a resume cursor.");
          const previousCursor = payload.cursor;
          payload = await readPage(previousCursor, Math.min(pageSize, maxEvents - items.length));
          if (payload.cursor === previousCursor && payload.hasMore) {
            throw new Error("Record change feed did not advance its resume cursor.");
          }
          items.push(...payload.items);
        }
        payload = { ...payload, items };
      }

      const rows = payload.items.map((item: PublicRecordChangeFeedItem) => ({
        occurredAt: item.occurredAt,
        type: item.type,
        tableId: item.tableId,
        recordId: item.recordId,
        version: item.version,
        deletedAt: item.deletedAt ?? "",
      }));
      printJsonOrTable(ctx, payload, rows, [
        { key: "occurredAt", label: "OCCURRED" },
        { key: "type", label: "TYPE" },
        { key: "tableId", label: "TABLE" },
        { key: "recordId", label: "RECORD" },
        { key: "version", label: "VERSION" },
        { key: "deletedAt", label: "DELETED" },
      ]);
      if (ctx.options.output === "text" && payload.cursor) ctx.print(`resume cursor: ${payload.cursor}`);
    },
  }),
  command("records shape", {
    summary: "Show the JSON payload shape for records in a table",
    description:
      "The create/update payload is a plain JSON object keyed by field public id. This command resolves the table and lists writable fields with examples.",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    examples: ["cld grids records shape Bookshop Authors", "cld grids records shape --base Bookshop --table Authors --json"],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      printRecordShape(ctx, recordShapeForFields(table, await listFields(ctx, table.id)));
    },
  }),
  command("records list", {
    summary: "List records in a table",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      q: flag.string({ aliases: ["query"], description: "Free-text record search" }),
      source: flag.string({ description: "GQL source for the table query" }),
      queryBody: flag.input({ name: "query-body", fileName: "query-body-file", valueLabel: "json" }),
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: 10_000, description: "Row limit (default: 100)" }),
      includeDeleted: flag.boolean({ name: "include-deleted", description: "Include deleted records" }),
      deletedOnly: flag.boolean({ name: "deleted-only", description: "Only deleted records" }),
      finalization: flag.enum(["draft", "awaiting-review", "finalized"] as const, {
        description: "Only Records in this Finalization state",
      }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const query = (await readJsonInput<Record<string, unknown>>(flags.queryBody, "record query JSON", false)) ?? {};
      const body = composeRecordListBody(query, flags);
      const payload = await readApi<TableQueryResult>(ctx, `/tables/${encodeURIComponent(table.id)}/query`, jsonRequest("POST", body));
      const items = payload.items ?? [];
      printJsonOrTable(ctx, payload, recordRows(items), [
        { key: "id", label: "ID" },
        { key: "version", label: "VERSION" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
      if (ctx.options.output !== "json" && payload.nextCursor) ctx.print(`next cursor: ${payload.nextCursor}`);
    },
  }),
  command("records query", {
    summary: "Run a structured table query",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      cursor: flag.string({ description: "Pagination cursor" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "table query JSON", true)) ?? {};
      if (flags.cursor) body.cursor = flags.cursor;
      const payload = await readApi<TableQueryResult>(ctx, `/tables/${encodeURIComponent(table.id)}/query`, jsonRequest("POST", body));
      if (!printCliStructured(ctx, payload)) printJsonOrTable(ctx, payload, recordRows(payload.items ?? []), [{ key: "id", label: "ID" }]);
    },
  }),
  command("records get", {
    summary: "Show a record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      includeDeleted: flag.boolean({ name: "include-deleted", description: "Allow live or deleted records" }),
      deletedOnly: flag.boolean({ name: "deleted-only", description: "Require a deleted record" }),
    },
    async run({ ctx, args, flags }) {
      if (flags.includeDeleted && flags.deletedOnly) throw new Error("Choose --include-deleted or --deleted-only, not both.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const record = await readApi<GridRecord>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}${queryString({
          includeDeleted: flags.includeDeleted ? "true" : undefined,
          deletedOnly: flags.deletedOnly ? "true" : undefined,
        })}`,
      );
      if (!printCliStructured(ctx, record)) {
        ctx.print(`${record.id} v${record.version}`);
        ctx.print(JSON.stringify(record.data, null, 2));
      }
    },
  }),
  command("records create", {
    summary: "Create a record",
    description:
      "Pass a JSON object keyed by field public id. Run `cld grids records shape <base> <table>` first for the exact writable keys.",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, body: JSON_BODY_INPUT },
    examples: [
      "cld grids records shape Bookshop Authors --json",
      'cld grids records create Bookshop Authors --body \'{"<field-id>":"Octavia Butler"}\'',
      "cld grids records create Bookshop Orders --body-file record.json",
    ],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const body = await readJsonInput<Record<string, unknown>>(flags.body, "record JSON", true);
      const record = await readApi<GridRecord>(ctx, `/records/by-table/${encodeURIComponent(table.id)}`, jsonRequest("POST", body));
      printJsonOrMessage(ctx, record, `Created record ${record.id}.`);
    },
  }),
  command("records upsert-external", {
    summary: "Create or conditionally update a record by external identity",
    description:
      "The provider, provider account, resource kind, and external id form one durable identity. " +
      "Reuse the idempotency key for an uncertain retry. Updating an existing binding requires --if-version.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      provider: flag.string({ required: true, description: "External system or connector name" }),
      providerAccount: flag.string({ name: "provider-account", required: true, description: "Provider account or tenant identity" }),
      resourceKind: flag.string({ name: "resource-kind", required: true, description: "External resource kind" }),
      externalId: flag.string({ name: "external-id", required: true, description: "Stable id in the external system" }),
      idempotencyKey: flag.string({
        name: "idempotency-key",
        required: true,
        description: "Stable key for this logical create or update request",
      }),
      ifVersion: flag.int({ name: "if-version", min: 1, description: "Required current Record version when the binding exists" }),
      audit: AUDIT_INPUT,
    },
    examples: [
      "cld grids records upsert-external Bookshop Authors --provider crm --provider-account main --resource-kind contact --external-id 003ABC --idempotency-key import-003ABC-v1 --body-file contact.json",
      "cld grids records upsert-external Bookshop Authors --provider crm --provider-account main --resource-kind contact --external-id 003ABC --idempotency-key import-003ABC-v2 --if-version 1 --body-file contact.json",
    ],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const values = await readJsonInput<Record<string, unknown>>(flags.body, "record JSON", true);
      const answers = await readJsonInput<Record<string, string>>(flags.audit, "record audit answers", false);
      if (!flags.idempotencyKey) throw new Error("Missing required flag --idempotency-key");
      const payload = await readApi<ExternalRecordPutResponse>(
        ctx,
        `/records/by-table/${encodeURIComponent(table.id)}/external`,
        jsonRequest(
          "PUT",
          {
            externalRef: {
              provider: flags.provider,
              providerAccount: flags.providerAccount,
              resourceKind: flags.resourceKind,
              externalId: flags.externalId,
            },
            values,
            ...(flags.ifVersion !== undefined ? { ifVersion: flags.ifVersion } : {}),
            ...(answers ? { audit: { answers } } : {}),
          },
          { "Idempotency-Key": flags.idempotencyKey },
        ),
      );
      const verb = payload.replayed ? "Replayed" : payload.created ? "Created" : payload.changed ? "Updated" : "Kept";
      printJsonOrMessage(ctx, payload, `${verb} record ${payload.recordId} at version ${payload.version}.`);
    },
  }),
  command("records import", {
    summary: "Import records atomically from JSON",
    description:
      'Pass a JSON array, or {"items":[...]}, where each item is a record payload keyed by field public id. The backend creates all records in one transaction.',
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, body: JSON_BODY_INPUT },
    examples: [
      "cld grids records shape Bookshop Authors --json",
      "cld grids records import Bookshop Authors --body-file records.json",
      "cat records.json | cld grids records import --base Bookshop --table Authors --stdin",
    ],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const body = normalizeRecordImportBody(await readJsonInput<unknown>(flags.body, "record import JSON", true));
      const payload = await readApi<{ items: GridRecord[] }>(
        ctx,
        `/records/by-table/${encodeURIComponent(table.id)}/import`,
        jsonRequest("POST", body),
      );
      printJsonOrTable(ctx, payload, recordRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "version", label: "VERSION" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("records export", {
    summary: "Export records to CSV or JSON",
    description:
      "Exports through the backend export endpoint. Pass --body/--body-file for full ExportBody control, or use --format with the default table query.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      format: flag.enum(["csv", "json"] as const, { description: "Export format (default: csv)" }),
      delimiter: flag.string({ description: "CSV delimiter: comma, semicolon, tab, pipe, or the literal delimiter" }),
      markdown: flag.enum(["raw", "html"] as const, { description: "Markdown export mode for long text fields" }),
      q: flag.string({ aliases: ["query"], description: "Free-text record search" }),
      limit: flag.int({ min: 1, max: 10_000, description: "Maximum exported rows" }),
      includeDeleted: flag.boolean({ name: "include-deleted", description: "Include deleted records" }),
      deletedOnly: flag.boolean({ name: "deleted-only", description: "Only deleted records" }),
      out: flag.string({ description: "Output file path" }),
    },
    examples: [
      "cld grids records export Bookshop Authors --format csv --out authors.csv",
      "cld grids records export Bookshop Authors --format json --limit 1000 --out authors.json",
      "cld grids records export --base Bookshop --table Authors --body-file export.json --out authors.csv",
    ],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const body = composeRecordExportBody(
        (await readJsonInput<Record<string, unknown>>(flags.body, "record export JSON", false)) ?? {},
        flags,
      );
      await writeApiFile(ctx, `/records/by-table/${encodeURIComponent(table.id)}/export`, jsonRequest("POST", body), flags.out);
    },
  }),
  command("records update", {
    summary: "Update a record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      body: JSON_BODY_INPUT,
      audit: AUDIT_INPUT,
      ifVersion: flag.int({ name: "if-version", min: 1, description: "Optimistic version guard" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const body = await readJsonInput<Record<string, unknown>>(flags.body, "record update JSON", true);
      const answers = await readJsonInput<Record<string, string>>(flags.audit, "record audit answers", false);
      const record = await readApi<GridRecord>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}`,
        jsonRequest(
          "PATCH",
          { values: body, audit: answers ? { answers } : undefined },
          flags.ifVersion !== undefined ? { "If-Match": String(flags.ifVersion) } : {},
        ),
      );
      printJsonOrMessage(ctx, record, `Updated record ${record.id}.`);
    },
  }),
  command("records finalize", {
    summary: "Finalize a record and make it permanently read-only",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      yes: confirmFlag("Permanently finalize this record"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to permanently finalize the record.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const record = await readApi<GridRecord>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/finalize`,
        jsonRequest("POST"),
      );
      printJsonOrMessage(ctx, record, `Finalized record ${record.id}.`);
    },
  }),
  command("records finalization request", {
    summary: "Request Four-eyes Finalization for one exact Record version",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      comment: flag.string({ description: "Optional context for the approver" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const request = await readApi<PublicRecordFinalizationRequest>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/finalization/request`,
        jsonRequest("POST", { comment: flags.comment?.trim() || null }),
      );
      printJsonOrMessage(ctx, request, `Requested Finalization for record ${recordId}.`);
    },
  }),
  command("records finalization approve", {
    summary: "Approve a different person's request and finalize the Record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      request: flag.string({ description: "Finalization request public id" }),
      comment: flag.string({ description: "Optional decision comment" }),
      yes: confirmFlag("Approve and permanently finalize the Record"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to approve and permanently finalize the Record.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      if (!flags.request) throw new Error("Pass --request with the Finalization request public id.");
      const requestId = requirePublicId(flags.request, "Finalization request id");
      const readiness = await readApi<PublicRecordFinalizationReadiness>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/finalization`,
      );
      if (readiness.request?.status !== "pending" || readiness.request.id !== requestId) {
        throw new Error("That Finalization request is no longer pending for this Record.");
      }
      const record = await readApi<GridRecord>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/finalization/approve`,
        jsonRequest("POST", { requestId, comment: flags.comment?.trim() || null }),
      );
      printJsonOrMessage(ctx, record, `Approved and finalized record ${record.id}.`);
    },
  }),
  command("records finalization reject", {
    summary: "Reject a Four-eyes Finalization request",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      request: flag.string({ description: "Finalization request public id" }),
      comment: flag.string({ description: "Optional decision comment" }),
      yes: confirmFlag("Reject the pending Finalization request"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to reject the Finalization request.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      if (!flags.request) throw new Error("Pass --request with the Finalization request public id.");
      const requestId = requirePublicId(flags.request, "Finalization request id");
      const readiness = await readApi<PublicRecordFinalizationReadiness>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/finalization`,
      );
      if (readiness.request?.status !== "pending" || readiness.request.id !== requestId) {
        throw new Error("That Finalization request is no longer pending for this Record.");
      }
      const request = await readApi<PublicRecordFinalizationRequest>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/finalization/reject`,
        jsonRequest("POST", { requestId, comment: flags.comment?.trim() || null }),
      );
      printJsonOrMessage(ctx, request, `Rejected Finalization for record ${recordId}.`);
    },
  }),
  command("records delete", {
    summary: "Move a record to trash",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      audit: AUDIT_INPUT,
      yes: confirmFlag("Move this record to trash"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to move the record to trash.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const answers = await readJsonInput<Record<string, string>>(flags.audit, "record audit answers", false);
      await readApi<MessageResponse>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/trash`,
        jsonRequest("POST", { audit: answers ? { answers } : undefined }),
      );
      printJsonOrMessage(ctx, { deleted: recordId }, `Moved record ${recordId} to trash.`);
    },
  }),
  command("records restore", {
    summary: "Restore a record from trash",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, record: flag.string({ description: "Record public id" }), audit: AUDIT_INPUT },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const answers = await readJsonInput<Record<string, string>>(flags.audit, "record audit answers", false);
      await readApi<MessageResponse>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/restore`,
        jsonRequest("POST", { audit: answers ? { answers } : undefined }),
      );
      printJsonOrMessage(ctx, { restored: recordId }, `Restored record ${recordId}.`);
    },
  }),
  command("records audit", {
    summary: "Show record audit entries",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, record: flag.string({ description: "Record public id" }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const payload = await readApi<RecordAuditResponse>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/audit`,
      );
      if (!printCliStructured(ctx, payload)) ctx.table(payload.items as Record<string, unknown>[], []);
    },
  }),
  command("records audit list", {
    summary: "Browse a Combined table's published audit trail",
    description:
      "Lists lifecycle events from the active Combined publication. Only canonical fields, declared audit answers, and safe source labels are returned.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Filter by record public id" }),
      source: flag.string({ description: "Filter by source reference from a previous page" }),
      action: flag.enum(["created", "updated", "deleted", "restored", "imported"] as const, {
        description: "Filter by lifecycle action",
      }),
      from: flag.string({ description: "Inclusive ISO timestamp" }),
      to: flag.string({ description: "Exclusive ISO timestamp" }),
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: 200, description: "Events per page (default: 50)" }),
    },
    examples: [
      'cld grids records audit list Reporting "All inventory"',
      'cld grids records audit list Reporting "All inventory" --action deleted --json',
      'cld grids records audit list --base Reporting --table "All inventory" --cursor <cursor>',
    ],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const payload = await readApi<CombinedAuditResponse>(
        ctx,
        `/records/by-table/${encodeURIComponent(table.id)}/audit${queryString({
          recordId: flags.record,
          sourceRef: flags.source,
          action: flags.action,
          from: flags.from,
          to: flags.to,
          cursor: flags.cursor,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, payload, combinedAuditRows(payload.items), [
        { key: "createdAt", label: "TIME" },
        { key: "action", label: "ACTION" },
        { key: "recordId", label: "RECORD" },
        { key: "source", label: "SOURCE" },
        { key: "actor", label: "ACTOR" },
        { key: "answers", label: "AUDIT ANSWERS" },
        { key: "changes", label: "CHANGES" },
        { key: "deleted", label: "DELETED" },
      ]);
      if (ctx.options.output !== "json" && payload.nextCursor) ctx.print(`next cursor: ${payload.nextCursor}`);
    },
  }),
  command("records versions", {
    summary: "List durable versions of one record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: 50, description: "Versions per page (default: 20)" }),
    },
    examples: [
      "cld grids records versions Bookshop Authors <record-id>",
      "cld grids records versions --base Bookshop --table Authors --record <record-id> --json",
    ],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.record ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const payload = await readApi<RecordRevisionPage>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/versions${queryString({
          cursor: flags.cursor,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, payload, recordRevisionRows(payload.items), [
        { key: "revision", label: "REV" },
        { key: "action", label: "ACTION" },
        { key: "recordVersion", label: "RECORD VERSION" },
        { key: "changedFields", label: "FIELDS" },
        { key: "files", label: "FILES" },
        { key: "actor", label: "ACTOR" },
        { key: "createdAt", label: "CREATED" },
        { key: "id", label: "ID" },
      ]);
      if (ctx.options.output !== "json" && payload.nextCursor) ctx.print(`next cursor: ${payload.nextCursor}`);
    },
  }),
  command("records versions download", {
    summary: "Download a file retained by a durable record version",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      revision: flag.string({ description: "Record revision public id" }),
      file: flag.string({ description: "File public id from the version" }),
      out: flag.string({ description: "Output file path" }),
    },
    async run({ ctx, args, flags }) {
      const missingTrailingArgs = [flags.table, flags.record, flags.revision, flags.file].filter((value) => value === undefined).length;
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, missingTrailingArgs);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const offset = flags.table ? 0 : 1;
      const recordId = requirePublicId(flags.record ?? requireRestArg(rest, offset, "record"), "Record id");
      const revisionId = requirePublicId(flags.revision ?? requireRestArg(rest, offset + 1, "revision"), "Revision id");
      const fileId = requirePublicId(flags.file ?? requireRestArg(rest, offset + 2, "file"), "File id");
      await writeApiFile(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/versions/${encodeURIComponent(revisionId)}/files/${encodeURIComponent(fileId)}`,
        undefined,
        flags.out,
      );
    },
  }),
  command("records files list", {
    summary: "List files stored in one record file field",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      field: flag.string({ description: "File field public id or exact name" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table && flags.record && flags.field ? 0 : 3);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const fieldRef = flags.field ?? requireRestArg(flags.table ? rest.slice(1) : rest.slice(2), 0, "field");
      const field = await resolveField(ctx, table.id, fieldRef);
      const payload = await readApi<GridFileListResponse>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/files/${encodeURIComponent(field.id)}`,
      );
      printJsonOrTable(ctx, payload, gridFileRows(payload.items), [
        { key: "filename", label: "FILE" },
        { key: "mimeType", label: "MIME" },
        { key: "sizeBytes", label: "BYTES" },
        { key: "id", label: "ID" },
      ]);
    },
  }),
  command("records files upload", {
    summary: "Upload a local file into one record file field",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      field: flag.string({ description: "File field public id or exact name" }),
      file: flag.string({ description: "Local file path" }),
      filename: flag.string({ description: "Stored filename override" }),
      mimeType: flag.string({ name: "mime-type", description: "MIME type override" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table && flags.record && flags.field ? 0 : 3);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const fieldRef = flags.field ?? requireRestArg(flags.table ? rest.slice(1) : rest.slice(2), 0, "field");
      const filePath = flags.file ?? requireRestArg(flags.table ? rest.slice(2) : rest.slice(3), 0, "file");
      const field = await resolveField(ctx, table.id, fieldRef);
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: flags.mimeType ?? "application/octet-stream" }), flags.filename ?? basename(filePath));
      const file = await readApi<GridFile>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/files/${encodeURIComponent(field.id)}`,
        { method: "POST", body: form },
      );
      printJsonOrMessage(ctx, file, `Uploaded ${file.filename} (${file.id}).`);
    },
  }),
  command("records files replace", {
    summary: "Replace one record file attachment atomically",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      field: flag.string({ description: "File field public id or exact name" }),
      current: flag.string({ description: "Current file public id" }),
      file: flag.string({ description: "Replacement local file path" }),
      filename: flag.string({ description: "Stored filename override" }),
      mimeType: flag.string({ name: "mime-type", description: "MIME type override" }),
    },
    async run({ ctx, args, flags }) {
      const requiredTrailingArgs = [flags.table, flags.record, flags.field, flags.current, flags.file].filter(
        (value) => value === undefined,
      ).length;
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, requiredTrailingArgs);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const fieldRef = flags.field ?? requireRestArg(flags.table ? rest.slice(1) : rest.slice(2), 0, "field");
      const currentFileId = requirePublicId(
        flags.current ?? requireRestArg(flags.table ? rest.slice(2) : rest.slice(3), 0, "current file"),
        "File id",
      );
      const filePath = flags.file ?? requireRestArg(flags.table ? rest.slice(3) : rest.slice(4), 0, "replacement file");
      const field = await resolveField(ctx, table.id, fieldRef);
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: flags.mimeType ?? "application/octet-stream" }), flags.filename ?? basename(filePath));
      const file = await readApi<GridFile>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/files/${encodeURIComponent(field.id)}/${encodeURIComponent(currentFileId)}`,
        { method: "PUT", body: form },
      );
      printJsonOrMessage(ctx, file, `Replaced attachment with ${file.filename} (${file.id}).`);
    },
  }),
  command("records files download", {
    summary: "Download one file-field blob",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      field: flag.string({ description: "File field public id or exact name" }),
      file: flag.string({ description: "File public id" }),
      inline: flag.boolean({ description: "Request inline disposition" }),
      out: flag.string({ description: "Output file path" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table && flags.record && flags.field && flags.file ? 0 : 4);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const fieldRef = flags.field ?? requireRestArg(flags.table ? rest.slice(1) : rest.slice(2), 0, "field");
      const fileId = requirePublicId(flags.file ?? requireRestArg(flags.table ? rest.slice(2) : rest.slice(3), 0, "file"), "File id");
      const field = await resolveField(ctx, table.id, fieldRef);
      await writeApiFile(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/files/${encodeURIComponent(field.id)}/${encodeURIComponent(fileId)}/content${queryString({ inline: flags.inline ? true : undefined })}`,
        undefined,
        flags.out,
      );
    },
  }),
  command("records files delete", {
    summary: "Remove one file attachment from the current record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      record: flag.string({ description: "Record public id" }),
      field: flag.string({ description: "File field public id or exact name" }),
      file: flag.string({ description: "File public id" }),
      yes: confirmFlag("Remove this attachment from the current record"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to remove the attachment from the current record.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table && flags.record && flags.field && flags.file ? 0 : 4);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const fieldRef = flags.field ?? requireRestArg(flags.table ? rest.slice(1) : rest.slice(2), 0, "field");
      const fileId = requirePublicId(flags.file ?? requireRestArg(flags.table ? rest.slice(2) : rest.slice(3), 0, "file"), "File id");
      const field = await resolveField(ctx, table.id, fieldRef);
      await readApi<MessageResponse>(
        ctx,
        `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}/files/${encodeURIComponent(field.id)}/${encodeURIComponent(fileId)}`,
        jsonRequest("DELETE"),
      );
      printJsonOrMessage(ctx, { removed: fileId }, `Removed attachment ${fileId} from the current record.`);
    },
  }),
];

export const snapshotCommands = [
  command("snapshots list", {
    summary: "List manual recursive snapshots for one record",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, record: flag.string({ description: "Record public id" }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table && flags.record ? 0 : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const payload = await readApi<RecordSnapshotListResponse>(
        ctx,
        `/documents/snapshots/by-record/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}`,
      );
      printJsonOrTable(ctx, payload, snapshotRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "recordId", label: "RECORD" },
        { key: "createdAt", label: "CREATED" },
        { key: "createdBy", label: "BY" },
      ]);
    },
  }),
  command("snapshots create", {
    summary: "Create a manual recursive record snapshot",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, record: flag.string({ description: "Record public id" }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table && flags.record ? 0 : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const recordId = requirePublicId(flags.record ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "record"), "Record id");
      const payload = await readApi<CreateRecordSnapshotResponse>(
        ctx,
        `/documents/snapshots/by-record/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}`,
        jsonRequest("POST"),
      );
      printJsonOrMessage(ctx, payload, `Created snapshot ${payload.snapshot.id}.`);
    },
  }),
  command("snapshots get", {
    summary: "Show one record snapshot",
    args: { snapshot: arg.required({ description: "Snapshot public id" }) },
    async run({ ctx, args }) {
      const snapshot = await readApi<RecordSnapshot>(
        ctx,
        `/documents/snapshots/${encodeURIComponent(requirePublicId(args.snapshot, "Snapshot id"))}`,
      );
      if (!printCliStructured(ctx, snapshot)) {
        ctx.print(`${snapshot.id}`);
        ctx.print(`record: ${snapshot.recordId}`);
        ctx.print(`created: ${snapshot.createdAt}`);
        ctx.print(JSON.stringify({ root: snapshot.root, graph: snapshot.graph }, null, 2));
      }
    },
  }),
];
