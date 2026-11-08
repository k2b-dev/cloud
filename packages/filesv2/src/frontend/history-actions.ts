import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { ActivityChain, ActivityEntry, ActivitySide, HistoryAction } from "../activity-contracts";
import type { ActivityRecovery } from "../service/activity-actions";
import type { HistoryMessageKey, HistoryMessages } from "./history-messages";
import { filesUrl } from "./urls";

export type VisibleSide = Exclude<ActivitySide, { visibility: "hidden" }>;
export type FullSide = Extract<ActivitySide, { visibility: "full" }>;
/** A side the reader resolved against current access just now; the only side a row may navigate to. */
export type CurrentSide = FullSide & { source: "current"; publicBaseId: string };
export type ChainEndpoint = NonNullable<ActivityChain["endpoint"]>;
/** Something whose containing folder the parent can name, base label first. */
export type HistoryPlace = { kind: "side"; side: VisibleSide } | { kind: "endpoint"; endpoint: ChainEndpoint };
/** A navigation request. The parent re-authorizes it before showing the place. */
export type HistoryTarget = { kind: "side"; side: CurrentSide } | { kind: "endpoint"; endpoint: ChainEndpoint };
export type RestoreOutcome = { status: "restored" } | { status: "name_conflict" };

/** Request-scoped presentation context. `now` and `timeZone` come from SSR so server and client agree. */
export type HistoryEnvironment = {
  now: string;
  timeZone: string;
  /** Breadcrumb of the folder that contains a place, base label first. Without one the raw folder path is shown. */
  describePlace?: (place: HistoryPlace) => readonly string[] | undefined;
  /** Display name and Tabler icon of a calling application; unknown applications read "Another app". */
  appInfo?: (appId: string) => { label: string; icon?: string } | undefined;
  /** URL of a supported execution page. Rows link "View run" only when this returns a URL. */
  executionHref?: (entry: ActivityEntry) => string | null | undefined;
  /** The workspace's in-app navigation for links to items and folders; without it they load the page. */
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
};

/**
 * Existing actions the parent already owns. A missing callback means the person has no such authority here, and the
 * matching button is not shown. Every callback re-checks identity, rights and target on the server.
 */
export type ActivityVersion = { current: number | null; restorable: number | null; restore?: () => Promise<void> };

export type HistoryActions = {
  onOpen?: (target: HistoryTarget) => void;
  onRecheck?: (entry: ActivityEntry) => Promise<void>;
  onRestoreTrash?: (entry: ActivityEntry, options?: { name: string }) => Promise<RestoreOutcome>;
  /** Opens the trash of the storage the server named in the entry's recovery options. */
  onShowTrash?: (trash: NonNullable<ActivityRecovery["trash"]>) => void;
  onMoveBack?: (entry: ActivityEntry, endpoint: ChainEndpoint) => Promise<void>;
  /** Opens the old folder the server just checked as readable; never a place taken from a stored entry. */
  onOpenOldLocation?: (place: NonNullable<ActivityRecovery["oldLocation"]>) => void;
  /**
   * Current recovery options of one entry. With it, a vanished item offers restore, move back, the trash and the old
   * place only where the server allows them now; every action still checks again when it runs.
   */
  loadRecovery?: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityRecovery>;
  onContact?: (person: { userId: string; name: string }) => void;
  onShowVersions?: (entry: ActivityEntry) => void;
  /** Version numbers the parent can map from its version list; `restorable` is the version a row may bring back. */
  version?: (entry: ActivityEntry) => { current: number | null; restorable: number | null } | null;
  onRestoreVersion?: (entry: ActivityEntry) => Promise<void>;
  /** Supplementary current version evidence for activity rows; reads remain permission-aware and cancellable. */
  loadVersion?: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityVersion | null>;
};

/**
 * Sentence pieces. `name` is an item and the strong element; `href` is set only for a side the reader resolved as
 * current for this viewer, and `hint` names why an item no longer leads anywhere. `actor` names who acted.
 * A place's `hrefs` hold one address per segment, or null where the segment is not a known current folder.
 */
export type Part =
  | { kind: "text"; text: string }
  | { kind: "actor"; text: string }
  | { kind: "name"; text: string; href?: string; hint?: string }
  | { kind: "place"; segments: readonly string[]; hrefs?: readonly (string | null)[] };
type Slot = readonly Part[] | string;

const text = (value: string): Part => ({ kind: "text", text: value });
const name = (value: string): Part => ({ kind: "name", text: value });
const actorName = (value: string): Part => ({ kind: "actor", text: value });

/** Replaces `{slot}` placeholders in a catalog sentence. Unknown placeholders stay literal so a gap is visible. */
export function fill(template: string, slots: Record<string, Slot>): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const slot = slots[match[1]!];
    if (slot === undefined) continue;
    if (match.index > last) parts.push(text(template.slice(last, match.index)));
    if (typeof slot === "string") parts.push(text(slot));
    else parts.push(...slot);
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push(text(template.slice(last)));
  return parts;
}
export const plain = (parts: readonly Part[]) =>
  parts.map((part) => (part.kind === "place" ? part.segments.join(" › ") : part.text)).join("");

