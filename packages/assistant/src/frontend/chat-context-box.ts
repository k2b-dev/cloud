import type { AssistantChatContextGroup, AssistantChatContextSnapshot, AssistantChatResult } from "../chat-context";
import { fileKind } from "./chat-sidebar-model";

/** Entries a group shows in the box before "Show all". */
export const CONTEXT_BOX_GROUP_LIMIT = 3;
/** The box never grows beyond this many entry rows, the two summary lines included. */
export const CONTEXT_BOX_ROW_LIMIT = 10;

export type ContextBoxTone = "warn" | "ok" | "ai" | "danger";

/** Where a jump to the chat lands: the message that holds the delivering call. */
export type ContextBoxJump = { messageSeq: number; callId: string | null; presentationId?: string | null };

/** What a click on a row does: open the thing as a tab, or jump to its place in the chat. */
export type ContextBoxOpen =
  | { kind: "file"; path: string; title: string }
  | { kind: "jump"; target: ContextBoxJump }
  | { kind: "href"; href: string }
  | { kind: "none" };

/** The one action that shows while the pointer rests on a row. */
export type ContextBoxHover =
  | { kind: "download"; path: string; name: string }
  | { kind: "jump"; target: ContextBoxJump }
  | { kind: "href"; href: string; label: string; icon: string }
  | null;

export type ContextBoxRow = {
  key: string;
  icon: string;
  /** An app tile instead of a plain sign; automations carry one. */
  tile?: { accent?: string };
  title: string;
  /** The fixed place at the row's end: time, size, or a state word. */
  trailing: string;
  tone?: ContextBoxTone;
  /** The thing waits for the person: its tile carries a ring. */
  attention?: boolean;
  /** The full text behind a faded title or state word. */
  tooltip: string;
  open: ContextBoxOpen;
  hover: ContextBoxHover;
};

export type ContextBoxGroup = { key: string; label: string; count: number; rows: ContextBoxRow[]; more: boolean };

export type ContextBoxModel = {
  /** Nothing to show yet: the box says what will appear here. */
  empty: boolean;
  results: ContextBoxGroup;
  /** Further groups the snapshot carries, such as automations; each only needs data, not code here. */
  groups: ContextBoxGroup[];
  sources: string | null;
  context: string;
};

export type ContextBoxCopy = {
  results: string;
  sourcesSummary: (counts: { named: readonly string[]; pages: number; searches: number; items: number }) => string;
  contextSummary: (parts: { project: string | null; skills: number; memories: number; routines: number }) => string;
  /** The context line when the chat has no project, skills, memories, or routines. */
  contextFallback: string;
  showInChat: string;
};

const kindIcon: Record<ReturnType<typeof fileKind>, string> = {
  html: "ti ti-file-type-html",
  image: "ti ti-photo",
  table: "ti ti-table",
  pdf: "ti ti-file-type-pdf",
  script: "ti ti-file-code",
  text: "ti ti-file-text",
  other: "ti ti-file",
};

const resultJump = (result: AssistantChatResult): ContextBoxJump | null =>
  result.messageSeq === null
    ? null
    : { messageSeq: result.messageSeq, callId: result.callId, presentationId: result.presentationId ?? null };

const calendarDay = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** "13:40" today, "Thu" within the last six days, otherwise "12 Nov": from the server's clock, so both renders agree. */
export const contextBoxWhen = (iso: string, now: string, timeZone: string, locale: string): string => {
  const day = calendarDay(iso, timeZone);
  const today = calendarDay(now, timeZone);
  if (day === today) return new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);
  if (days > 0 && days < 7) return new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" }).format(new Date(iso));
  return new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" }).format(new Date(iso));
};

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const contextBoxResultRow = (
  result: AssistantChatResult,
  input: { now: string; timeZone: string; locale: string; formatSize: (bytes: number) => string; copy: Pick<ContextBoxCopy, "showInChat"> },
): ContextBoxRow => {
  const jump = resultJump(result);
  const trailing = result.file
    ? input.formatSize(result.file.size)
    : contextBoxWhen(result.deliveredAt, input.now, input.timeZone, input.locale);
  return {
    key: `result:${result.key}`,
    icon: result.file ? kindIcon[fileKind(result.file.mediaType, result.file.path)] : result.icon,
    title: result.title,
    trailing,
    tooltip: result.description ? `${result.title} · ${result.description}` : result.title,
    open: result.file
      ? { kind: "file", path: result.file.path, title: result.title }
      : jump
        ? { kind: "jump", target: jump }
        : { kind: "none" },
    // Files download from the row; anything else shows where it came from.
    hover: result.file
      ? { kind: "download", path: result.file.path, name: fileName(result.file.path) }
      : jump
        ? { kind: "jump", target: jump }
        : null,
  };
};

