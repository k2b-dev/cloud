import { arg, command, confirmFlag, flag, paginationFlags } from "@valentinkolb/cloud/cli";
import type { PublicDurableHistoryStatus } from "../api/durable-history";
import type {
  PublicFederatedRevisionView as FederatedRevisionView,
  PublicFederatedSourcePublication as FederatedSourcePublication,
  PublicField as Field,
  PublicFederatedSourceCandidate,
  PublicTable as Table,
} from "../api/public-dto";
import { PublicFederatedDraftInputSchema } from "../api/public-federated-contracts";
import type { PublicRecordFinalizationStatus } from "../api/record-finalization";
import type { MutationSource, TableKind, TableMutationPolicy } from "../contracts";

type FederatedDraftInput = ReturnType<typeof PublicFederatedDraftInputSchema.parse>;
type FederatedTableConfig = { current: FederatedRevisionView | null; draft: FederatedRevisionView };
type FederatedValidation = { valid: boolean; diagnostics: FederatedRevisionView["diagnostics"] };

type FederatedSourceCandidatePage = {
  items: PublicFederatedSourceCandidate[];
  total: number;
  limit: number;
  offset: number;
};

type MutationPolicyImpact = {
  items: Array<{ kind: "form" | "workflow" | "action"; id: string; name: string }>;
  total: number;
  limit: number;
  truncated: boolean;
  complete: boolean;
};

const MUTATION_SOURCES = ["direct", "form", "workflow"] as const satisfies readonly MutationSource[];

const parseMutationPolicy = (value: string | undefined): TableMutationPolicy => {
  const input = value?.trim().toLowerCase();
  if (!input) throw new Error("Missing allowed sources. Pass --allow all, none, or a comma-separated list of direct,form,workflow.");
  if (input === "all") return { mode: "all" };
  if (input === "none") return { mode: "selected", sources: [] };
  const requested = input.split(",").map((source) => source.trim());
  const unknown = requested.filter((source) => !MUTATION_SOURCES.includes(source as MutationSource));
  if (unknown.length > 0) {
    throw new Error(`Unknown record change source: ${unknown.join(", ")}. Use direct, form, workflow, all, or none.`);
  }
  return { mode: "selected", sources: MUTATION_SOURCES.filter((source) => requested.includes(source)) };
};

const mutationPolicyText = (policy: TableMutationPolicy): string =>
  policy.mode === "all" ? "all" : policy.sources.length === 0 ? "none" : policy.sources.join(",");

import {
  baseArgs,
  baseFlag,
  listFields,
  listTables,
  resolveBase,
  resolveBaseFromCommand,
  resolveField,
  resolveNamedResource,
  resolveTable,
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
  readApi,
  readJsonInput,
  requireRestArg,
} from "./runtime";
import {
  type FieldDependentsResponse,
  fieldRows,
  fieldTypeReference,
  fieldTypeReferences,
  fieldTypeRows,
  printFieldTypeReference,
  tableRows,
} from "./schema-support";

type FriendlyFederatedMapping = {
  target: string;
  source: string;
  options?: Record<string, string>;
};

type FriendlyFederatedSource = {
  base?: string;
  table: string;
  mappings: FriendlyFederatedMapping[];
};

type FriendlyFederatedDraft = { sources: FriendlyFederatedSource[] };

const selectOptions = (field: Field): Array<{ id: string; label: string }> => {
  const options = (field.config as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const { id, label } = option as { id?: unknown; label?: unknown };
    return typeof id === "string" && typeof label === "string" ? [{ id, label }] : [];
  });
};