export const visible = (side: ActivitySide): side is VisibleSide => side.visibility !== "hidden";
/** Stored snapshots describe what happened; only a current side authorizes navigation. */
export const isCurrent = (side: ActivitySide): side is CurrentSide =>
  side.visibility === "full" && side.source === "current" && side.publicBaseId !== null;

/** The visible name of the entry's subject, preferring where it went over where it was. */
export const subjectName = (entry: ActivityEntry) =>
  visible(entry.after) ? entry.after.name : visible(entry.before) ? entry.before.name : null;
const subjectSide = (entry: ActivityEntry) => (visible(entry.after) ? entry.after : visible(entry.before) ? entry.before : null);
export const isDirectory = (entry: ActivityEntry): boolean | null => {
  for (const side of [entry.after, entry.before]) if (side.visibility !== "hidden" && side.directory !== null) return side.directory;
  return null;
};

const folderSegments = (path: string) => path.split("/").filter(Boolean).slice(0, -1);
export function placeOf(env: HistoryEnvironment, place: HistoryPlace): readonly string[] {
  const described = env.describePlace?.(place);
  if (described) return described;
  return folderSegments(place.kind === "side" ? place.side.path : place.endpoint.path);
}
/** Where a current side is now: a folder opens as its listing, a file in its folder with its detail. */
export const sideHref = (side: CurrentSide): string | null => {
  if (side.relativePath == null) return null;
  if (side.directory) return filesUrl(side.publicBaseId, side.relativePath);
  return filesUrl(side.publicBaseId, side.relativePath.split("/").slice(0, -1).join("/"), null, side.relativePath);
};
/**
 * The containing folders of a side. With `links`, each segment of a current side's described place opens that
 * folder; the described place starts with the storage label, then the base-relative folders.
 */
const sidePlace = (env: HistoryEnvironment, side: VisibleSide, links = false): Part => {
  const segments = placeOf(env, { kind: "side", side });
  if (!links || !isCurrent(side) || side.relativePath == null || !env.describePlace?.({ kind: "side", side }))
    return { kind: "place", segments };
  const folders = side.relativePath.split("/").filter(Boolean).slice(0, -1);
  if (segments.length !== folders.length + 1) return { kind: "place", segments };
  const baseId = side.publicBaseId;
  return { kind: "place", segments, hrefs: segments.map((_, index) => filesUrl(baseId, folders.slice(0, index).join("/"))) };
};
/** The subject's name, leading to it while the reader still finds it; otherwise plain with a short hint. */
const subjectPart = (side: ActivitySide, entry: ActivityEntry, t: HistoryMessages, links: boolean): Part | null => {
  if (!visible(side)) return null;
  if (!links || entry.state !== "done") return name(side.name);
  if (isCurrent(side)) {
    const href = sideHref(side);
    return href ? { kind: "name", text: side.name, href } : name(side.name);
  }
  // The sentence already says the item left; a vanished trash or purge subject needs no second hint.
  if (entry.action === "item.trash" || entry.action === "item.purge" || entry.action === "item.missing") return name(side.name);
  return { kind: "name", text: side.name, hint: t.noLongerAvailable };
};

/* ------------------------------------------------------------------ actors */

export type ActorView = {
  kind: "person" | "delegate" | "visitor" | "system" | "observed";
  /** Accessible and avatar name. */
  label: string;
  person: { userId: string | null; name: string } | null;
  agent: string | null;
  icon: string | null;
};

const assistantVia = (entry: ActivityEntry) => entry.via === "agent" || entry.execution?.origin === "assistant";
const appId = (entry: ActivityEntry) => (entry.via.startsWith("app:") ? entry.via.slice(4) : (entry.execution?.callingApp ?? null));

export function actorOf(entry: ActivityEntry, t: HistoryMessages, env: HistoryEnvironment): ActorView {
  if (entry.actor.kind === "observed") return { kind: "observed", label: t.noCloudEntry, person: null, agent: null, icon: "ti ti-server" };
  if (entry.actor.kind === "system") return { kind: "system", label: t.filesSystem, person: null, agent: null, icon: "ti ti-settings" };
  if (entry.actor.kind === "visitor") {
    const label = entry.action === "file.upload" ? t.uploadLinkVisitor : t.linkVisitor;
    return { kind: "visitor", label, person: null, agent: null, icon: "ti ti-link" };
  }
  // Names are never stored; a missing name means the account no longer exists.
  const person = { userId: entry.actor.userId, name: entry.actor.name ?? t.deletedAccount };
  if (assistantVia(entry)) return { kind: "delegate", label: t.assistant, person, agent: t.assistant, icon: "ti ti-sparkles" };
  const app = entry.via.startsWith("app:") ? appId(entry) : null;
  if (app) {
    const info = env.appInfo?.(app);
    return {
      kind: "delegate",
      label: info?.label ?? t.anotherApp,
      person,
      agent: info?.label ?? t.anotherApp,
      icon: info?.icon ?? "ti ti-apps",
    };
  }
  return { kind: "person", label: person.name, person, agent: null, icon: null };
}

