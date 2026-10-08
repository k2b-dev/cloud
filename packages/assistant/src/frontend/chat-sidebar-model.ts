import type { AiConversationSource, AiConversationWorkingGroup, AiFileStat } from "@k2b/cloud/ai";
import type { AssistantChatContextSnapshot, AssistantChatResult } from "../chat-context";

/**
 * The chat sidebar's information order, computed from one snapshot. Everything here is pure and depends only on the
 * snapshot's server `now` and time zone, so the server render and the browser agree on every group.
 */

/** Results of the latest delivering turn show completely up to this many; more fold into one row. */
export const CURRENT_RESULT_LIMIT = 6;
/** The first results of the latest turn show as cards with a description; the rest as compact rows. */
export const RESULT_CARD_LIMIT = 3;
export const RECENT_FILE_LIMIT = 5;
export const SOURCE_PREVIEW_LIMIT = 3;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Days that keep their own group; older entries group by month. */
const DAY_GROUP_DAYS = 7;
/** Share of the chat's storage limit from which the working files row shows the usage. */
export const STORAGE_NOTICE_SHARE = 0.7;

export type TimeGroup<T> = {
  key: string;
  kind: "day" | "month";
  /** `YYYY-MM-DD` for days, `YYYY-MM` for months, in the viewer's time zone. */
  date: string;
  /** Whole days before today, for days only. */
  daysAgo: number;
  items: T[];
};

const dayFormat = new Map<string, Intl.DateTimeFormat>();
/** `YYYY-MM-DD` of an instant in a time zone. */
export const calendarDay = (iso: string, timeZone: string): string => {
  let format = dayFormat.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormat.set(timeZone, format);
  }
  return format.format(new Date(iso));
};

const dayNumber = (day: string): number =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** Whole calendar days between an instant and `now` in a time zone; 0 for today and for the future. */
export const calendarDaysBefore = (iso: string, now: string, timeZone: string): number =>
  Math.max(0, dayNumber(calendarDay(now, timeZone)) - dayNumber(calendarDay(iso, timeZone)));

/**
 * Groups items newest first: one group per day for the last seven days, one per month before that. The order of
 * `items` inside a group follows the input.
 */
export const groupByTime = <T>(items: readonly T[], at: (item: T) => string, now: string, timeZone: string): TimeGroup<T>[] => {
  const groups = new Map<string, TimeGroup<T>>();
  const sorted = [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)));
  for (const item of sorted) {
    const day = calendarDay(at(item), timeZone);
    const daysAgo = calendarDaysBefore(at(item), now, timeZone);
    const group: Omit<TimeGroup<T>, "items"> = daysAgo < DAY_GROUP_DAYS
      ? { key: `day:${day}`, kind: "day", date: day, daysAgo }
      : { key: `month:${day.slice(0, 7)}`, kind: "month", date: day.slice(0, 7), daysAgo };
    const existing = groups.get(group.key);
    if (existing) existing.items.push(item);
    else groups.set(group.key, { ...group, items: [item] });
  }
  return [...groups.values()];
};

export type ResultsModel = {
  /** Results of the latest delivering turn that show at the top, then other results of the last 24 hours. */
  current: AssistantChatResult[];
  /** How many of `current` belong to the latest turn; the first `RESULT_CARD_LIMIT` of those are cards. */
  latestCount: number;
  /** Results of the latest turn beyond the limit, folded into one row that opens in place. */
  latestOverflow: AssistantChatResult[];
  older: TimeGroup<AssistantChatResult>[];
};

const turnOf = (result: AssistantChatResult) => result.turnId ?? `result:${result.key}`;

/**
 * What stays on top: every result of the latest turn that delivered one, however old, and further results of the last
 * 24 hours up to six entries. Everything else moves to day and month groups. Only newer results or the end of the
 * 24-hour window, judged at the snapshot's `now`, move something down.
 */
export const buildResultsModel = (results: readonly AssistantChatResult[], now: string, timeZone: string): ResultsModel => {
  const sorted = [...results].sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt) || a.key.localeCompare(b.key));
  const first = sorted[0];
  if (!first) return { current: [], latestCount: 0, latestOverflow: [], older: [] };
  const latestTurn = turnOf(first);
  const latest = sorted.filter((result) => turnOf(result) === latestTurn);
  const rest = sorted.filter((result) => turnOf(result) !== latestTurn);
  if (latest.length > CURRENT_RESULT_LIMIT) {
    const shown = latest.slice(0, CURRENT_RESULT_LIMIT - 1);
    return {
      current: shown,
      latestCount: shown.length,
      latestOverflow: latest.slice(shown.length),
      older: groupByTime(rest, (r) => r.deliveredAt, now, timeZone),
    };
  }
  const since = Date.parse(now) - RECENT_WINDOW_MS;
  const extra: AssistantChatResult[] = [];
  const older: AssistantChatResult[] = [];
  for (const result of rest) {
    if (latest.length + extra.length < CURRENT_RESULT_LIMIT && Date.parse(result.deliveredAt) >= since) extra.push(result);
    else older.push(result);
  }
  return {
    current: [...latest, ...extra],
    latestCount: latest.length,
    latestOverflow: [],
    older: groupByTime(older, (r) => r.deliveredAt, now, timeZone),
  };
};

