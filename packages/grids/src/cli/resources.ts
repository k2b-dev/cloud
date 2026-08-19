import type { CloudCliContext } from "@valentinkolb/cloud/cli";
import { arg, flag } from "@valentinkolb/cloud/cli";
import type { PublicBase, PublicField, PublicTable } from "../api/public-dto";
import { queryString, readApi, requireRestArg } from "./runtime";

type BasePage = { items: PublicBase[]; total: number; limit: number; offset: number };

export const GRIDS_BASE_DEFAULT_KEY = "grids.base";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PUBLIC_ID_RE = /^[A-Za-z0-9]{6}$/;

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
  args: arg.rest({ valueLabel: "base-table-args", description: "Optional leading base, then table and command arguments." }),
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

export const resolveBase = async (ctx: CloudCliContext, ref: string): Promise<PublicBase> => {
  if (UUID_RE.test(ref)) throw new Error("Base references do not accept UUIDs. Use its 6-character public id or exact name.");
  const page = await listBases(ctx, { q: ref, limit: 500 });
  return resolveNamedResource(page.items, ref, "base");
};

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
  const flagged = typeof ctx.flags.base === "string" ? ctx.flags.base : undefined;
  if (flagged) return { baseRef: flagged, rest: args };
  if (args.length > requiredTrailingArgs) return { baseRef: requireRestArg(args, 0, "base"), rest: args.slice(1) };
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

export const listTables = (ctx: CloudCliContext, baseId: string, params: { q?: string; limit?: number } = {}): Promise<PublicTable[]> =>
  readApi<PublicTable[]>(ctx, `/tables/by-base/${encodeURIComponent(baseId)}${queryString({ q: params.q, limit: params.limit })}`);

export const resolveTable = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PublicTable> =>
  resolveNamedResource(await listTables(ctx, baseId), ref, "table");

export const resolveTableFromSearch = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PublicTable> => {
  if (UUID_RE.test(ref)) throw new Error("Table references do not accept UUIDs. Use its 6-character public id or exact name.");
  return resolveNamedResource(await listTables(ctx, baseId, { q: ref, limit: 100 }), ref, "table");
};

export const resolveTablePublicRefFromSearch = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<string> => {
  if (UUID_RE.test(ref)) throw new Error("Table references do not accept UUIDs. Use its 6-character public id or exact name.");
  return PUBLIC_ID_RE.test(ref) ? ref : (await resolveTableFromSearch(ctx, baseId, ref)).id;
};

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