export function actorParts(actor: ActorView, t: HistoryMessages): Part[] {
  if (actor.kind === "delegate") return fill(t.onBehalf, { agent: [actorName(actor.agent!)], person: [actorName(actor.person!.name)] });
  return [actorName(actor.label)];
}
/** "by Lukas Pohl" or "by the Assistant on behalf of Lukas Pohl", for sentences that start with the change. */
export function byParts(actor: ActorView, t: HistoryMessages, env: HistoryEnvironment, entry: ActivityEntry): Part[] {
  if (actor.kind === "delegate") {
    const known = !entry.via.startsWith("app:") || env.appInfo?.(appId(entry) ?? "");
    const template = assistantVia(entry) ? t.byDelegate : t.byApp;
    return fill(template, { agent: [text(known ? actor.agent! : t.anotherAppBy)], person: [text(actor.person!.name)] });
  }
  return fill(t.byPerson, { actor: actor.label });
}

export function viaLabel(entry: ActivityEntry, t: HistoryMessages, env: HistoryEnvironment): string | null {
  const labels: Record<string, string> = {
    web: t.viaWeb,
    app: t.viaApp,
    api: t.viaApi,
    cli: t.viaCli,
    office: t.viaOffice,
    agent: t.viaAgent,
    link: t.viaLink,
    system: t.viaSystem,
  };
  if (entry.via.startsWith("app:")) {
    const info = env.appInfo?.(entry.via.slice(4));
    return info ? plain(fill(t.viaOtherApp, { app: info.label })) : null;
  }
  return labels[entry.via] ?? null;
}

/* ------------------------------------------------------------------ dates */

const parts = (iso: string, timeZone: string) => {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(values.year), key: `${values.year}-${values.month}-${values.day}` };
};
const dayNumber = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 86_400_000;
export const dayKey = (iso: string, timeZone: string) => parts(iso, timeZone).key;
/** Calendar days between two instants in one zone: 0 today, 1 yesterday. */
export const daysAgo = (iso: string, env: HistoryEnvironment) =>
  dayNumber(dayKey(env.now, env.timeZone)) - dayNumber(dayKey(iso, env.timeZone));

