import type { CloudCliContext } from "@k2b/cloud/cli";
import { BASE_PAGE_MAX, type PulseBase, type PulseSource, SOURCE_PAGE_MAX } from "../contracts";
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

/**
 * Every item of a paged list: reads page after page until a page is shorter than `size` or brings no item it has not
 * seen, so a list that changes while it is read neither loops nor repeats an item.
 */
const readPages = async <T extends { id: string }>(read: (offset: number) => Promise<T[]>, size: number): Promise<T[]> => {
  const items = new Map<string, T>();
  for (let offset = 0; ; offset += size) {
    const page = await read(offset);
    const before = items.size;
    for (const item of page) if (!items.has(item.id)) items.set(item.id, item);
    if (page.length !== size || items.size === before) return [...items.values()];
  }
};

/** Every base whose name or description holds `ref`; the exact match, or the ambiguity, is found among all of them. */
const searchBases = (ctx: CloudCliContext, ref: string): Promise<PulseBase[]> =>
  readPages(
    (offset) => readApi<PulseBase[]>(ctx, `/bases?q=${encodeURIComponent(ref)}&limit=${BASE_PAGE_MAX}&offset=${offset}`),
    BASE_PAGE_MAX,
  );

/** Every base the caller can read, page by page. */
export const listAllBases = (ctx: CloudCliContext): Promise<PulseBase[]> =>
  readPages((offset) => readApi<PulseBase[]>(ctx, `/bases?limit=${BASE_PAGE_MAX}&offset=${offset}`), BASE_PAGE_MAX);

export const resolveBase = async (ctx: CloudCliContext, ref: string): Promise<PulseBase> => {
  if (SHORT_ID_RE.test(ref)) {
    try {
      return await readApi<PulseBase>(ctx, `/bases/${encodeURIComponent(ref)}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("404 ")) throw error;
    }
  }
  return exactMatch(await searchBases(ctx, ref), ref, [(base) => base.id, (base) => base.name], "Pulse base");
};

export const resolveBaseFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ base: PulseBase; rest: string[] }> => {
  const { baseRef, rest } = await baseRefFromArgs(ctx, args, requiredTrailingArgs);
  return { base: await resolveBase(ctx, baseRef), rest };
};

/** All sources of a base (or those whose name holds `q`), read page by page as the list endpoint returns them. */
export const listSources = (ctx: CloudCliContext, baseId: string, q?: string): Promise<PulseSource[]> =>
  readPages(
    (offset) =>
      readApi<PulseSource[]>(
        ctx,
        `/bases/${encodeURIComponent(baseId)}/sources?limit=${SOURCE_PAGE_MAX}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      ),
    SOURCE_PAGE_MAX,
  );

export const resolveSource = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PulseSource> =>
  exactMatch(
    // a reference that can be an id is looked for among all sources; a name is searched for on the server
    await listSources(ctx, baseId, SHORT_ID_RE.test(ref) ? undefined : ref),
    ref,
    [(source) => source.id, (source) => source.name],
    "source",
  );
