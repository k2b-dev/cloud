import { groupDisplayName } from "@k2b/cloud/shared";
import {
  ACTIVITY_PAGE_LIMIT,
  type ActivityBase,
  type ActivityBasesInput,
  type ActivityBasesPage,
  type ActivityEntry,
  type ActivitySide,
} from "../activity-contracts";
import { ActivityExportError, ActivityExportInput, exportWindow } from "../activity-export-contracts";
import type { ActivityFilters, ActivityWhen } from "./ActivityView";
import type { AdminHistoryMessages } from "./admin-history-messages";
import {
  actorOf,
  formatDate,
  formatTime,
  type HistoryEnvironment,
  type HistoryPlace,
  type HistoryRowModel,
  subjectName,
  viaLabel,
} from "./history-actions";
import type { HistoryMessages } from "./history-messages";
import { parseActivityFilters } from "./urls";

/*
 * Presentation and address rules of the administration's history across all storage. The reader decides what an
 * administrator sees; nothing here grants access or reads storage.
 */

/**
 * One bound storage as the administration's history needs it. `id` is the public base ID the reader and the export
 * filter by; `bindingId` is the `baseId` of a history side; `root` and `path` place the storage in its Filegate root.
 */
export type AdminActivityBase = ActivityBase;
export type AdminBasesLoader = (input: ActivityBasesInput, signal: AbortSignal) => Promise<ActivityBasesPage>;

/** Selector values are public identities; the same identity may have many recorded binding rows. */
export function adminBaseOptions(bases: readonly AdminActivityBase[], a: AdminHistoryMessages, locale: string) {
  return [...new Map(bases.map((base) => [base.id, { value: base.id, label: adminBaseLabel(base, a, locale) }])).values()].sort(
    (left, right) => left.label.localeCompare(right.label, locale),
  );
}

/** Only metadata for loaded sides and the current selection. Never walks the complete base inventory. */
export async function loadAdminBaseLabels(
  entries: readonly ActivityEntry[],
  known: readonly AdminActivityBase[],
  selected: string | undefined,
  load: AdminBasesLoader,
  signal: AbortSignal,
): Promise<AdminActivityBase[]> {
  signal.throwIfAborted();
  const labels = new Map(known.map((base) => [base.bindingId, base]));
  if (selected && !known.some((base) => base.id === selected)) {
    const page = await load({ baseId: selected }, signal);
    for (const base of page.items) labels.set(base.bindingId, base);
  }
  const missing = [
    ...new Set(
      entries
        .flatMap((entry) => [entry.before, entry.after])
        .flatMap((side) => (side.visibility === "full" && side.baseId && !labels.has(side.baseId) ? [side.baseId] : [])),
    ),
  ];
  for (let index = 0; index < missing.length; index += ACTIVITY_PAGE_LIMIT) {
    signal.throwIfAborted();
    const page = await load({ bindingIds: missing.slice(index, index + ACTIVITY_PAGE_LIMIT).join(",") }, signal);
    for (const base of page.items) labels.set(base.bindingId, base);
  }
  return [...labels.values()];
}

/** Activity's filters without the single-item path, which only an item's detail opens. */
export type AdminActivityFilters = Omit<ActivityFilters, "path">;

/** The administration opens its history on the approved default range. */
export const ADMIN_ACTIVITY_DEFAULT: AdminActivityFilters = { when: "30" };
/** The administration's address keeps the bound of its existing search parameter. */
export const ADMIN_SEARCH_LIMIT = 200;

export function adminActivityHref(filters: AdminActivityFilters) {
  const query = new URLSearchParams({ view: "activity" });
  if (filters.baseId) query.set("base", filters.baseId);
  if (filters.actor) query.set("who", filters.actor);
  if (filters.action) query.set("what", filters.action);
  if (filters.when) query.set("when", filters.when);
  if (filters.q) query.set("q", filters.q);
  return `/admin/filesv2?${query}`;
}

/** Same parameters and bounds as Activity; `null` means the page answers 400 instead of showing other filters. */
export function parseAdminActivityFilters(params: URLSearchParams): AdminActivityFilters | null {
  const own = new URLSearchParams(params);
  own.delete("path");
  const parsed = parseActivityFilters(own);
  if (!parsed || (parsed.q?.length ?? 0) > ADMIN_SEARCH_LIMIT) return null;
  const { path: _path, ...filters } = parsed;
  return filters;
}

/* ------------------------------------------------------------------ storage */

export function adminBaseLabel(base: AdminActivityBase, a: AdminHistoryMessages, locale: string) {
  if (base.kind === "users") return a.personalOf.replace("{name}", base.displayName ?? base.name);
  return base.displayName ?? groupDisplayName(base.name, locale);
}

const fullSide = (side: ActivitySide) => (side.visibility === "full" ? side : null);
const relativeTo = (path: string, base: string) => (path === base ? "" : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null);

/** Labels follow the recorded binding even when an archive moved the path outside its old prefix. */
export function sideBase(side: ActivitySide, bases: ReadonlyMap<string, AdminActivityBase>) {
  const full = fullSide(side);
  const base = full?.baseId ? bases.get(full.baseId) : undefined;
  return full && base ? base : null;
}