export function formatTime(iso: string, locale: string, env: HistoryEnvironment) {
  return new Intl.DateTimeFormat(locale, { timeZone: env.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
export function formatDate(iso: string, locale: string, env: HistoryEnvironment, weekday = false) {
  const otherYear = parts(iso, env.timeZone).year !== parts(env.now, env.timeZone).year;
  return new Intl.DateTimeFormat(locale, {
    timeZone: env.timeZone,
    day: "2-digit",
    month: "2-digit",
    ...(otherYear ? { year: "numeric" } : {}),
    ...(weekday ? { weekday: "long" } : {}),
  }).format(new Date(iso));
}
/** "today, 08:52", "yesterday, 17:20" or "15.10., 11:03". */
export function formatWhen(iso: string, locale: string, t: HistoryMessages, env: HistoryEnvironment) {
  const ago = daysAgo(iso, env);
  const day =
    ago === 0 ? t.today.toLocaleLowerCase(locale) : ago === 1 ? t.yesterday.toLocaleLowerCase(locale) : formatDate(iso, locale, env);
  return `${day}, ${formatTime(iso, locale, env)}`;
}
/** Day heading: "Today" with "Tuesday, 20.10." beside it, or the dated weekday alone. */
export function dayHeading(iso: string, locale: string, t: HistoryMessages, env: HistoryEnvironment) {
  const ago = daysAgo(iso, env);
  const date = formatDate(iso, locale, env, true);
  if (ago === 0) return { label: t.today, detail: date };
  if (ago === 1) return { label: t.yesterday, detail: date };
  return { label: date, detail: null };
}

/* ------------------------------------------------------------------ rows */

export type HistoryRowModel = {
  key: string;
  /** `renameMove`: one item renamed and moved by one person at one time, newer entry first. */
  kind: "single" | "batch" | "saves" | "renameMove";
  /** Newest entry first. The row's time, actor and state come from the lead. */
  entries: readonly ActivityEntry[];
  lead: ActivityEntry;
};

const saveGroup = (entry: ActivityEntry) =>
  entry.action === "file.edit" && entry.state === "done"
    ? JSON.stringify([
        entry.actor.kind,
        entry.actor.userId,
        entry.via,
        entry.execution?.invocationId ?? null,
        subjectSide(entry)?.path ?? null,
      ])
    : null;

const RELOCATIONS = new Set<HistoryAction>(["item.rename", "item.move"]);
/** One minute: a rename and a move, or a run of changes, this close together read as one operation. */
const SAME_TIME_MS = 60_000;
const actorKey = (entry: ActivityEntry) => JSON.stringify([entry.actor.kind, entry.actor.userId, entry.via]);
/** Same person or delegate on the same channel, so a following line may leave out the avatar. */
export const sameActor = (a: ActivityEntry, b: ActivityEntry) => actorKey(a) === actorKey(b);
/** The full place one side of a finished rename or move names, for chaining it with the other half. */
const pairKey = (entry: ActivityEntry, side: "before" | "after") => {
  const value = entry[side];
  if (!RELOCATIONS.has(entry.action) || entry.state !== "done" || value.visibility === "hidden") return null;
  return JSON.stringify([value.visibility === "full" ? value.root : null, value.path]);
};
/** A newer and an older entry are one rename-and-move when one person did both halves to one item at one time. */
function pairs(newer: ActivityEntry, older: ActivityEntry) {
  if (newer.action === older.action || actorKey(newer) !== actorKey(older)) return false;
  if (Math.abs(Date.parse(newer.time) - Date.parse(older.time)) > SAME_TIME_MS) return false;
  for (const side of ["before", "after"] as const)
    if (newer[side].visibility === "hidden" || older[side].visibility === "hidden") return false;
  const ids = [newer.before, older.after].map((side) => (side.visibility === "full" ? side.itemId : null));
  return !(ids[0] && ids[1] && ids[0] !== ids[1]);
}

/**
 * Presentation rows in the given order. Entries of one batch become one row at the batch's first visible entry; its
 * count is what this person can see, never the stored batch size. Consecutive editor saves of one person, channel
 * and run become one row; each save stays its own stored entry.
 */
export function historyRows(entries: readonly ActivityEntry[], options: { batches: boolean; merge?: boolean }): HistoryRowModel[] {
  const rows: HistoryRowModel[] = [];
  const batches = new Map<string, ActivityEntry[]>();
  // Unpaired newer renames and moves, by the place they started from, for joining the older half of the same change.
  const open = new Map<string, number>();
  for (const entry of entries) {
    if (options.merge) {
      const older = pairKey(entry, "after");
      const index = older ? open.get(older) : undefined;
      const newer = index === undefined ? undefined : rows[index];
      if (index !== undefined && newer && pairs(newer.lead, entry)) {
        rows[index] = { ...newer, key: `pair:${newer.lead.id}`, kind: "renameMove", entries: [newer.lead, entry] };
        open.delete(older!);
        continue;
      }
      const key = pairKey(entry, "before");
      if (key && !(options.batches && entry.batchId)) open.set(key, rows.length);
    }
    if (options.batches && entry.batchId) {
      const members = batches.get(entry.batchId);
      if (members) {
        members.push(entry);
        continue;
      }
      const created = [entry];
      batches.set(entry.batchId, created);
      rows.push({ key: `batch:${entry.batchId}`, kind: "single", entries: created, lead: entry });
      continue;
    }
    const previous = rows.at(-1);
    const group = saveGroup(entry);
    if (group && previous && !previous.key.startsWith("batch:") && saveGroup(previous.lead) === group) {
      rows[rows.length - 1] = { ...previous, kind: "saves", entries: [...previous.entries, entry] };
      continue;
    }
    rows.push({ key: entry.id, kind: "single", entries: [entry], lead: entry });
  }
  return rows.map((row) => (row.key.startsWith("batch:") && row.entries.length > 1 ? { ...row, kind: "batch" } : row));
}

/** A run of at least this many changes by one person at one time collapses into one expandable line. */
export const RUN_MIN = 5;
export type HistoryRun = { kind: "row"; row: HistoryRowModel } | { kind: "run"; key: string; rows: HistoryRowModel[] };

const runnable = (row: HistoryRowModel) =>
  (row.kind === "single" || row.kind === "renameMove") && row.lead.state === "done" && row.lead.actor.kind !== "observed";
/**
 * Presentation only: consecutive finished changes of one person and channel, each within a minute of the previous
 * one, become one run once there are `RUN_MIN` of them. Rows keep their order; the stored history is unchanged.
 */
export function historyRuns(rows: readonly HistoryRowModel[]): HistoryRun[] {
  const result: HistoryRun[] = [];
  let pending: HistoryRowModel[] = [];
  const flush = () => {
    if (pending.length >= RUN_MIN) result.push({ kind: "run", key: `run:${pending.at(-1)!.key}`, rows: pending });
    else for (const row of pending) result.push({ kind: "row", row });
    pending = [];
  };
  for (const row of rows) {
    const last = pending.at(-1);
    if (
      last &&
      !(
        runnable(row) &&
        actorKey(row.lead) === actorKey(last.lead) &&
        Math.abs(Date.parse(last.entries.at(-1)!.time) - Date.parse(row.lead.time)) <= SAME_TIME_MS
      )
    )
      flush();
    if (runnable(row)) pending.push(row);
    else result.push({ kind: "row", row });
  }
  flush();
  return result;
}

const RUN_VERBS: Partial<Record<HistoryAction, HistoryMessageKey>> = {
  "item.rename": "runRenamed",
  "item.move": "runMoved",
  "file.upload": "runUploaded",
  "folder.create": "runCreated",
  "file.create": "runCreated",
  "file.edit": "runEdited",
  "file.overwrite": "runOverwritten",
  "item.copy": "runCopied",
  "item.trash": "runTrashed",
  "item.restore": "runRestored",
};
/** "Valentin Kolb renamed and moved 12 files": the actor, at most two kinds of change, and the visible count. */
export function runSentence(rows: readonly HistoryRowModel[], t: HistoryMessages, env: HistoryEnvironment, locale: string): Part[] {
  const actor = actorParts(actorOf(rows[0]!.lead, t, env), t);
  const entries = rows.flatMap((row) => row.entries);
  // A fixed order, so "renamed and moved" reads the same whichever half the reader returned first.
  const order = Object.values(RUN_VERBS);
  const verbs = [...new Set(entries.map((entry) => RUN_VERBS[entry.action] ?? "runChanged"))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  const words = verbs.length > 2 || verbs.includes("runChanged") ? [t.runChanged] : verbs.map((verb) => t[verb]);
  const directories = rows.map((row) => isDirectory(row.lead));
  const noun = directories.every((value) => value === false)
    ? t.filesCount
    : directories.every((value) => value === true)
      ? t.foldersCount
      : t.itemsCount;
  return fill(t.runSummary, {
    actor,
    verbs: new Intl.ListFormat(locale, { type: "conjunction" }).format(words),
    count: noun.replace("{count}", String(rows.length)),
  });
}

export type DayGroup = { key: string; label: string; detail: string | null; rows: HistoryRowModel[] };
export function dayGroups(rows: readonly HistoryRowModel[], locale: string, t: HistoryMessages, env: HistoryEnvironment): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const key = dayKey(row.lead.time, env.timeZone);
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, ...dayHeading(row.lead.time, locale, t, env), rows: [row] });
  }
  return groups;
}

