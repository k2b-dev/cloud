import type { ActivityChain, ActivityEntry, ActivitySide, HistoryAction } from "../activity-contracts";
import type { ActivityRecovery } from "../service/activity-actions";
import type { HistoryMessageKey, HistoryMessages } from "./history-messages";

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
};

/**
 * Existing actions the parent already owns. A missing callback means the person has no such authority here, and the
 * matching button is not shown. Every callback re-checks identity, rights and target on the server.
 */
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
};

export type Part = { kind: "text"; text: string } | { kind: "name"; text: string } | { kind: "place"; segments: readonly string[] };
type Slot = readonly Part[] | string;

const text = (value: string): Part => ({ kind: "text", text: value });
const name = (value: string): Part => ({ kind: "name", text: value });

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
const sidePlace = (env: HistoryEnvironment, side: VisibleSide): Part => ({ kind: "place", segments: placeOf(env, { kind: "side", side }) });

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
  if (actor.kind === "delegate") return fill(t.onBehalf, { agent: [name(actor.agent!)], person: [name(actor.person!.name)] });
  if (actor.kind === "person") return [name(actor.label)];
  return [name(actor.label)];
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
  kind: "single" | "batch" | "saves";
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

/**
 * Presentation rows in the given order. Entries of one batch become one row at the batch's first visible entry; its
 * count is what this person can see, never the stored batch size. Consecutive editor saves of one person, channel
 * and run become one row; each save stays its own stored entry.
 */
export function historyRows(entries: readonly ActivityEntry[], options: { batches: boolean }): HistoryRowModel[] {
  const rows: HistoryRowModel[] = [];
  const batches = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
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

export type SentenceOptions = { context: SentenceContext; directory?: boolean };

function objectParts(entry: ActivityEntry, t: HistoryMessages, options: SentenceOptions): Part[] {
  const subject = subjectName(entry);
  const directory = options.directory ?? isDirectory(entry);
  const pronoun = directory === true ? t.theFolder : directory === false ? t.theFile : t.theItem;
  if (options.context === "activity") return subject ? [name(subject)] : [text(pronoun)];
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

  if (row.kind === "batch") {
    const count = row.entries.length;
    const directories = row.entries.map(isDirectory);
    const noun = directories.every((value) => value === false) ? t.filesCount : t.itemsCount;
    const many = [text(noun.replace("{count}", String(count)))];
    const targets = row.entries.map((member) => (visible(member.after) ? plain([sidePlace(env, member.after)]) : null));
    const shared = targets.every((value) => value !== null && value === targets[0]) && visible(after) ? sidePlace(env, after) : null;
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
        return fill(ongoing ? t.renamePending : t.rename, { actor, old: [name(before.name)], new: [name(after.name)] });
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
      const to = [sidePlace(env, after)];
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
  if (via) meta.push({ kind: "text", text: via });
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
export function rowAction(row: HistoryRowModel, t: HistoryMessages, actions: HistoryActions): RowAction | null {
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
  if (["item.move", "item.copy", "item.rename", "item.restore"].includes(entry.action) && isCurrent(entry.after) && actions.onOpen) {
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
 * Groups search entries by item: the stable ID where a full side has one, otherwise the visible name. Renames keep
 * one group because the stable ID survives them; without an ID a renamed item appears as two hits, which is honest.
 */
export function searchHits(entries: readonly ActivityEntry[], query: string): SearchHit[] {
  const hits = new Map<string, SearchHit>();
  for (const entry of entries) {
    let id: string | null = null;
    for (const side of [entry.after, entry.before]) if (side.visibility === "full" && side.itemId) id ??= side.itemId;
    const key = id ? `id:${id}` : `name:${(subjectName(entry) ?? entry.id).toLocaleLowerCase()}`;
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
