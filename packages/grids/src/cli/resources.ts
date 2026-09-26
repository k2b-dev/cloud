import type { CloudCliContext } from "@k2b/cloud/cli";
import { arg, cliText, flag, parseCliAddress } from "@k2b/cloud/cli";
import type { PublicBase, PublicField, PublicTable } from "../api/public-dto";
import { queryString, readApi, requireRestArg } from "./runtime";

type BasePage = { items: PublicBase[]; total: number; limit: number; offset: number };

export const GRIDS_BASE_DEFAULT_KEY = "grids.base";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID_RE = /^[A-Za-z0-9]{6}$/;

type NamedResource = { id: string; name: string };

export const requirePublicId = (value: string, label: string): string => {
  if (!PUBLIC_ID_RE.test(value)) throw new Error(`${label} must be a 6-character public id.`);
  return value;
};

export const resolveNamedResource = <T extends NamedResource>(items: T[], ref: string, label: string): T => {
  if (UUID_RE.test(ref)) throw new Error(`${label} references do not accept UUIDs. Use its 6-character public id or exact name.`);

  const matches = items.filter((item) => item.id === ref || item.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Ambiguous ${label} "${ref}". Use one of: ${matches.map((item) => `${item.name} (${item.id})`).join(", ")}`);
  }

  const candidates = items
    .filter((item) => item.name.toLowerCase().includes(ref.toLowerCase()))
    .slice(0, 5)
    .map((item) => `${item.name} (${item.id})`)
    .join(", ");
  const idHint = /^[A-Za-z0-9]{5}$/.test(ref) ? " Public ids contain exactly 6 letters or digits." : "";
  throw new Error(`Unknown ${label} "${ref}".${idHint}${candidates ? ` Candidates: ${candidates}.` : ""}`);
};

export const baseFlag = {
  base: flag.string({ description: "Grids base public id or exact name" }),
};

export const tableFlag = {
  table: flag.string({ description: "Table public id or exact name" }),
};

export const baseArgs = {
  args: arg.rest({ valueLabel: "base-or-args", description: "Optional leading base followed by command arguments." }),
};

export const tableArgs = {
  args: arg.rest({
    valueLabel: "base-table-args",
    description: "Table as <base>:<table>, or an optional leading base and the table ID or name; then command arguments.",
  }),
};

export const recordArgs = {
  args: arg.rest({
    valueLabel: "record-args",
    description: "Record as <base>:<table>/<record id> or a record ID, or [base] <table> <record>; then command arguments.",
  }),
};

export const listBases = (ctx: CloudCliContext, params: { q?: string; limit?: number; offset?: number } = {}): Promise<BasePage> =>
  readApi<BasePage>(
    ctx,
    `/bases${queryString({
      q: params.q,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    })}`,
  );

/** What `GET /api/grids/resolve` returns for a base, table, or record address. */
export type ResolvedAddress = { base: PublicBase; table: PublicTable | null; record: { id: string } | null };

type AddressRefs = { base?: string; table?: string; record?: string };

const REF_LABELS = { base: "Base", table: "Table", record: "Record" } as const;

export const resolveAddress = (ctx: CloudCliContext, refs: AddressRefs): Promise<ResolvedAddress> => {
  for (const key of ["base", "table", "record"] as const) {
    if (refs[key] && UUID_RE.test(refs[key])) {
      throw new Error(`${REF_LABELS[key]} references do not accept UUIDs. Use its 6-character public id or exact name.`);
    }
  }
  return readApi<ResolvedAddress>(ctx, `/resolve${queryString(refs)}`);
};

const flagText = (ctx: CloudCliContext, name: string): string | undefined => {
  const value = ctx.flags[name];
  return typeof value === "string" && value ? value : undefined;
};

const gridsAddress = (ctx: CloudCliContext, raw: string) => {
  const address = parseCliAddress(raw);
  if (address.kind === "local") {
    throw new Error(
      cliText(ctx, {
        en: `"${raw}" is a local path, not a Grids address.`,
        de: `„${raw}“ ist ein lokaler Pfad, keine Grids-Adresse.`,
      }),
    );
  }
  return address;
};

/**
 * A table argument: `<base>:<table>`, or a table ID or name in `base`, `--base`, or the default base.
 * Without any base, only a table ID resolves.
 */
const tableRefs = async (ctx: CloudCliContext, raw: string, base?: string): Promise<AddressRefs> => {
  const address = gridsAddress(ctx, raw);
  if (address.kind === "path") return { base: address.container, table: address.path };
  return { base: base ?? flagText(ctx, "base") ?? (await ctx.getDefault(GRIDS_BASE_DEFAULT_KEY)), table: raw };
};

/** A record argument: `<base>:<table>/<record id>` or a record ID. */
const recordRefs = (ctx: CloudCliContext, raw: string): AddressRefs => {
  const address = gridsAddress(ctx, raw);
  if (address.kind === "ref") return { base: flagText(ctx, "base"), record: raw };
  const slash = address.path.lastIndexOf("/");
  if (slash <= 0) {
    throw new Error(
      cliText(ctx, {
        en: `"${raw}" names no record. Use <base>:<table>/<record id> or a record ID.`,
        de: `„${raw}“ nennt keinen Datensatz. Verwende <basis>:<tabelle>/<datensatz-id> oder eine Datensatz-ID.`,
      }),
    );
  }
  return { base: address.container, table: address.path.slice(0, slash), record: address.path.slice(slash + 1) };
};

/** A base by ID or exact name. */
export const resolveBase = async (ctx: CloudCliContext, ref: string): Promise<PublicBase> =>
  (await resolveAddress(ctx, { base: ref })).base;

export const requireDefaultBaseRef = async (ctx: CloudCliContext): Promise<string> => {
  const value = await ctx.getDefault(GRIDS_BASE_DEFAULT_KEY);
  if (!value) throw new Error("Missing Grids base. Pass --base <base> or run `cld grids use <base>`.");
  return value;
};

const baseRefFromArgs = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ baseRef: string; rest: string[] }> => {
  const flagged = flagText(ctx, "base");
  if (flagged) return { baseRef: flagged, rest: args };
  if (args.length > requiredTrailingArgs) return { baseRef: requireRestArg(args, 0, "base"), rest: args.slice(1) };
  // `<base>:<table>` in the table position names the base too; resolveTable reads the table part.
  const leading = args[0] === undefined ? null : gridsAddress(ctx, args[0]);
  if (leading?.kind === "path") return { baseRef: leading.container, rest: args };
  return { baseRef: await requireDefaultBaseRef(ctx), rest: args };
};

export const resolveBaseFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ base: PublicBase; rest: string[] }> => {
  const { baseRef, rest } = await baseRefFromArgs(ctx, args, requiredTrailingArgs);
  return { base: await resolveBase(ctx, baseRef), rest };
};

/** A table by ID, `<base>:<table>`, or exact name inside `baseId`. */
export const resolveTable = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PublicTable> =>
  (await resolveAddress(ctx, await tableRefs(ctx, ref, baseId))).table!;

/**
 * Resolves `[base] <table> <after...>`, where `<table>` may be `<base>:<table>` and `--table` may replace it.
 * `rest` holds the arguments after the table.
 */
export const resolveTableFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  after = 0,
): Promise<{ base: PublicBase; table: PublicTable; rest: string[] }> => {
  const flagged = flagText(ctx, "table");
  const baseArg = args.length > (flagged ? 0 : 1) + after ? args[0] : undefined;
  const rest = baseArg === undefined ? args : args.slice(1);
  const refs = await tableRefs(ctx, flagged ?? requireRestArg(rest, 0, "table"), baseArg);
  const resolved = await resolveAddress(ctx, refs);
  return { base: resolved.base, table: resolved.table!, rest: flagged ? rest : rest.slice(1) };
};

/**
 * Resolves `[base] [table] <item>` for table-scoped items such as views, forms, and document templates.
 * `table` is null when neither `--table` nor a positional table is given; `rest` starts at the item.
 */
export const resolveTableScopeFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  refs: { table?: string; item?: string },
): Promise<{ base: PublicBase; table: PublicTable | null; rest: string[] }> => {
  const baseArg = args.length > (refs.table || refs.item ? 0 : 2) ? args[0] : undefined;
  let rest = baseArg === undefined ? args : args.slice(1);
  let tableRef = refs.table;
  if (!tableRef && rest.length >= 2) {
    tableRef = rest[0];
    rest = rest.slice(1);
  }
  if (tableRef) {
    const resolved = await resolveAddress(ctx, await tableRefs(ctx, tableRef, baseArg));
    return { base: resolved.base, table: resolved.table, rest };
  }
  return { base: await resolveBase(ctx, baseArg ?? flagText(ctx, "base") ?? (await requireDefaultBaseRef(ctx))), table: null, rest };
};

/**
 * Resolves a record from one argument (`<base>:<table>/<record id>` or a record ID), from `--record`,
 * or from `[base] <table> <record>` as before. `rest` holds the arguments after the record.
 */
export const resolveRecordFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  after = 0,
): Promise<{ base: PublicBase; table: PublicTable; recordId: string; rest: string[] }> => {
  const flaggedTable = flagText(ctx, "table");
  const flaggedRecord = flagText(ctx, "record");
  const recordOnly = !flaggedTable && args.length === (flaggedRecord ? after : after + 1);
  if (recordOnly) {
    const raw = flaggedRecord ?? requireRestArg(args, 0, "record");
    const refs = recordRefs(ctx, raw);
    requirePublicId(refs.record!, "Record id");
    const resolved = await resolveAddress(ctx, refs);
    return { base: resolved.base, table: resolved.table!, recordId: resolved.record!.id, rest: flaggedRecord ? args : args.slice(1) };
  }
  const baseArg = args.length > (flaggedTable ? 0 : 1) + (flaggedRecord ? 0 : 1) + after ? args[0] : undefined;
  let rest = baseArg === undefined ? args : args.slice(1);
  const tableRef = flaggedTable ?? requireRestArg(rest, 0, "table");
  if (!flaggedTable) rest = rest.slice(1);
  const recordRef = requirePublicId(flaggedRecord ?? requireRestArg(rest, 0, "record"), "Record id");
  if (!flaggedRecord) rest = rest.slice(1);
  const resolved = await resolveAddress(ctx, { ...(await tableRefs(ctx, tableRef, baseArg)), record: recordRef });
  return { base: resolved.base, table: resolved.table!, recordId: resolved.record!.id, rest };
};

export const listTables = (ctx: CloudCliContext, baseId: string, params: { q?: string; limit?: number } = {}): Promise<PublicTable[]> =>
  readApi<PublicTable[]>(ctx, `/tables/by-base/${encodeURIComponent(baseId)}${queryString({ q: params.q, limit: params.limit })}`);

export const resolveTablePublicRefFromSearch = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<string> =>
  PUBLIC_ID_RE.test(ref) ? ref : (await resolveTable(ctx, baseId, ref)).id;

export const resolveTableFromFlags = async (
  ctx: CloudCliContext,
  base: PublicBase,
  ref: string | undefined,
): Promise<PublicTable | null> => (ref ? resolveTable(ctx, base.id, ref) : null);

export const listFields = (ctx: CloudCliContext, tableId: string): Promise<PublicField[]> =>
  readApi<PublicField[]>(ctx, `/fields/by-table/${encodeURIComponent(tableId)}`);

export const resolveField = async (ctx: CloudCliContext, tableId: string, ref: string): Promise<PublicField> =>
  resolveNamedResource(await listFields(ctx, tableId), ref, "field");

export const baseRows = (items: PublicBase[]) =>
  items.map((base) => ({
    id: base.id,
    name: base.name,
    description: base.description ?? "",
    updatedAt: base.updatedAt,
  }));