/* ------------------------------------------------------------------ sentences */

/**
 * - `activity`: the subject by name, as in a list across many items;
 * - `item`: inside one item's detail, the subject is "the file" or "the folder";
 * - `chain`: the history of a vanished item, with origin and destination.
 */
export type SentenceContext = "activity" | "item" | "chain";

const ONGOING: Partial<Record<HistoryAction, HistoryMessageKey>> = {
  "folder.create": "createPending",
  "file.create": "createPending",
  "file.upload": "uploadPending",
  "file.overwrite": "overwritePending",
  "file.edit": "editPending",
  "item.rename": "renamePending",
  "item.copy": "copyPending",
  "item.trash": "trashPending",
  "item.restore": "restorePending",
  "item.purge": "purgePending",
};
const DONE: Partial<Record<HistoryAction, HistoryMessageKey>> = {
  "folder.create": "create",
  "file.create": "create",
  "file.upload": "upload",
  "file.overwrite": "overwrite",
  "file.edit": "edit",
  "item.trash": "trash",
  "item.restore": "restore",
  "item.purge": "purge",
  "version.restore": "versionRestore",
  "version.restore_copy": "versionRestoreCopy",
  "version.comment": "versionComment",
  "version.delete": "versionDelete",
  "share.create": "shareCreate",
  "share.revoke": "shareRevoke",
  "place.provision": "placeProvision",
  "place.archive": "placeArchive",
  "place.restore": "placeRestore",
  "place.retire": "placeRetire",
  "admin.read": "adminRead",
  "item.differs": "differs",
  "item.elsewhere": "elsewhere",
  "item.missing": "missing",
};

/**
 * `links` makes names and folders of current sides lead there, as in the activity list. `member` is a line inside a
 * run, which already names the actor: common finished changes then name only the change.
 */
export type SentenceOptions = { context: SentenceContext; directory?: boolean; links?: boolean; member?: boolean };

