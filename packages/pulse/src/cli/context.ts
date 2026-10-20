import type { CloudCliContext } from "@k2b/cloud/cli";
import type { PulseBase, PulseSource } from "../contracts";
import { exactMatch, readApi } from "./shared";

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