const groupRow = (row: AssistantChatContextGroup["rows"][number]): ContextBoxRow => ({
  key: `${row.key}`,
  icon: row.icon,
  tile: { accent: row.accent },
  title: row.title,
  trailing: row.word,
  tone: row.tone,
  attention: row.attention,
  tooltip: row.tooltip ?? `${row.title} · ${row.word}`,
  open: row.jump ? { kind: "jump", target: row.jump } : row.href ? { kind: "href", href: row.href } : { kind: "none" },
  hover: row.action ? { kind: "href", href: row.action.href, label: row.action.label, icon: row.action.icon } : null,
});

/**
 * What the chat read, by kind: Cloud items in their app's own nouns where it names them ("3 Mails"), the rest as items,
 * then web pages and searches. Counted from the snapshot's first page of sources.
 */
export const contextBoxSourceCounts = (snapshot: Pick<AssistantChatContextSnapshot, "sources" | "resourceCounts">) => {
  const named = snapshot.resourceCounts ?? [];
  const namedCount = named.reduce((sum, entry) => sum + entry.count, 0);
  return {
    named: named.toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label)).map((entry) => entry.label),
    pages: snapshot.sources.filter((source) => source.kind === "web").length,
    searches: snapshot.sources.filter((source) => source.kind === "activity").length,
    items: Math.max(0, snapshot.sources.filter((source) => source.kind === "resource").length - namedCount),
  };
};

/**
 * The box: the three newest results, further groups the snapshot carries, then one line for sources and one for the
 * chat's context. The same data as the "In this chat" tab, drawn as at most ten rows.
 */
export const buildContextBoxModel = (
  snapshot: AssistantChatContextSnapshot,
  input: { locale: string; formatSize: (bytes: number) => string; copy: ContextBoxCopy; project: string | null },
): ContextBoxModel => {
  const newest = snapshot.results.toSorted((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt) || a.key.localeCompare(b.key));
  const results: ContextBoxGroup = {
    key: "results",
    label: input.copy.results,
    count: snapshot.results.length,
    rows: newest
      .slice(0, CONTEXT_BOX_GROUP_LIMIT)
      .map((result) => contextBoxResultRow(result, { now: snapshot.now, timeZone: snapshot.timeZone, ...input })),
    more: snapshot.results.length > CONTEXT_BOX_GROUP_LIMIT || snapshot.resultsTruncated,
  };
  const counts = contextBoxSourceCounts(snapshot);
  const sources = snapshot.sourceCount > 0 ? input.copy.sourcesSummary(counts) : null;
  // Routines are gone on feat/code; the summary keeps its slot at zero.
  const routines = 0;
  // Always there: the tab "Context" also holds the chat's secrets and approvals.
  const context =
    input.copy.contextSummary({ project: input.project, skills: snapshot.skills.length, memories: snapshot.memories.length, routines }) ||
    input.copy.contextFallback;
  let budget = CONTEXT_BOX_ROW_LIMIT - Math.max(results.rows.length, 1) - (sources ? 1 : 0) - 1;
  const groups = (snapshot.groups ?? []).flatMap((group): ContextBoxGroup[] => {
    if (budget <= 0) return [];
    const rows = group.rows.slice(0, Math.min(CONTEXT_BOX_GROUP_LIMIT, budget)).map(groupRow);
    budget -= Math.max(rows.length, 1);
    return [{ key: group.key, label: group.label, count: group.count, rows, more: group.count > rows.length }];
  });
  return {
    empty: snapshot.results.length === 0 && groups.every((group) => group.count === 0) && !sources,
    results,
    groups,
    sources,
    context,
  };
};

/** Results and group rows that are new or changed since the snapshot the box holds while the person reads it. */
export const contextBoxPending = (held: AssistantChatContextSnapshot, live: AssistantChatContextSnapshot): number => {
  const before = new Map(held.results.map((result) => [result.key, result.deliveredAt]));
  const results = live.results.filter((result) => before.get(result.key) !== result.deliveredAt).length;
  const rows = (snapshot: AssistantChatContextSnapshot) =>
    new Map((snapshot.groups ?? []).flatMap((group) => group.rows.map((row) => [`${group.key}:${row.key}`, `${row.word}\0${row.title}`])));
  const heldRows = rows(held);
  const groupChanges = [...rows(live)].filter(([key, value]) => heldRows.get(key) !== value).length;
  return results + groupChanges;
};