/** The change alone, for a line inside a run; null where only the full sentence says it right. */
function memberParts(row: HistoryRowModel, t: HistoryMessages, env: HistoryEnvironment, links: boolean): Part[] | null {
  const entry = row.lead;
  if (entry.state !== "done" || row.kind === "batch" || row.kind === "saves") return null;
  const { before, after } = entry;
  const now = (side: VisibleSide) => subjectPart(side, entry, t, links) ?? name(side.name);
  if (row.kind === "renameMove") {
    const rename = row.entries.find((member) => member.action === "item.rename")!;
    if (!visible(rename.before) || !visible(after)) return null;
    // The old name is history, the new one the item: only the new name is the strong element.
    return fill(t.memberRenameMove, { old: [text(rename.before.name)], new: [now(after)], to: [sidePlace(env, after, links)] });
  }
  const object = () => {
    const side = subjectSide(entry);
    return side ? [now(side)] : null;
  };
  switch (entry.action) {
    case "item.rename":
      return visible(before) && visible(after) ? fill(t.memberRename, { old: [text(before.name)], new: [now(after)] }) : null;
    case "item.move":
    case "item.copy":
      if (!visible(before) || !visible(after)) return null;
      return fill(entry.action === "item.move" ? t.memberMove : t.memberCopy, { object: [now(after)], to: [sidePlace(env, after, links)] });
    case "file.upload":
    case "folder.create":
    case "file.create": {
      const parts = object();
      return parts ? fill(entry.action === "file.upload" ? t.memberUpload : t.memberCreate, { object: parts }) : null;
    }
    case "item.trash": {
      const parts = object();
      return parts ? fill(t.memberTrash, { object: parts }) : null;
    }
    default:
      return null;
  }
}

function objectParts(entry: ActivityEntry, t: HistoryMessages, options: SentenceOptions): Part[] {
  const subject = subjectName(entry);
  const directory = options.directory ?? isDirectory(entry);
  const pronoun = directory === true ? t.theFolder : directory === false ? t.theFile : t.theItem;
  if (options.context === "activity") {
    const side = subjectSide(entry);
    const part = side ? subjectPart(side, entry, t, !!options.links) : null;
    return part ? [part] : [text(pronoun)];
  }
  if (options.context === "chain" && (entry.action === "folder.create" || entry.action === "file.create") && subject)
    return [text(`${pronoun} `), name(subject)];
  return [text(pronoun)];
}

/** One sentence per row: who did what to which item, and from where to where when that matters. */
export function sentence(row: HistoryRowModel, t: HistoryMessages, env: HistoryEnvironment, options: SentenceOptions): Part[] {
  const entry = row.lead;
  const actor = actorParts(actorOf(entry, t, env), t);
  const object = objectParts(entry, t, options);
  const ongoing = entry.state !== "done";
  const { before, after } = entry;
  const links = !!options.links && options.context === "activity";
  const member = options.member && options.context === "activity" ? memberParts(row, t, env, links) : null;
  if (member) return member;

  if (row.kind === "renameMove") {
    const rename = row.entries.find((member) => member.action === "item.rename")!;
    const move = row.entries.find((member) => member.action === "item.move")!;
    // The newer of both ends where the item is now; the older one's names lead nowhere by themselves.
    if (visible(rename.before) && visible(rename.after) && visible(move.after) && visible(after)) {
      const now = subjectPart(after, entry, t, links) ?? name(rename.after.name);
      return fill(t.renameMove, {
        actor,
        old: [text(rename.before.name)],
        new: [now],
        to: [sidePlace(env, after, links)],
      });
    }
  }

  if (row.kind === "batch") {
    const count = row.entries.length;
    const directories = row.entries.map(isDirectory);
    const noun = directories.every((value) => value === false) ? t.filesCount : t.itemsCount;
    const many = [text(noun.replace("{count}", String(count)))];
    const targets = row.entries.map((member) => (visible(member.after) ? plain([sidePlace(env, member.after)]) : null));
    const shared = targets.every((value) => value !== null && value === targets[0]) && visible(after) ? sidePlace(env, after, links) : null;
    if (entry.action === "item.move" || entry.action === "item.copy") {
      const copy = entry.action === "item.copy";
      if (!shared) return fill(copy ? t.copyManyAnywhere : t.moveManyAnywhere, { actor, count: many });
      return fill(copy ? t.copyMany : ongoing ? t.moveManyPending : t.moveMany, { actor, count: many, to: [shared] });
    }
    if (entry.action === "item.trash") return fill(t.trashMany, { actor, count: many });
    if ((entry.action === "file.upload" || entry.action === "folder.create" || entry.action === "file.create") && shared)
      return fill(entry.action === "file.upload" ? t.uploadMany : t.createMany, { actor, count: many, at: [shared] });
  }

  switch (entry.action) {
    case "item.rename": {
      if (visible(before) && visible(after))
        return fill(ongoing ? t.renamePending : t.rename, {
          actor,
          old: [name(before.name)],
          new: [subjectPart(after, entry, t, links) ?? name(after.name)],
        });
      return fill(t.renameOne, { actor, object });
    }
    case "item.move":
    case "item.copy": {
      const copy = entry.action === "item.copy";
      const from = visible(before) ? [sidePlace(env, before)] : null;
      if (!visible(after)) {
        if (!copy && options.context === "chain" && from) return fill(t.moveFromHidden, { actor, object, from });
        return fill(copy ? t.copyHidden : ongoing ? t.moveHiddenPending : t.moveHidden, { actor, object });
      }
      const to = [sidePlace(env, after, links)];
      if (!from) return fill(copy ? t.copyFromHiddenSource : t.moveFromHiddenSource, { actor, object, to });
      if (!copy && options.context === "chain") return fill(ongoing ? t.moveFromPending : t.moveFrom, { actor, object, from, to });
      return fill(copy ? (ongoing ? t.copyPending : t.copy) : ongoing ? t.movePending : t.move, { actor, object, to });
    }
    case "item.missing":
      return fill(options.context === "chain" ? t.missingNoticed : t.missing, { object });
    case "item.differs":
    case "item.elsewhere":
      return fill(t[DONE[entry.action]!], { object });
    case "folder.create":
    case "file.create":
    case "file.upload":
      if (options.context === "chain" && !ongoing && visible(after)) {
        const at = [sidePlace(env, after)];
        return fill(entry.action === "file.upload" ? t.uploadIn : t.createIn, { actor, object, at });
      }
  }
  const key = (ongoing ? ONGOING[entry.action] : undefined) ?? DONE[entry.action] ?? "otherAction";
  return fill(t[key], { actor, object });
}

