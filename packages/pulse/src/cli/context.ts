import type { CloudCliContext } from "@k2b/cloud/cli";
import type { PulseBase, PulseDashboard, PulseSavedQuery, PulseSource } from "../contracts";
import { exactMatch, readApi } from "./shared";

export type SourceFilterFlags = { source?: string; sourceId?: string };

export const PULSE_BASE_DEFAULT_KEY = "pulse.base";

const SHORT_ID_RE = /^[0-9A-Za-z]{6}$/;

export const requireDefaultBaseRef = async (ctx: CloudCliContext): Promise<string> => {
  const ref = await ctx.getDefault(PULSE_BASE_DEFAULT_KEY);
  if (!ref) throw new Error("Missing Pulse base. Pass --base <base> or run `cld pulse use <base>`.");
  return ref;
};

const baseRefFromArgs = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ baseRef: string; rest: string[] }> => {
  const flagged = typeof ctx.flags.base === "string" ? ctx.flags.base : undefined;
  if (flagged) return { baseRef: flagged, rest: args };
  if (args.length > requiredTrailingArgs) return { baseRef: args[0]!, rest: args.slice(1) };
  return { baseRef: await requireDefaultBaseRef(ctx), rest: args };
};

export const requireRestArg = (args: string[], index: number, label: string): string => {
  const value = args[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
};

const listBases = (ctx: CloudCliContext): Promise<PulseBase[]> => readApi<PulseBase[]>(ctx, "/bases");

export const resolveBase = async (ctx: CloudCliContext, ref: string): Promise<PulseBase> => {
  if (SHORT_ID_RE.test(ref)) {
    try {
      return await readApi<PulseBase>(ctx, `/bases/${encodeURIComponent(ref)}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("404 ")) throw error;
    }
  }
  return exactMatch(await listBases(ctx), ref, [(base) => base.id, (base) => base.name], "Pulse base");
};

export const resolveBaseFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ base: PulseBase; rest: string[] }> => {
  const { baseRef, rest } = await baseRefFromArgs(ctx, args, requiredTrailingArgs);
  return { base: await resolveBase(ctx, baseRef), rest };
};

export const listSources = (ctx: CloudCliContext, baseId: string): Promise<PulseSource[]> =>
  readApi<PulseSource[]>(ctx, `/bases/${encodeURIComponent(baseId)}/sources`);

export const resolveSource = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PulseSource> =>
  exactMatch(await listSources(ctx, baseId), ref, [(source) => source.id, (source) => source.name], "source");

export const listDashboards = (ctx: CloudCliContext, baseId: string): Promise<PulseDashboard[]> =>
  readApi<PulseDashboard[]>(ctx, `/bases/${encodeURIComponent(baseId)}/dashboards`);

export const resolveDashboard = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PulseDashboard> =>
  exactMatch(await listDashboards(ctx, baseId), ref, [(dashboard) => dashboard.id, (dashboard) => dashboard.name], "dashboard");

export const listSavedQueries = (ctx: CloudCliContext, baseId: string): Promise<PulseSavedQuery[]> =>
  readApi<PulseSavedQuery[]>(ctx, `/bases/${encodeURIComponent(baseId)}/saved-queries`);

export const resolveSavedQuery = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PulseSavedQuery> =>
  exactMatch(await listSavedQueries(ctx, baseId), ref, [(query) => query.id, (query) => query.name], "saved query");

export const resolveSavedQueryId = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<string> =>
  SHORT_ID_RE.test(ref) ? ref : (await resolveSavedQuery(ctx, baseId, ref)).id;

export const resolveSourceFilter = async (
  ctx: CloudCliContext,
  baseId: string,
  filters: SourceFilterFlags,
): Promise<string | undefined> => {
  if (filters.source && filters.sourceId) throw new Error("Pass either --source or --source-id, not both.");
  if (filters.sourceId) {
    if (!SHORT_ID_RE.test(filters.sourceId)) throw new Error("Source ID must be a 6-character short ID.");
    return filters.sourceId;
  }
  if (!filters.source) return undefined;
  return (await resolveSource(ctx, baseId, filters.source)).id;
};
