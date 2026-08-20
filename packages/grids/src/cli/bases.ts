import { arg, command, confirmFlag, flag, paginationFlags } from "@valentinkolb/cloud/cli";
import type { PublicBase as Base, PublicField as Field, PublicTable as Table } from "../api/public-dto";
import type { ControlledDestructionOverview, ControlledDestructionRun } from "../controlled-destruction-contracts";
import type { PreservationHold, PreservationHoldsResponse } from "../preservation-hold-contracts";
import {
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type RetentionFilesResponse,
  type RetentionPolicy,
  type RetentionPreview,
  type RetentionRecordsResponse,
} from "../retention-policy-contracts";
import {
  baseArgs,
  baseFlag,
  baseRows,
  GRIDS_BASE_DEFAULT_KEY,
  listBases,
  requireDefaultBaseRef,
  requirePublicId,
  resolveBase,
  resolveBaseFromCommand,
  resolveTablePublicRefFromSearch,
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

type TrashedForm = {
  id: string;
  tableId: string;
  name: string;
  deletedAt: string | null;
};

type BaseTrash = {
  tables: Table[];
  fields: Field[];
  forms: TrashedForm[];
};

type RetentionPolicyResponse = { policy: RetentionPolicy | null };

const destructionRows = (run: ControlledDestructionRun) =>
  run.items.map((item) => ({
    fileId: item.fileId,
    table: `${item.tableName} (${item.tableId})`,
    filename: item.filename,
    sizeBytes: item.sizeBytes,
    status: item.status,
    message: item.message ?? "-",
  }));

const trashRows = (trash: BaseTrash) => [
  ...trash.tables.map((item) => ({ kind: "table", name: item.name, parent: "-", deletedAt: item.deletedAt, id: item.id })),
  ...trash.fields.map((item) => ({
    kind: "field",
    name: item.name,
    parent: item.tableId,
    deletedAt: item.deletedAt,
    id: item.id,
  })),
  ...trash.forms.map((item) => ({
    kind: "form",
    name: item.name,
    parent: item.tableId,
    deletedAt: item.deletedAt,
    id: item.id,
  })),
];

export const baseCrudCommands = [
  command("list", {
    summary: "List Grids bases",
    flags: {
      q: flag.string({ aliases: ["query"], description: "Search bases" }),
      ...paginationFlags({ defaultPerPage: 100, maxPerPage: 500 }),
    },
    async run({ ctx, flags }) {
      const perPage = flags.perPage ?? 100;
      const page = flags.page ?? 1;
      const payload = await listBases(ctx, { q: flags.q, limit: perPage, offset: (page - 1) * perPage });
      printJsonOrTable(ctx, payload, baseRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "description", label: "DESCRIPTION" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("use", {
    summary: "Set the default Grids base",
    args: { base: arg.required({ description: "Base public id or exact name" }) },
    async run({ ctx, args }) {
      const base = await resolveBase(ctx, args.base);
      const id = base.id;
      await ctx.setDefault(GRIDS_BASE_DEFAULT_KEY, id);
      printJsonOrMessage(ctx, { base, defaultBase: id }, `Using Grids base ${base.name} (${id}).`);
    },
  }),
  command("current", {
    summary: "Show the default Grids base",
    async run({ ctx }) {
      const base = await resolveBase(ctx, await requireDefaultBaseRef(ctx));
      const id = base.id;
      printJsonOrMessage(ctx, { base, defaultBase: id }, `${base.name} (${id})`);
    },
  }),
  command("bases list", {
    summary: "List Grids bases",
    flags: {
      q: flag.string({ aliases: ["query"], description: "Search bases" }),
      ...paginationFlags({ defaultPerPage: 100, maxPerPage: 500 }),
    },
    async run({ ctx, flags }) {
      const perPage = flags.perPage ?? 100;
      const page = flags.page ?? 1;
      const payload = await listBases(ctx, { q: flags.q, limit: perPage, offset: (page - 1) * perPage });
      printJsonOrTable(ctx, payload, baseRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "description", label: "DESCRIPTION" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("bases get", {
    summary: "Show a Grids base",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      if (!printCliStructured(ctx, base)) {
        ctx.print(`${base.name} (${base.id})`);
        if (base.description) ctx.print(base.description);
        ctx.print(`id: ${base.id}`);
        ctx.print(`updated: ${base.updatedAt}`);
      }
    },
  }),
  command("bases trash", {
    summary: "List deleted resources that can be restored in a base",
    description:
      "Requires base admin access. Parent tables contain their own deleted fields and forms, so nested items are not duplicated.",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const trash = await readApi<BaseTrash>(ctx, `/bases/${encodeURIComponent(base.id)}/trash`);
      printJsonOrTable(ctx, trash, trashRows(trash), [
        { key: "kind", label: "TYPE" },
        { key: "name", label: "NAME" },
        { key: "parent", label: "PARENT TABLE" },
        { key: "deletedAt", label: "DELETED" },
        { key: "id", label: "ID" },
      ]);
    },
  }),
  command("bases retention", {
    summary: "Show the retention floor for a Grids base",
    description: "Requires base admin access. The floor preserves trashed Records and newly unreferenced Files without deleting data.",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const payload = await readApi<RetentionPolicyResponse>(ctx, `/bases/${encodeURIComponent(base.id)}/retention-policy`);
      if (!printCliStructured(ctx, payload)) {
        ctx.print(
          payload.policy
            ? `Minimum retention for ${base.name} (${base.id}): ${payload.policy.minimumDays} days.`
            : `No minimum retention is configured for ${base.name} (${base.id}).`,
        );
      }
    },
  }),
  command("bases retention preview", {
    summary: "Preview a retention floor for a Grids base",
    description: "Returns a bounded impact at one observation time. Reaching the floor never deletes a Record or File.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      days: flag.int({ required: true, min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS, description: "Minimum retention days" }),
    },
    async run({ ctx, args, flags }) {
      const minimumDays = flags.days;
      if (minimumDays === undefined) throw new Error("Pass --days <number>.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const preview = await readApi<RetentionPreview>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/retention-policy/preview`,
        jsonRequest("POST", { minimumDays }),
      );
      if (printCliStructured(ctx, preview)) return;
      ctx.print(
        `${preview.counts.retainedUntilLater} retained until later; ${preview.counts.floorReached} reached the floor; ${preview.counts.protectedFinalized} finalized and independently protected; ${preview.counts.trashedRecords} total in trash.`,
      );
      ctx.print(
        `${preview.files.counts.retainedUntilLater} unreferenced Files retained until later; ${preview.files.counts.floorReached} reached the floor; ${preview.files.counts.unreferenced} total (${preview.files.counts.sizeBytes} bytes).`,
      );
      ctx.print(
        `Observed ${preview.observedAt}.${preview.truncated || preview.files.truncated ? " At least one example list is bounded." : ""}`,
      );
      if (preview.examples.length > 0) {
        ctx.table(preview.examples, [
          { key: "recordId", label: "RECORD" },
          { key: "tableId", label: "TABLE" },
          { key: "deletedAt", label: "TRASHED" },
          { key: "notBefore", label: "FLOOR REACHED" },
        ]);
      }
      if (preview.files.examples.length > 0) {
        ctx.table(preview.files.examples, [
          { key: "fileId", label: "FILE" },
          { key: "filename", label: "FILENAME" },
          { key: "sizeBytes", label: "BYTES" },
          { key: "unreferencedAt", label: "UNREFERENCED" },
          { key: "notBefore", label: "FLOOR REACHED" },
        ]);
      }
    },
  }),
  command("bases retention files list", {
    summary: "List unreferenced Files under a retention floor",
    description: "Requires Base admin access. Search, status filtering, and pagination run on the server.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      days: flag.int({ required: true, min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS, description: "Minimum retention days" }),
      search: flag.string({ description: "Search filename or File public id" }),
      status: flag.enum(["all", "retained", "reached"] as const, { default: "all", description: "Retention floor status" }),
      ...paginationFlags({ defaultPerPage: 25, maxPerPage: 100 }),
    },
    async run({ ctx, args, flags }) {
      const minimumDays = flags.days;
      if (minimumDays === undefined) throw new Error("Pass --days <number>.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const page = flags.page ?? 1;
      const perPage = flags.perPage ?? 25;
      const payload = await readApi<RetentionFilesResponse>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/retention-policy/files${queryString({
          minimumDays,
          search: flags.search,
          status: flags.status,
          page,
          per_page: perPage,
        })}`,
      );
      printJsonOrTable(
        ctx,
        payload,
        payload.items.map((item) => ({
          id: item.fileId,
          filename: item.filename,
          type: item.mimeType,
          bytes: item.sizeBytes,
          status: item.status,
          unreferencedAt: item.unreferencedAt,
          notBefore: item.notBefore,
        })),
        [
          { key: "id", label: "FILE" },
          { key: "filename", label: "FILENAME" },
          { key: "type", label: "TYPE" },
          { key: "bytes", label: "BYTES" },
          { key: "status", label: "STATUS" },
          { key: "unreferencedAt", label: "UNREFERENCED" },
          { key: "notBefore", label: "FLOOR REACHED" },
        ],
      );
    },
  }),
  command("bases retention records list", {
    summary: "List trashed Records under a retention floor",
    description: "Requires Base admin access. Search, status filtering, and pagination run on the server.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      days: flag.int({ required: true, min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS, description: "Minimum retention days" }),
      search: flag.string({ description: "Search Record id, Table id, or Table name" }),
      status: flag.enum(["all", "protected", "retained", "reached"] as const, {
        default: "all",
        description: "Retention floor status",
      }),
      ...paginationFlags({ defaultPerPage: 25, maxPerPage: 100 }),
    },
    async run({ ctx, args, flags }) {
      const minimumDays = flags.days;
      if (minimumDays === undefined) throw new Error("Pass --days <number>.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const payload = await readApi<RetentionRecordsResponse>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/retention-policy/records${queryString({
          minimumDays,
          search: flags.search,
          status: flags.status,
          page: flags.page ?? 1,
          per_page: flags.perPage ?? 25,
        })}`,
      );
      printJsonOrTable(
        ctx,
        payload,
        payload.items.map((item) => ({
          id: item.recordId,
          table: item.tableName,
          tableId: item.tableId,
          status: item.status,
          deletedAt: item.deletedAt,
          notBefore: item.notBefore ?? "-",
        })),
        [
          { key: "id", label: "RECORD" },
          { key: "table", label: "TABLE" },
          { key: "tableId", label: "TABLE ID" },
          { key: "status", label: "STATUS" },
          { key: "deletedAt", label: "TRASHED" },
          { key: "notBefore", label: "FLOOR REACHED" },
        ],
      );
    },
  }),
  command("bases retention files download", {
    summary: "Download one unreferenced retained File",
    description: "Requires Base admin access and a File public id from `bases retention files list`.",
    args: baseArgs,
    flags: { ...baseFlag, out: flag.string({ aliases: ["o"], required: true, description: "Output file path" }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const fileId = requirePublicId(requireRestArg(rest, 0, "File public id"), "File id");
      await writeApiFile(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/retention-policy/files/${encodeURIComponent(fileId)}/content`,
        undefined,
        flags.out,
      );
    },
  }),
  command("bases retention set", {
    summary: "Set the retention floor for a Grids base",
    description: "Requires --yes only when shortening an existing floor. Saving never deletes Records or Files or starts cleanup.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      days: flag.int({ required: true, min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS, description: "Minimum retention days" }),
      yes: confirmFlag("Shorten the existing retention floor"),
    },
    async run({ ctx, args, flags }) {
      const minimumDays = flags.days;
      if (minimumDays === undefined) throw new Error("Pass --days <number>.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const current = await readApi<RetentionPolicyResponse>(ctx, `/bases/${encodeURIComponent(base.id)}/retention-policy`);
      if (current.policy && minimumDays < current.policy.minimumDays && !flags.yes) {
        throw new Error("Pass --yes to shorten the existing retention floor.");
      }
      const updated = await readApi<RetentionPolicyResponse>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/retention-policy`,
        jsonRequest("PUT", { minimumDays }),
      );
      printJsonOrMessage(ctx, updated, `Minimum retention for ${base.name} (${base.id}) set to ${minimumDays} days.`);
    },
  }),
  command("bases retention remove", {
    summary: "Remove the retention floor from a Grids base",
    description: "Removing the floor may allow future controlled destruction earlier. It does not delete anything now.",
    args: baseArgs,
    flags: { ...baseFlag, yes: confirmFlag("Remove the retention floor") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to remove the retention floor.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      await readApi<void>(ctx, `/bases/${encodeURIComponent(base.id)}/retention-policy`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { removed: true, baseId: base.id }, `Removed minimum retention from ${base.name} (${base.id}).`);
    },
  }),
  command("bases preservation-holds list", {
    summary: "List preservation holds",
    description: "Requires Base admin access. Status, scope, table filtering, and pagination run on the server.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      status: flag.enum(["active", "released", "all"] as const, { default: "active", description: "Hold status" }),
      scope: flag.enum(["base", "table", "all"] as const, { default: "all", description: "Hold scope" }),
      table: flag.string({ description: "Filter by Table public id or exact name; requires --scope table" }),
      ...paginationFlags({ defaultPerPage: 25, maxPerPage: 100 }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      if (flags.table && flags.scope !== "table") throw new Error("--table requires --scope table.");
      const tableId = flags.table ? await resolveTablePublicRefFromSearch(ctx, base.id, flags.table) : null;
      const payload = await readApi<PreservationHoldsResponse>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/preservation-holds${queryString({
          status: flags.status,
          scope: flags.scope,
          tableId,
          page: flags.page ?? 1,
          per_page: flags.perPage ?? 25,
        })}`,
      );
      const rows = payload.items.map((item) => ({
        id: item.id,
        scope: item.scope.type === "base" ? "Base" : `Table: ${item.scope.tableName} (${item.scope.tableId})`,
        status: item.status,
        reason: item.reason,
        createdBy: item.createdByDisplayName ?? "-",
        createdAt: item.createdAt,
        releasedAt: item.releasedAt ?? "-",
      }));
      if (ctx.options.output === "jsonl") {
        payload.items.forEach((item) => ctx.jsonLine(item));
        return;
      }
      printJsonOrTable(ctx, payload, rows, [
        { key: "id", label: "ID" },
        { key: "scope", label: "SCOPE" },
        { key: "status", label: "STATUS" },
        { key: "reason", label: "REASON" },
        { key: "createdBy", label: "CREATED BY" },
        { key: "createdAt", label: "CREATED" },
        { key: "releasedAt", label: "RELEASED" },
      ]);
    },
  }),
  command("bases destruction preview", {
    summary: "Preview bounded controlled File destruction",
    description: "Requires Base admin access. Preview never deletes data and returns at most 100 exact eligible File candidates.",
    args: baseArgs,
    flags: { ...baseFlag },
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const payload = await readApi<ControlledDestructionOverview>(ctx, `/bases/${encodeURIComponent(base.id)}/controlled-destruction`);
      const rows = payload.preview.items.map((item) => ({
        fileId: item.fileId,
        table: `${item.tableName} (${item.tableId})`,
        filename: item.filename,
        sizeBytes: item.sizeBytes,
        notBefore: item.notBefore,
      }));
      printJsonOrTable(ctx, payload.preview, rows, [
        { key: "fileId", label: "FILE" },
        { key: "table", label: "TABLE" },
        { key: "filename", label: "FILENAME" },
        { key: "sizeBytes", label: "BYTES" },
        { key: "notBefore", label: "ELIGIBLE SINCE" },
      ]);
      if (ctx.options.output !== "json" && ctx.options.output !== "jsonl") {
        ctx.print(`Showing ${payload.preview.items.length} of ${payload.preview.counts.eligible} eligible File candidates.`);
      }
    },
  }),
  command("bases destruction run", {
    summary: "Start the currently previewed controlled File destruction batch",
    description: "Irreversible. Pass the exact Base name through --confirm. Eligibility and holds are rechecked before every File.",
    args: baseArgs,
    flags: { ...baseFlag, confirm: flag.string({ required: true, description: "Exact Base name" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      if (flags.confirm !== base.name) throw new Error(`--confirm must exactly match the Base name: ${base.name}`);
      const overview = await readApi<ControlledDestructionOverview>(ctx, `/bases/${encodeURIComponent(base.id)}/controlled-destruction`);
      if (overview.preview.items.length === 0)
        throw new Error("No eligible unreferenced Files are available in the current bounded preview.");
      const run = await readApi<ControlledDestructionRun>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/controlled-destruction`,
        jsonRequest("POST", {
          fileIds: overview.preview.items.map((item) => item.fileId),
          confirmation: flags.confirm,
        }),
      );
      printJsonOrMessage(ctx, run, `Started controlled destruction ${run.id} for ${run.counts.total} File candidates.`);
    },
  }),
  command("bases destruction status", {
    summary: "Show one controlled destruction run",
    args: baseArgs,
    flags: { ...baseFlag },
    async run({ ctx, args }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const runId = requirePublicId(requireRestArg(rest, 0, "Controlled destruction run public id"), "Controlled destruction run id");
      const run = await readApi<ControlledDestructionRun>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/controlled-destruction/${encodeURIComponent(runId)}`,
      );
      printJsonOrTable(ctx, run, destructionRows(run), [
        { key: "fileId", label: "FILE" },
        { key: "table", label: "TABLE" },
        { key: "filename", label: "FILENAME" },
        { key: "sizeBytes", label: "BYTES" },
        { key: "status", label: "STATUS" },
        { key: "message", label: "DETAIL" },
      ]);
    },
  }),
  command("bases destruction cancel", {
    summary: "Cancel remaining work in one controlled destruction run",
    description: "Already destroyed bytes cannot be recovered.",
    args: baseArgs,
    flags: { ...baseFlag, yes: confirmFlag("Cancel remaining controlled destruction work") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to cancel remaining controlled destruction work.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const runId = requirePublicId(requireRestArg(rest, 0, "Controlled destruction run public id"), "Controlled destruction run id");
      const run = await readApi<ControlledDestructionRun>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/controlled-destruction/${encodeURIComponent(runId)}/cancel`,
        jsonRequest("POST"),
      );
      printJsonOrMessage(ctx, run, `Cancellation requested for controlled destruction ${run.id}.`);
    },
  }),
  command("bases preservation-holds create", {
    summary: "Create a preservation hold",
    description: "Requires Base admin access. The hold blocks future controlled destruction only in its selected scope.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      scope: flag.enum(["base", "table"] as const, { default: "base", description: "Hold scope" }),
      table: flag.string({ description: "Table public id or exact name; required for --scope table" }),
      reason: flag.string({ required: true, description: "Why this scope must be preserved" }),
    },
    async run({ ctx, args, flags }) {
      if (!flags.reason?.trim()) throw new Error("Pass --reason <text>.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      if (flags.scope === "table" && !flags.table) throw new Error("Pass --table <table> with --scope table.");
      if (flags.scope === "base" && flags.table) throw new Error("--table requires --scope table.");
      const tableId = flags.table ? await resolveTablePublicRefFromSearch(ctx, base.id, flags.table) : null;
      const hold = await readApi<PreservationHold>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/preservation-holds`,
        jsonRequest("POST", {
          reason: flags.reason.trim(),
          scope: tableId ? { type: "table", tableId } : { type: "base" },
        }),
      );
      const scopeLabel = hold.scope.type === "base" ? `${base.name} (${base.id})` : `${hold.scope.tableName} (${hold.scope.tableId})`;
      printJsonOrMessage(ctx, hold, `Created preservation hold ${hold.id} for ${scopeLabel}.`);
    },
  }),
  command("bases preservation-holds release", {
    summary: "Release one preservation hold",
    description: "Releasing one hold does not release any other active hold and does not delete data.",
    args: baseArgs,
    flags: {
      ...baseFlag,
      reason: flag.string({ required: true, description: "Why this hold is being released" }),
      yes: confirmFlag("Release this preservation hold"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to release the preservation hold.");
      if (!flags.reason?.trim()) throw new Error("Pass --reason <text>.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const holdId = requirePublicId(requireRestArg(rest, 0, "Preservation hold public id"), "Preservation hold id");
      const hold = await readApi<PreservationHold>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/preservation-holds/${encodeURIComponent(holdId)}/release`,
        jsonRequest("POST", { reason: flags.reason.trim() }),
      );
      printJsonOrMessage(ctx, hold, `Released preservation hold ${hold.id} for ${base.name} (${base.id}).`);
    },
  }),
  command("bases create", {
    summary: "Create a Grids base",
    args: { name: arg.required({ description: "Base name" }) },
    flags: {
      description: flag.string({ description: "Base description" }),
      use: flag.boolean({ description: "Use the new base as default" }),
    },
    async run({ ctx, args, flags }) {
      const base = await readApi<Base>(ctx, "/bases", jsonRequest("POST", { name: args.name, description: flags.description ?? null }));
      const id = base.id;
      if (flags.use) await ctx.setDefault(GRIDS_BASE_DEFAULT_KEY, id);
      printJsonOrMessage(ctx, base, `Created ${base.name} (${id}).${flags.use ? " Using it as default." : ""}`);
    },
  }),
  command("bases update", {
    summary: "Update a Grids base",
    args: baseArgs,
    flags: {
      ...baseFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Base name" }),
      description: flag.string({ description: "Base description" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "base update JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
      });
      const updated = await readApi<Base>(ctx, `/bases/${encodeURIComponent(base.id)}`, jsonRequest("PATCH", body));
      printJsonOrMessage(ctx, updated, `Updated ${updated.name} (${updated.id}).`);
    },
  }),
  command("bases delete", {
    summary: "Delete a Grids base",
    args: baseArgs,
    flags: { ...baseFlag, yes: confirmFlag("Delete this Grids base") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      await readApi<MessageResponse>(ctx, `/bases/${encodeURIComponent(base.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: base.id }, `Deleted ${base.name} (${base.id}).`);
    },
  }),
  command("bases restore", {
    summary: "Restore a deleted Grids base",
    args: { base: arg.required({ description: "Base public id" }) },
    async run({ ctx, args }) {
      const restored = await readApi<Base>(ctx, `/bases/${encodeURIComponent(args.base)}/restore`, jsonRequest("POST"));
      printJsonOrMessage(ctx, restored, `Restored ${restored.name} (${restored.id}).`);
    },
  }),
];
