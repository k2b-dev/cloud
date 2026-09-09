/**
 * Primitives shared by every admin command group: HTTP access against the
 * Cloud API, output shaping, and the flag conventions the CLI standardises on.
 */

import { formatDurationMs, formatBytes as sharedBytes } from "@k2b/cloud/shared";
import { type CliInputFlagValue, type CloudCliContext, type CloudCliTableColumn, readCliInput } from "../index";

export type Pagination = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
};

export const apiGet = async <T>(ctx: CloudCliContext, path: string): Promise<T> => ctx.readJson<T>(await ctx.fetch(path));

export const apiJson = async <T>(ctx: CloudCliContext, method: string, path: string, body?: unknown): Promise<T> =>
  ctx.readJson<T>(
    await ctx.fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

export const printJsonOrTable = <TRow extends Record<string, unknown>>(
  ctx: CloudCliContext,
  raw: unknown,
  rows: TRow[],
  columns: CloudCliTableColumn<TRow>[],
) => {
  if (ctx.options.output === "json") ctx.json(raw);
  else ctx.table(rows, columns);
};

export const queryString = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : "";
};

export const pageQuery = (flags: { page?: number; perPage?: number }) => ({
  page: flags.page ?? 1,
  per_page: flags.perPage ?? 50,
});

export const truncate = (value: string | null | undefined, max = 90): string => {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export const readJsonInput = async <T>(input: CliInputFlagValue, label: string): Promise<T> => {
  const raw = await readCliInput(input, { label, required: true });
  try {
    return JSON.parse(raw ?? "") as T;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const readOptionalInput = async (input: CliInputFlagValue, label: string): Promise<string | undefined> =>
  readCliInput(input, { label, trimFinalNewline: true });

export const sortByTimeDesc = <T extends { createdAt?: string; occurredAt?: string; time?: string }>(items: T[]): T[] =>
  items
    .slice()
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? b.occurredAt ?? b.time ?? 0).getTime() - new Date(a.createdAt ?? a.occurredAt ?? a.time ?? 0).getTime(),
    );

export const parseLookbackHours = (value: string | undefined): number => {
  const raw = value?.trim() || "24h";
  const match = raw.match(/^(\d+)(m|h|d)$/i);
  if (!match) throw new Error("--since must be a duration like 30m, 6h, or 7d.");
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const hours = unit === "m" ? Math.max(1, Math.ceil(amount / 60)) : unit === "d" ? amount * 24 : amount;
  return Math.min(Math.max(hours, 1), 24 * 31);
};

export const cleanObject = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

export const safeCollect = async <T>(
  label: string,
  load: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; label: string; error: string }> => {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    return { ok: false, label, error: error instanceof Error ? error.message : String(error) };
  }
};

export const skippedCollect = (label: string): { ok: false; label: string; skipped: true; error: string } => ({
  ok: false,
  label,
  skipped: true,
  error: "Skipped by diagnose filters.",
});

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** CLI output stays ASCII, so absent values use a plain dash. */
export const formatBytes = (bytes: number | null | undefined): string => sharedBytes(bytes, { fallback: "-" });

export const formatMs = (ms: number | null | undefined): string => formatDurationMs(ms, { fallback: "-" });