const resolveSelectOption = (field: Field, ref: string): string => {
  const options = selectOptions(field);
  const matches = options.filter((option) => option.id === ref || option.label.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new Error(`Ambiguous option "${ref}" on field "${field.name}".`);
  throw new Error(`Unknown option "${ref}" on field "${field.name}".`);
};

const resolveFieldFromList = (fields: Field[], ref: string): Field => resolveNamedResource(fields, ref, "field");

const friendlyFederatedDraft = async (
  ctx: Parameters<typeof resolveBase>[0],
  targetBaseId: string,
  targetTable: Table,
  input: FriendlyFederatedDraft,
): Promise<FederatedDraftInput> => {
  if (!Array.isArray(input.sources)) throw new Error('Combined table JSON must contain a "sources" array.');
  const sourceTableIds: string[] = [];
  const mappings: FederatedDraftInput["mappings"] = [];
  const targetFields = await listFields(ctx, targetTable.id);

  for (const sourceInput of input.sources) {
    const sourceBase = await resolveBase(ctx, sourceInput.base ?? targetBaseId);
    const sourceTable = await resolveTable(ctx, sourceBase.id, sourceInput.table);
    if (sourceTable.kind !== "stored") throw new Error(`Source table "${sourceTable.name}" must be a stored table.`);
    if (sourceTableIds.includes(sourceTable.id)) throw new Error(`Source table "${sourceTable.name}" is listed more than once.`);
    sourceTableIds.push(sourceTable.id);
    const sourceFields = await listFields(ctx, sourceTable.id);

    for (const mappingInput of sourceInput.mappings ?? []) {
      const targetField = resolveFieldFromList(targetFields, mappingInput.target);
      const sourceField = resolveFieldFromList(sourceFields, mappingInput.source);
      const optionMap =
        targetField.type === "select" && sourceField.type === "select"
          ? Object.fromEntries(
              Object.entries(mappingInput.options ?? {}).map(([sourceOption, targetOption]) => [
                resolveSelectOption(sourceField, sourceOption),
                resolveSelectOption(targetField, targetOption),
              ]),
            )
          : undefined;
      mappings.push({
        targetFieldId: targetField.id,
        sourceTableId: sourceTable.id,
        sourceFieldId: sourceField.id,
        config: optionMap ? { optionMap } : {},
      });
    }
  }
  return { sourceTableIds, mappings };
};

const readFederatedDraftInput = async (
  ctx: Parameters<typeof resolveBase>[0],
  targetBaseId: string,
  targetTable: Table,
  body: unknown,
): Promise<FederatedDraftInput> => {
  if (body && typeof body === "object" && "sourceTableIds" in body) {
    const parsed = PublicFederatedDraftInputSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    throw new Error(`Invalid Combined table draft: ${parsed.error.issues[0]?.message ?? "invalid public input"}.`);
  }
  return friendlyFederatedDraft(ctx, targetBaseId, targetTable, body as FriendlyFederatedDraft);
};

export const tableCommands = [
  command("tables list", {
    summary: "List tables in a base",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const tables = await listTables(ctx, base.id);
      printJsonOrTable(ctx, tables, tableRows(tables), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "kind", label: "KIND" },
        { key: "fields", label: "FIELDS" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("tables get", {
    summary: "Show a table",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (!printCliStructured(ctx, table)) {
        ctx.print(`${table.name} (${table.id})`);
        if (table.description) ctx.print(table.description);
        ctx.print(`id: ${table.id}`);
        ctx.print(`kind: ${table.kind === "federated" ? "combined" : "stored"}`);
        ctx.print(`fields: ${table.columns.length}`);
      }
    },
  }),
  command("tables mutation-policy", {
    summary: "Show where a table's record changes may start",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "stored") throw new Error("Record change policies are only available for stored tables.");
      if (!printCliStructured(ctx, table.mutationPolicy)) {
        ctx.print(`Allowed record change sources for ${table.name}: ${mutationPolicyText(table.mutationPolicy)}.`);
      }
    },
  }),
  command("tables mutation-policy impact", {
    summary: "Preview active entry points affected by a record change policy",
    description: "Checks Forms, Actions, and Workflows that would stop changing this table before you tighten its policy.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      allow: flag.string({ required: true, description: "Allowed sources: all, none, or direct,form,workflow" }),
    },
    async run({ ctx, args, flags }) {
      const policy = parseMutationPolicy(flags.allow);
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "stored") throw new Error("Record change policies are only available for stored tables.");
      const impact = await readApi<MutationPolicyImpact>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/mutation-policy/impact`,
        jsonRequest("POST", { policy }),
      );
      if (!printCliStructured(ctx, impact)) {
        if (impact.total === 0 && impact.complete) {
          ctx.print("No active configured Forms, Actions, or Workflows were found. The policy still applies to matching requests.");
          return;
        }
        printJsonOrTable(ctx, impact, impact.items, [
          { key: "kind", label: "KIND" },
          { key: "name", label: "NAME" },
          { key: "id", label: "ID" },
        ]);
        if (!impact.complete) {
          ctx.print(
            impact.total > 0
              ? `Found at least ${impact.total} affected entry points. More Workflows may be affected than this bounded preview can list.`
              : "More Workflows may be affected than this bounded preview can inspect.",
          );
        } else if (impact.truncated) {
          ctx.print(`Showing ${impact.items.length} of ${impact.total} affected entry points.`);
        }
      }
    },
  }),
  command("tables mutation-policy set", {
    summary: "Set where a table's record changes may start",
    description:
      "The policy is enforced by the server for direct changes, Forms, Actions, Workflows, API, and CLI. Use the impact command before removing a source.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      allow: flag.string({ required: true, description: "Allowed sources: all, none, or direct,form,workflow" }),
      yes: confirmFlag("Freeze all record changes when --allow none is used"),
    },
    async run({ ctx, args, flags }) {
      const policy = parseMutationPolicy(flags.allow);
      if (policy.mode === "selected" && policy.sources.length === 0 && !flags.yes) {
        throw new Error("Pass --yes with --allow none to freeze all record changes.");
      }
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "stored") throw new Error("Record change policies are only available for stored tables.");
      const result = await readApi<{ policy: TableMutationPolicy }>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/mutation-policy`,
        jsonRequest("PUT", { policy, ...(policy.mode === "selected" && policy.sources.length === 0 ? { confirmFreeze: true } : {}) }),
      );
      printJsonOrMessage(ctx, result, `Allowed record change sources for ${table.name}: ${mutationPolicyText(result.policy)}.`);
    },
  }),
  command("tables history", {
    summary: "Show a table's durable history status",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const status = await readApi<PublicDurableHistoryStatus>(ctx, `/tables/${encodeURIComponent(table.id)}/durable-history`);
      if (!printCliStructured(ctx, status)) {
        if (!status.enabled) ctx.print(`Durable history is not enabled for ${table.name} (${table.id}).`);
        else {
          ctx.print(`Durable history is ${status.status} for ${table.name} (${table.id}).`);
          ctx.print(`baseline: ${status.baseline.captured}/${status.baseline.total}`);
          ctx.print(`enabled: ${status.activatedAt}`);
        }
      }
    },
  }),
  command("tables history enable", {
    summary: "Irreversibly enable durable history and capture its baseline",
    description:
      "Enables append-only record versions permanently. The command continues the initial baseline in bounded server-side batches until it is complete.",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, yes: confirmFlag("Permanently enable durable history for this table") },
    examples: [
      "cld grids tables history enable Bookshop Authors --yes",
      "cld grids tables history enable --base Bookshop --table Authors --yes --json",
    ],
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to permanently enable durable history.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      let status = await readApi<PublicDurableHistoryStatus>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/durable-history/enable`,
        jsonRequest("POST"),
      );
      while (status.enabled && status.status === "activating") {
        const captured = status.baseline.captured;
        status = await readApi<PublicDurableHistoryStatus>(
          ctx,
          `/tables/${encodeURIComponent(table.id)}/durable-history/continue`,
          jsonRequest("POST"),
        );
        if (status.enabled && status.status === "activating" && status.baseline.captured <= captured) {
          throw new Error("Durable history baseline did not make progress. Run the command again to continue safely.");
        }
      }
      printJsonOrMessage(ctx, status, `Enabled durable history for ${table.name} (${table.id}).`);
    },
  }),
  command("tables finalization", {
    summary: "Show a table's record finalization status",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const status = await readApi<PublicRecordFinalizationStatus>(ctx, `/tables/${encodeURIComponent(table.id)}/finalization`);
      if (!printCliStructured(ctx, status)) {
        ctx.print(
          status.enabled
            ? `Finalization is enabled for ${table.name} in ${status.mode === "fourEyes" ? `Four-eyes mode (${status.approverGroupName ?? status.approverGroupId})` : "Direct mode"} (${status.finalizedCount} finalized).`
            : `Finalization is not enabled for ${table.name}. Durable history: ${status.durableHistory}.`,
        );
      }
    },
  }),
  command("tables finalization enable", {
    summary: "Enable record finalization for a table",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      mode: flag.string({ description: "Finalization mode: direct or four-eyes" }),
      approverGroup: flag.string({ description: "Cloud group UUID whose members may approve Four-eyes requests" }),
      yes: confirmFlag("Enable irreversible record finalization"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to enable record finalization.");
      const mode = flags.mode?.trim().toLowerCase();
      if (mode !== "direct" && mode !== "four-eyes") throw new Error("Pass --mode direct or --mode four-eyes.");
      if (mode === "four-eyes" && !flags.approverGroup?.trim()) {
        throw new Error("Pass --approver-group with the Cloud group UUID for Four-eyes Finalization.");
      }
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const policy =
        mode === "four-eyes" ? { mode: "fourEyes" as const, approverGroupId: flags.approverGroup!.trim() } : { mode: "direct" as const };
      const status = await readApi<PublicRecordFinalizationStatus>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/finalization/enable`,
        jsonRequest("POST", policy),
      );
      printJsonOrMessage(ctx, status, `Enabled finalization for ${table.name} (${table.id}).`);
    },
  }),
  command("tables finalization disable", {
    summary: "Disable record finalization before the first record is finalized",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, yes: confirmFlag("Disable record finalization") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to disable record finalization.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const status = await readApi<PublicRecordFinalizationStatus>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/finalization/disable`,
        jsonRequest("POST"),
      );
      printJsonOrMessage(ctx, status, `Disabled finalization for ${table.name} (${table.id}).`);
    },
  }),
  command("tables finalization policy", {
    summary: "Require Direct or Four-eyes Finalization for a table",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      mode: flag.string({ description: "Finalization mode: direct or four-eyes" }),
      approverGroup: flag.string({ description: "Cloud group UUID whose members may approve Four-eyes requests" }),
      yes: confirmFlag("Change the table Finalization policy"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to change the Finalization policy.");
      const mode = flags.mode?.trim().toLowerCase();
      if (mode !== "direct" && mode !== "four-eyes") throw new Error("Pass --mode direct or --mode four-eyes.");
      if (mode === "four-eyes" && !flags.approverGroup?.trim()) {
        throw new Error("Pass --approver-group with the Cloud group UUID for Four-eyes Finalization.");
      }
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const policy =
        mode === "four-eyes" ? { mode: "fourEyes" as const, approverGroupId: flags.approverGroup!.trim() } : { mode: "direct" as const };
      const status = await readApi<PublicRecordFinalizationStatus>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/finalization/policy`,
        jsonRequest("PUT", policy),
      );
      printJsonOrMessage(
        ctx,
        status,
        mode === "four-eyes"
          ? `Four-eyes Finalization now requires group ${flags.approverGroup!.trim()} for ${table.name}.`
          : `Direct Finalization is enabled for ${table.name}.`,
      );
    },
  }),
  command("tables create", {
    summary: "Create a table",
    args: baseArgs,
    flags: {
      ...baseFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Table name" }),
      kind: flag.string({ description: "Table kind: stored or federated (Combined table)" }),
      description: flag.string({ description: "Table description" }),
      icon: flag.string({ description: "Table icon class" }),
    },
    examples: [
      "cld grids tables create Bookshop --name Authors --description 'People who wrote books'",
      'cld grids tables create --base Bookshop --body \'{"name":"Orders","icon":"ti ti-shopping-cart"}\'',
    ],
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "table JSON", false)) ?? {};
      const kind = flags.kind as TableKind | undefined;
      if (kind !== undefined && kind !== "stored" && kind !== "federated") {
        throw new Error('Invalid --kind. Use "stored" or "federated".');
      }
      applyDefined(body, {
        name: flags.name,
        kind,
        description: flags.description,
        icon: flags.icon ?? (body.icon === undefined ? "ti ti-table" : undefined),
      });
      if (!body.name) throw new Error("Missing table name. Pass --name or --body JSON.");
      const table = await readApi<Table>(ctx, `/tables/by-base/${encodeURIComponent(base.id)}`, jsonRequest("POST", body));
      printJsonOrMessage(ctx, table, `Created table ${table.name} (${table.id}).`);
    },
  }),
  command("tables update", {
    summary: "Update a table",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Table name" }),
      description: flag.string({ description: "Table description" }),
      icon: flag.string({ description: "Table icon class" }),
      disableDirectInsert: flag.boolean({ name: "disable-direct-insert", description: "Disable direct record insertion" }),
      enableDirectInsert: flag.boolean({ name: "enable-direct-insert", description: "Enable direct record insertion" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "table update JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        icon: flags.icon,
        disableDirectInsert: flags.disableDirectInsert ? true : flags.enableDirectInsert ? false : undefined,
      });
      const updated = await readApi<Table>(ctx, `/tables/${encodeURIComponent(table.id)}`, jsonRequest("PATCH", body));
      printJsonOrMessage(ctx, updated, `Updated table ${updated.name} (${updated.id}).`);
    },
  }),
  command("tables delete", {
    summary: "Delete a table",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, yes: confirmFlag("Delete this table") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      await readApi<MessageResponse>(ctx, `/tables/${encodeURIComponent(table.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: table.id }, `Deleted table ${table.name} (${table.id}).`);
    },
  }),
  command("tables restore", {
    summary: "Restore a deleted table by public id",
    args: { table: arg.required({ description: "Table public id" }) },
    async run({ ctx, args }) {
      const table = await readApi<Table>(ctx, `/tables/${encodeURIComponent(args.table)}/restore`, jsonRequest("POST"));
      printJsonOrMessage(ctx, table, `Restored table ${table.name} (${table.id}).`);
    },
  }),
  command("tables combined get", {
    summary: "Show the draft and published revision of a Combined table",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "federated") throw new Error(`Table "${table.name}" is not a Combined table.`);
      const config = await readApi<FederatedTableConfig>(ctx, `/tables/${encodeURIComponent(table.id)}/federation`);
      if (!printCliStructured(ctx, config)) {
        ctx.print(`${table.name} (${table.id})`);
        ctx.print(
          `draft: revision ${config.draft.revision} · ${config.draft.sources.length} sources · ${config.draft.diagnostics.length} diagnostics`,
        );
        ctx.print(
          config.current
            ? `published: revision ${config.current.revision} · ${config.current.status} · ${config.current.sources.length} sources`
            : "published: none",
        );
      }
    },
  }),
  command("tables combined candidates", {
    summary: "List source tables you may publish into a Combined table",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      q: flag.string({ aliases: ["query"], description: "Search source bases and tables" }),
      ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "federated") throw new Error(`Table "${table.name}" is not a Combined table.`);
      const perPage = flags.perPage ?? 50;
      const page = flags.page ?? 1;
      const query = new URLSearchParams({ limit: String(perPage), offset: String((page - 1) * perPage) });
      if (flags.q) query.set("q", flags.q);
      const candidates = await readApi<FederatedSourceCandidatePage>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/federation/source-candidates?${query}`,
      );
      const rows = candidates.items.map((candidate) => ({
        base: candidate.base.name,
        baseId: candidate.base.id,
        table: candidate.table.name,
        tableId: candidate.table.id,
        fields: candidate.fieldCount,
      }));
      printJsonOrTable(ctx, candidates, rows, [
        { key: "base", label: "BASE" },
        { key: "baseId", label: "BASE ID" },
        { key: "table", label: "TABLE" },
        { key: "tableId", label: "TABLE ID" },
        { key: "fields", label: "FIELDS" },
      ]);
    },
  }),
  command("tables combined publications", {
    summary: "List Combined tables that publish a stored source table",
    description: "Requires admin access to the source base. The result includes the exact mapped field scope and revocation status.",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "source table"));
      if (table.kind !== "stored") throw new Error(`Table "${table.name}" is not a stored source table.`);
      const publications = await readApi<FederatedSourcePublication[]>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/federation/publications`,
      );
      const rows = publications.flatMap((publication) =>
        (publication.mappings.length > 0 ? publication.mappings : [null]).map((mapping) => ({
          base: publication.targetBaseName,
          table: publication.targetTableName,
          revision: publication.revision,
          status: publication.revokedAt ? "revoked" : publication.status,
          sourceField: mapping?.sourceFieldName ?? "-",
          targetField: mapping?.targetFieldName ?? "-",
          publishedAt: publication.publishedAt,
        })),
      );
      printJsonOrTable(ctx, publications, rows, [
        { key: "base", label: "TARGET BASE" },
        { key: "table", label: "TARGET TABLE" },
        { key: "revision", label: "REV" },
        { key: "status", label: "STATUS" },
        { key: "sourceField", label: "SOURCE FIELD" },
        { key: "targetField", label: "TARGET FIELD" },
        { key: "publishedAt", label: "PUBLISHED" },
      ]);
    },
  }),
  command("tables combined validate", {
    summary: "Validate a Combined table configuration without saving it",
    description:
      'The body uses exact names or public ids: {"sources":[{"base":"East","table":"Items","mappings":[{"target":"Name","source":"Title"}]}]}.',
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, body: JSON_BODY_INPUT },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "federated") throw new Error(`Table "${table.name}" is not a Combined table.`);
      const input = await readFederatedDraftInput(ctx, base.id, table, await readJsonInput<unknown>(flags.body, "Combined table JSON"));
      const result = await readApi<FederatedValidation>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/federation/validate`,
        jsonRequest("POST", input),
      );
      if (!printCliStructured(ctx, result))
        if (result.valid) ctx.print("Combined table configuration is valid.");
        else for (const diagnostic of result.diagnostics) ctx.print(`${diagnostic.code}: ${diagnostic.message}`);
    },
  }),
  command("tables combined draft", {
    summary: "Replace and save a Combined table draft",
    description:
      'Use exact names or public ids: {"sources":[{"base":"East","table":"Items","mappings":[{"target":"Name","source":"Title"},{"target":"Status","source":"State","options":{"In stock":"Available"}}]}]}.',
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, body: JSON_BODY_INPUT },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "federated") throw new Error(`Table "${table.name}" is not a Combined table.`);
      const input = await readFederatedDraftInput(ctx, base.id, table, await readJsonInput<unknown>(flags.body, "Combined table JSON"));
      const config = await readApi<FederatedTableConfig>(ctx, `/tables/${encodeURIComponent(table.id)}/federation`);
      const draft = await readApi<FederatedRevisionView>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/federation/draft`,
        jsonRequest("PUT", { ...input, draftToken: config.draft.revisionToken }),
      );
      printJsonOrMessage(
        ctx,
        draft,
        `Saved revision ${draft.revision} draft with ${draft.sources.length} sources and ${draft.diagnostics.length} diagnostics.`,
      );
    },
  }),
  command("tables combined publish", {
    summary: "Publish a valid Combined table draft",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (table.kind !== "federated") throw new Error(`Table "${table.name}" is not a Combined table.`);
      const revision = await readApi<FederatedRevisionView>(
        ctx,
        `/tables/${encodeURIComponent(table.id)}/federation/publish`,
        jsonRequest("POST"),
      );
      printJsonOrMessage(ctx, revision, `Published revision ${revision.revision} with ${revision.sources.length} sources.`);
    },
  }),
  command("tables combined revoke", {
    summary: "Revoke a stored source from a published Combined table",
    description:
      "Requires only admin access to the source base; target-table is the Combined table public id shown by the publications command.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      targetTable: flag.string({ name: "target-table", description: "Published Combined table public id" }),
      yes: confirmFlag("Revoke this source publication"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to revoke the source publication.");
      if (!flags.targetTable) throw new Error("Pass --target-table with the published Combined table public id.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const source = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "source table"));
      if (source.kind !== "stored") throw new Error(`Table "${source.name}" is not a stored source table.`);
      await readApi<null>(
        ctx,
        `/tables/${encodeURIComponent(flags.targetTable)}/federation/sources/${encodeURIComponent(source.id)}/revoke`,
        jsonRequest("POST"),
      );
      printJsonOrMessage(
        ctx,
        { revoked: source.id, targetTableId: flags.targetTable },
        `Revoked ${source.name} from Combined table ${flags.targetTable}.`,
      );
    },
  }),
];

export const fieldCommands = [
  command("fields types", {
    summary: "List all Grids field types and their record payload shape",
    description: "Use this before creating fields or writing record JSON. Machine-readable output is available with --json.",
    async run({ ctx }) {
      const refs = fieldTypeReferences();
      printJsonOrTable(ctx, refs, fieldTypeRows(refs), [
        { key: "type", label: "TYPE" },
        { key: "category", label: "CATEGORY" },
        { key: "writable", label: "RECORD" },
        { key: "recordValue", label: "VALUE" },
        { key: "config", label: "CONFIG" },
      ]);
    },
  }),
  command("fields type", {
    summary: "Show one field type reference",
    args: { type: arg.required({ description: "Field type, for example text, number, relation, formula" }) },
    examples: ["cld grids fields type select", "cld grids fields type relation --json"],
    async run({ ctx, args }) {
      printFieldTypeReference(ctx, fieldTypeReference(args.type));
    },
  }),
  command("fields list", {
    summary: "List fields in a table",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const fields = await listFields(ctx, table.id);
      printJsonOrTable(ctx, fields, fieldRows(fields), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "type", label: "TYPE" },
        { key: "required", label: "REQ" },
        { key: "presentable", label: "LABEL" },
      ]);
    },
  }),
  command("fields get", {
    summary: "Show a field",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, field: flag.string({ description: "Field public id or exact name" }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.field ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const fieldRef = flags.field ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "field");
      const field = await resolveField(ctx, table.id, fieldRef);
      if (!printCliStructured(ctx, field)) {
        ctx.print(`${field.name} (${field.id})`);
        ctx.print(`type: ${field.type}`);
        ctx.print(`id: ${field.id}`);
      }
    },
  }),
  command("fields create", {
    summary: "Create a field",
    description: "Run `cld grids fields types` or `cld grids fields type <type>` to inspect valid field types and config JSON.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Field name" }),
      type: flag.string({ description: "Field type" }),
      description: flag.string({ description: "Field description" }),
      config: flag.string({ description: "Field config JSON object" }),
      required: flag.boolean({ description: "Mark field required" }),
      presentable: flag.boolean({ description: "Use field as record label" }),
      hideInTable: flag.boolean({ name: "hide-in-table", description: "Hide field in table views" }),
    },
    examples: [
      'cld grids fields create Bookshop Authors --name Email --type text --config \'{"regex":"^[^@]+@[^@]+$"}\'',
      'cld grids fields create Bookshop Orders --name Customer --type relation --config \'{"targetTableId":"<table-id>","cardinality":"single"}\'',
      "cld grids fields create Bookshop Orders --body-file field.json",
    ],
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "field JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        type: flags.type,
        description: flags.description,
        config: flags.config ? JSON.parse(flags.config) : undefined,
        required: flags.required ? true : undefined,
        presentable: flags.presentable ? true : undefined,
        hideInTable: flags.hideInTable ? true : undefined,
      });
      if (!body.name) throw new Error("Missing field name. Pass --name or --body JSON.");
      if (!body.type) throw new Error("Missing field type. Pass --type or --body JSON.");
      const field = await readApi<Field>(ctx, `/fields/by-table/${encodeURIComponent(table.id)}`, jsonRequest("POST", body));
      printJsonOrMessage(ctx, field, `Created field ${field.name} (${field.id}).`);
    },
  }),
  command("fields update", {
    summary: "Update a field",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      field: flag.string({ description: "Field public id or exact name" }),
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Field name" }),
      description: flag.string({ description: "Field description" }),
      config: flag.string({ description: "Field config JSON object" }),
      required: flag.boolean({ description: "Mark field required" }),
      optional: flag.boolean({ description: "Mark field optional" }),
      presentable: flag.boolean({ description: "Use field as record label" }),
      notPresentable: flag.boolean({ name: "not-presentable", description: "Do not use field as record label" }),
      hideInTable: flag.boolean({ name: "hide-in-table", description: "Hide field in table views" }),
      showInTable: flag.boolean({ name: "show-in-table", description: "Show field in table views" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.field ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const field = await resolveField(ctx, table.id, flags.field ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "field"));
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "field update JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        config: flags.config ? JSON.parse(flags.config) : undefined,
        required: flags.required ? true : flags.optional ? false : undefined,
        presentable: flags.presentable ? true : flags.notPresentable ? false : undefined,
        hideInTable: flags.hideInTable ? true : flags.showInTable ? false : undefined,
      });
      const updated = await readApi<Field>(ctx, `/fields/${encodeURIComponent(field.id)}`, jsonRequest("PATCH", body));
      printJsonOrMessage(ctx, updated, `Updated field ${updated.name} (${updated.id}).`);
    },
  }),
  command("fields delete", {
    summary: "Delete a field",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      field: flag.string({ description: "Field public id or exact name" }),
      yes: confirmFlag("Delete this field"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.field ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const field = await resolveField(ctx, table.id, flags.field ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "field"));
      await readApi<MessageResponse>(ctx, `/fields/${encodeURIComponent(field.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: field.id }, `Deleted field ${field.name} (${field.id}).`);
    },
  }),
  command("fields restore", {
    summary: "Restore a deleted field by public id",
    args: { field: arg.required({ description: "Field public id" }) },
    async run({ ctx, args }) {
      const field = await readApi<Field>(ctx, `/fields/${encodeURIComponent(args.field)}/restore`, jsonRequest("POST"));
      printJsonOrMessage(ctx, field, `Restored field ${field.name} (${field.id}).`);
    },
  }),
  command("fields dependents", {
    summary: "Show field dependents",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, field: flag.string({ description: "Field public id or exact name" }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? (flags.field ? 0 : 1) : 2);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const field = await resolveField(ctx, table.id, flags.field ?? requireRestArg(flags.table ? rest : rest.slice(1), 0, "field"));
      const payload = await readApi<FieldDependentsResponse>(ctx, `/fields/${encodeURIComponent(field.id)}/dependents`);
      if (!printCliStructured(ctx, payload)) {
        ctx.print(payload.hasBlocking ? "Blocking dependents found." : "No blocking dependents.");
        ctx.table(payload.dependents as Record<string, unknown>[], []);
      }
    },
  }),
  command("fields reorder", {
    summary: "Reorder fields in a table",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      fieldIds: flag.stringList({ name: "field-ids", description: "Comma-separated field ids in desired order" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      if (flags.fieldIds.length === 0) throw new Error("Pass --field-ids.");
      await readApi<MessageResponse>(
        ctx,
        `/fields/by-table/${encodeURIComponent(table.id)}/reorder`,
        jsonRequest("POST", { fieldIds: flags.fieldIds }),
      );
      printJsonOrMessage(ctx, { reordered: flags.fieldIds }, `Reordered ${flags.fieldIds.length} fields.`);
    },
  }),
];