export type ChainHop = ActivityChain["hops"][number];
/** A later chain step as an entry for naming its actor; the reader marks every step a completed move. */
export const hopEntry = (hop: ChainHop): ActivityEntry => ({
  id: hop.activityId,
  action: "item.move",
  state: "done",
  time: hop.time,
  startedAt: hop.time,
  finishedAt: hop.time,
  actor: hop.actor,
  via: hop.via,
  before: hop.before,
  after: hop.after,
  batchId: null,
});

/** A later step of a chain that is not among the loaded entries, named with the actor the reader shares. */
export function hopSentence(hop: ChainHop, t: HistoryMessages, env: HistoryEnvironment): Part[] {
  if (!visible(hop.after)) return [];
  const to = [sidePlace(env, hop.after)];
  const actor = actorParts(actorOf(hopEntry(hop), t, env), t);
  return visible(hop.before)
    ? fill(t.hopMovedFromBy, { actor, from: [sidePlace(env, hop.before)], to })
    : fill(t.hopMovedBy, { actor, to });
}

/* ------------------------------------------------------------------ meta and state */

export type MetaPart =
  | { kind: "status"; tone: "running" | "warning" | "error" | "neutral"; label: string; icon: string }
  | { kind: "text"; text: string }
  /** The channel, such as "API"; compact rows show it as a small tag. */
  | { kind: "via"; text: string }
  | { kind: "time"; iso: string; text: string }
  | { kind: "link"; href: string; label: string };

export function statusOf(entry: ActivityEntry, t: HistoryMessages): Extract<MetaPart, { kind: "status" }> | null {
  if (entry.state === "pending") return { kind: "status", tone: "running", label: t.running, icon: "ti ti-loader-2" };
  if (entry.state === "unclear") return { kind: "status", tone: "warning", label: t.unclear, icon: "ti ti-alert-triangle" };
  if (entry.state === "failed") return { kind: "status", tone: "error", label: t.failed, icon: "ti ti-alert-circle" };
  if (entry.state === "not_done") return { kind: "status", tone: "neutral", label: t.notDone, icon: "ti ti-circle-off" };
  return null;
}

export function metaParts(
  row: HistoryRowModel,
  t: HistoryMessages,
  locale: string,
  env: HistoryEnvironment,
  options: { context: SentenceContext; dated: boolean; actions?: HistoryActions; others?: number },
): MetaPart[] {
  const entry = row.lead;
  const when = options.dated ? formatTime(entry.time, locale, env) : formatWhen(entry.time, locale, t, env);
  if (entry.actor.kind === "observed")
    return [
      { kind: "time", iso: entry.time, text: options.dated ? t.noticedAt.replace("{time}", when) : when },
      { kind: "text", text: t.noCloudEntry },
      { kind: "text", text: t.causeUnknown },
    ];
  const meta: MetaPart[] = [];
  const status = statusOf(entry, t);
  if (status) meta.push(status);
  meta.push({ kind: "time", iso: entry.time, text: when });
  const via = viaLabel(entry, t, env);
  if (via) meta.push({ kind: "via", text: via });
  if (row.kind === "saves") meta.push({ kind: "text", text: t.savedTimes.replace("{count}", String(row.entries.length)) });
  if (options.others) meta.push({ kind: "text", text: t.withOthers.replace("{count}", String(options.others)) });
  if (entry.action === "share.create" && entry.share?.expiresAt)
    meta.push({ kind: "text", text: t.validUntil.replace("{date}", formatDate(entry.share.expiresAt, locale, env)) });
  const version = options.actions?.version?.(entry)?.current;
  if (version) meta.push({ kind: "text", text: t.versionN.replace("{n}", String(version)) });
  if (entry.state === "unclear") meta.push({ kind: "text", text: t.seekingProof });
  const href = entry.execution ? env.executionHref?.(entry) : null;
  if (href) meta.push({ kind: "link", href, label: t.viewExecution });
  return meta;
}