/** The storage of an entry: where it went, otherwise where it was. */
export const entryBase = (entry: ActivityEntry, bases: ReadonlyMap<string, AdminActivityBase>) =>
  sideBase(entry.after, bases) ?? sideBase(entry.before, bases);

/**
 * Sides carry Filegate-root paths. Inside a known storage the containing folder reads storage label first; anything
 * else keeps the raw folder path, as Activity does.
 */
export function adminPlaceDescriber(
  bases: ReadonlyMap<string, AdminActivityBase>,
  a: AdminHistoryMessages,
  locale: string,
): NonNullable<HistoryEnvironment["describePlace"]> {
  return (place: HistoryPlace) => {
    if (place.kind !== "side") return undefined;
    const base = sideBase(place.side, bases);
    if (!base || base.root !== place.side.root) return undefined;
    const relative = relativeTo(place.side.path, base.path);
    if (relative === null) return undefined;
    return [adminBaseLabel(base, a, locale), ...relative.split("/").filter(Boolean).slice(0, -1)];
  };
}

/* ------------------------------------------------------------------ table cells */

export function adminTime(entry: ActivityEntry, locale: string, env: HistoryEnvironment) {
  return `${formatDate(entry.time, locale, env)} ${formatTime(entry.time, locale, env)}`;
}

/** Who did it, short enough for a table cell: delegates name their person, findings never name one. */
export function adminWho(entry: ActivityEntry, h: HistoryMessages, a: AdminHistoryMessages, env: HistoryEnvironment) {
  const actor = actorOf(entry, h, env);
  if (actor.kind === "observed") return a.noCloudEntry;
  if (actor.kind === "visitor") return entry.action === "file.upload" ? a.uploadLink : a.publicLink;
  if (actor.kind === "delegate")
    return a.onBehalf.replace("{agent}", actor.agent ?? a.anotherApp).replace("{person}", actor.person?.name ?? h.deletedAccount);
  return actor.label;
}

/** The change, counted when a row stands for several visible entries. */
export function adminWhat(row: HistoryRowModel, a: AdminHistoryMessages) {
  const label = a[`what.${row.lead.action}`];
  return row.entries.length > 1 ? a.countSuffix.replace("{label}", label).replace("{count}", String(row.entries.length)) : label;
}

export function adminItem(row: HistoryRowModel, a: AdminHistoryMessages) {
  const name = subjectName(row.lead);
  if (!name) return null;
  return row.kind === "batch" ? a.itemAndMore.replace("{name}", name).replace("{count}", String(row.entries.length - 1)) : name;
}

/** The channel; a finding outside Cloud was only noticed, never done through a channel. */
export function adminChannel(entry: ActivityEntry, h: HistoryMessages, a: AdminHistoryMessages, env: HistoryEnvironment) {
  if (entry.actor.kind === "observed" || entry.via === "observed") return a.noticed;
  if (entry.via.startsWith("app:")) {
    const app = env.appInfo?.(entry.via.slice(4));
    return app ? a.viaApp.replace("{app}", app.label) : a.anotherApp;
  }
  return viaLabel(entry, h, env);
}

/* ------------------------------------------------------------------ export */

export type ExportFormat = ActivityExportInput["format"];
export type ExportDraft = { from: string | null; to: string | null; baseId: string | null; format: ExportFormat };
const DAY = 86_400_000;
const WHEN_DAYS: Record<ActivityWhen, number> = { today: 1, "7": 7, "30": 30, "365": 365 };
const utcDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Inclusive UTC calendar days ending today: the list's range, otherwise the approved 30 days. */
export function defaultExportPeriod(when: ActivityWhen | undefined, now: string) {
  const today = Date.parse(utcDate(Date.parse(now)));
  return { from: utcDate(today - (WHEN_DAYS[when ?? "30"] - 1) * DAY), to: utcDate(today) };
}

export type ExportRequest = { status: "ready"; input: ActivityExportInput; key: string } | { status: "missing" } | { status: "range" };

/** The export request for the dialog's choices and the list's remaining filters, checked like the server checks it. */
export function exportRequest(draft: ExportDraft, filters: AdminActivityFilters): ExportRequest {
  if (!draft.from || !draft.to) return { status: "missing" };
  const parsed = ActivityExportInput.safeParse({
    format: draft.format,
    from: draft.from,
    to: draft.to,
    ...(draft.baseId ? { baseId: draft.baseId } : {}),
    ...(filters.actor ? { actor: filters.actor } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  });
  if (!parsed.success) return { status: "range" };
  try {
    exportWindow(parsed.data);
  } catch (error) {
    if (error instanceof ActivityExportError) return { status: "range" };
    throw error;
  }
  // The count does not depend on the format; changing it keeps the counted rows.
  const { format: _format, ...counted } = parsed.data;
  return { status: "ready", input: parsed.data, key: JSON.stringify(counted) };
}

export const exportFileName = (input: ActivityExportInput) => `files-activity-${input.from}-${input.to}.${input.format}`;