export type FilesModel = {
  recent: AiFileStat[];
  older: TimeGroup<AiFileStat>[];
  olderCount: number;
  voice: AiFileStat[];
  count: number;
};

/** Your files: what the user uploaded. Voice recordings fold into their own row. */
export const buildFilesModel = (files: readonly AiFileStat[], now: string, timeZone: string): FilesModel => {
  const uploads = files
    .filter((file) => file.origin === "user" && !file.dictationRecordedAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const voice = files.filter((file) => file.dictationRecordedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const olderFiles = uploads.slice(RECENT_FILE_LIMIT);
  return {
    recent: uploads.slice(0, RECENT_FILE_LIMIT),
    older: groupByTime(olderFiles, (file) => file.updatedAt, now, timeZone),
    olderCount: olderFiles.length,
    voice,
    count: uploads.length + voice.length,
  };
};

export type FileKind = "html" | "image" | "table" | "pdf" | "script" | "text" | "other";

export const fileKind = (mediaType: string, path = ""): FileKind => {
  const type = mediaType.toLowerCase();
  if (type === "text/html") return "html";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type === "text/csv" || type.includes("spreadsheet") || type.includes("excel") || /\.(csv|tsv|xlsx?|ods)$/iu.test(path))
    return "table";
  if (type.includes("javascript") || type.includes("typescript") || type.includes("python") || /\.(py|js|ts|sh|sql)$/iu.test(path))
    return "script";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "other";
};

export type WorkingGroup = {
  key: string;
  /** Folder below `/temp/`; null for the group of loose working files. */
  folder: string | null;
  /** The result this group prepared, when the folder carries its file name. */
  resultTitle: string | null;
  count: number;
  bytes: number;
  updatedAt: string;
  /** Files known up front: loose working files and assistant files outside `temp/` that it never delivered. */
  files: AiFileStat[];
};

export type WorkingModel = {
  count: number;
  /** Count per file kind, largest first. */
  kinds: Array<{ kind: FileKind; count: number }>;
  groups: TimeGroup<WorkingGroup>[];
  /** Groups the snapshot left out because the chat has more than it carries. */
  hiddenGroups: number;
  storage: { usedBytes: number; maxBytes: number; notice: boolean };
};

const stem = (name: string) =>
  name
    .replace(/^.*\//u, "")
    .replace(/\.[^.]+$/u, "")
    .toLocaleLowerCase()
    .replace(/[\s_]+/gu, "-");

/**
 * Working files: everything below `/temp/`, grouped by its first folder (the purpose the assistant gave it), plus
 * assistant files outside `temp/` that it never delivered. A folder named like a result's file name reads "for ‹result›".
 */
export const buildWorkingModel = (snapshot: AssistantChatContextSnapshot): WorkingModel => {
  const resultPaths = new Set(snapshot.results.flatMap((result) => (result.file ? [result.file.path] : [])));
  const undelivered = snapshot.files.filter((file) => file.origin !== "user" && !file.dictationRecordedAt && !resultPaths.has(file.path));
  const resultByStem = new Map(
    snapshot.results.flatMap((result) => (result.file ? [[stem(result.file.path), result.title] as const] : [])).reverse(),
  );
  const kindCounts = new Map<FileKind, number>();
  const count = (kind: FileKind, amount: number) => kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + amount);
  const folderGroups: WorkingGroup[] = snapshot.working.groups.flatMap((group: AiConversationWorkingGroup) => {
    for (const [mediaType, amount] of Object.entries(group.mediaTypes)) count(fileKind(mediaType), amount);
    if (group.folder === null) return [];
    return [
      {
        key: `folder:${group.folder}`,
        folder: group.folder,
        resultTitle: resultByStem.get(stem(group.folder)) ?? null,
        count: group.count,
        bytes: group.bytes,
        updatedAt: group.updatedAt,
        files: [],
      },
    ];
  });
  for (const file of undelivered) count(fileKind(file.mediaType, file.path), 1);
  const loose = [...snapshot.working.looseFiles, ...undelivered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const looseRoot = snapshot.working.groups.find((group) => group.folder === null);
  const groups =
    loose.length || looseRoot
      ? [
          ...folderGroups,
          {
            key: "other",
            folder: null,
            resultTitle: null,
            count: (looseRoot?.count ?? 0) + undelivered.length,
            bytes: (looseRoot?.bytes ?? 0) + undelivered.reduce((sum, file) => sum + file.size, 0),
            updatedAt: loose[0]?.updatedAt ?? looseRoot!.updatedAt,
            files: loose,
          },
        ]
      : folderGroups;
  const { usedBytes, maxBytes } = snapshot.storage;
  return {
    count: snapshot.working.count + undelivered.length,
    kinds: [...kindCounts].map(([kind, amount]) => ({ kind, count: amount })).sort((a, b) => b.count - a.count),
    groups: groupByTime(groups, (group) => group.updatedAt, snapshot.now, snapshot.timeZone),
    hiddenGroups: Math.max(0, snapshot.working.groupCount - snapshot.working.groups.length),
    storage: { usedBytes, maxBytes, notice: maxBytes > 0 && usedBytes / maxBytes >= STORAGE_NOTICE_SHARE },
  };
};

export type SourceEntry =
  | { kind: "web"; key: string; at: string; source: AiConversationSource }
  | { kind: "search"; key: string; at: string; source: AiConversationSource }
  | { kind: "cloud"; key: string; at: string; items: AiConversationSource[] };

/**
 * Sources as people meet them: a read web page, a web search with its query, or the Cloud items one tool call read,
 * bundled into one entry. Newest first.
 */
export const buildSourceEntries = (sources: readonly AiConversationSource[]): SourceEntry[] => {
  const entries: SourceEntry[] = [];
  const bundles = new Map<string, Extract<SourceEntry, { kind: "cloud" }>>();
  for (const source of sources) {
    if (source.kind === "web") entries.push({ kind: "web", key: `web:${source.key}`, at: source.lastSeenAt, source });
    else if (source.kind === "activity") entries.push({ kind: "search", key: `search:${source.key}`, at: source.lastSeenAt, source });
    else if (source.kind === "resource") {
      const call = source.sourceCallId ?? `resource:${source.key}`;
      const bundle = bundles.get(call);
      if (bundle) {
        bundle.items.push(source);
        if (source.lastSeenAt > bundle.at) bundle.at = source.lastSeenAt;
      } else {
        const entry = { kind: "cloud" as const, key: `cloud:${call}`, at: source.lastSeenAt, items: [source] };
        bundles.set(call, entry);
        entries.push(entry);
      }
    }
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key));
};

export type ChatSearchMatches = {
  results: AssistantChatResult[];
  /** Files with their path; a delivered file the snapshot does not carry as a result shows here under its title. */
  files: Array<{ path: string; title: string; mediaType: string | null; size: number | null }>;
  sources: AiConversationSource[];
};

/**
 * What a sidebar search shows: results the server matched, or whose title, description, or path matches the query
 * (an app's current title lives only in the snapshot), then files, then sources. A delivered file shows once.
 */
export const matchChatSearch = (
  results: readonly AssistantChatResult[],
  hits: readonly AiConversationSource[],
  query: string,
): ChatSearchMatches => {
  const needle = query.trim().toLocaleLowerCase();
  const matched = new Set(hits.flatMap((hit) => (hit.kind === "result" ? [hit.key] : [])));
  const shown = results.filter(
    (result) =>
      matched.has(result.key) ||
      (needle.length > 0 && `${result.title} ${result.description ?? ""} ${result.file?.path ?? ""}`.toLocaleLowerCase().includes(needle)),
  );
  const paths = new Set(shown.flatMap((result) => (result.file ? [result.file.path] : [])));
  const files: ChatSearchMatches["files"] = [];
  for (const hit of hits) {
    const path = hit.kind === "file" ? hit.key : hit.kind === "result" ? hit.path : null;
    if (!path || paths.has(path) || (hit.kind === "result" && hit.size === null)) continue;
    paths.add(path);
    files.push({ path, title: hit.title, mediaType: hit.mediaType, size: hit.size });
  }
  return { results: shown, files, sources: hits.filter((hit) => hit.kind === "web" || hit.kind === "activity" || hit.kind === "resource") };
};

/** The results stored in a working folder: deleting the folder deletes them too. */
export const resultsInFolder = (results: readonly AssistantChatResult[], folder: string): AssistantChatResult[] =>
  results.filter((result) => result.file?.path.startsWith(`/temp/${folder}/`));