/** `restoresTrash` marks a trash restore; the row then runs the shared name-conflict flow instead of `run` alone. */
export type RowAction = { label: string; icon: string; run: () => void | Promise<unknown>; restoresTrash?: ActivityEntry };

/** At most one action per row, the one that answers the row's most likely next question. */
export function rowAction(
  row: HistoryRowModel,
  t: HistoryMessages,
  actions: HistoryActions,
  /** With `links`, the item's name already leads where it is now, so no separate jump action is offered. */
  options: { links?: boolean } = {},
): RowAction | null {
  const entry = row.lead;
  if (entry.state === "unclear" && actions.onRecheck)
    return { label: t.recheck, icon: "ti ti-refresh", run: () => actions.onRecheck!(entry) };
  if (entry.state !== "done") return null;
  // Versions belong to the item where it is now; only a side the reader just resolved can lead there.
  if (entry.action === "item.differs" && actions.onShowVersions && (isCurrent(entry.after) || isCurrent(entry.before)))
    return { label: t.showVersions, icon: "ti ti-versions", run: () => actions.onShowVersions!(entry) };
  if ((entry.action === "file.overwrite" || entry.action === "file.edit") && actions.onRestoreVersion) {
    const restorable = actions.version?.(entry)?.restorable;
    if (restorable)
      return {
        label: t.restoreVersion.replace("{n}", String(restorable)),
        icon: "ti ti-restore",
        run: () => actions.onRestoreVersion!(entry),
      };
  }
  if (entry.action === "item.trash" && row.kind !== "batch" && actions.onRestoreTrash && visible(entry.before))
    return { label: t.restoreItem, icon: "ti ti-arrow-back-up", run: () => actions.onRestoreTrash!(entry), restoresTrash: entry };
  if (
    !options.links &&
    ["item.move", "item.copy", "item.rename", "item.restore"].includes(entry.action) &&
    isCurrent(entry.after) &&
    actions.onOpen
  ) {
    const side = entry.after;
    return { label: t.jumpThere, icon: "ti ti-arrow-right", run: () => actions.onOpen!({ kind: "side", side }) };
  }
  return null;
}

/* ------------------------------------------------------------------ vanished items */

export type MissingCase = "moved" | "trash" | "purged" | "outside" | "unclear" | "hidden";

/** Why an item is no longer where the person expects it, from its newest visible entry. */
export function missingCase(entry: ActivityEntry): MissingCase | null {
  const relocates = entry.action === "item.move" || entry.action === "item.rename" || entry.action === "item.trash";
  if (relocates && (entry.state === "pending" || entry.state === "unclear")) return "unclear";
  if (entry.state !== "done") return null;
  if (entry.action === "item.purge") return "purged";
  if (entry.action === "item.trash") return "trash";
  if (entry.action === "item.missing") return "outside";
  if (entry.action === "item.move" || entry.action === "item.rename") return visible(entry.after) ? "moved" : "hidden";
  return null;
}

export type SearchHit = { key: string; entries: ActivityEntry[]; lead: ActivityEntry };

/**
 * Group only identities established by visible scope. A public base on a full side ties its root/binding to
 * the current server; an unbound historical snapshot cannot establish that scope. Missing evidence stays separate.
 */
export function searchHits(entries: readonly ActivityEntry[], query: string): SearchHit[] {
  const hits = new Map<string, SearchHit>();
  for (const entry of entries) {
    let key = `entry:${entry.id}`;
    for (const side of [entry.after, entry.before]) {
      if (side.visibility === "full" && side.root && side.baseId && side.publicBaseId) {
        key = JSON.stringify([side.root, side.baseId, side.publicBaseId, side.itemId ? "id" : "path", side.itemId || side.path]);
        break;
      }
      if (side.visibility === "disappearance" && side.publicBaseId && side.relativePath != null) {
        key = JSON.stringify(["disappearance", side.publicBaseId, side.path, side.relativePath]);
        break;
      }
    }
    const hit = hits.get(key);
    if (hit) hit.entries.push(entry);
    else hits.set(key, { key, entries: [entry], lead: entry });
  }
  const wanted = query.trim().toLocaleLowerCase();
  const names = (hit: SearchHit) =>
    hit.entries.flatMap((entry) => [entry.before, entry.after].filter(visible).map((side) => side.name.toLocaleLowerCase()));
  const all = [...hits.values()];
  const exact = all.findIndex((hit) => names(hit).includes(wanted));
  if (exact > 0) all.unshift(...all.splice(exact, 1));
  return all;
}
