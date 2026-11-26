import type { MarkedEntry } from "../contracts";
import {
  dayGroups,
  dayHeading,
  dayKey,
  type HistoryEnvironment,
  type HistoryRowModel,
  type HistoryRun,
  historyRuns,
  sameActor,
} from "./history-actions";
import type { HistoryMessages } from "./history-messages";

/** A file the person opened, shown only in their own activity ("Me"); the server authorized it for this read. */
export type OpenedLine = { kind: "opened"; key: string; item: MarkedEntry };
export type ActivityLine = { item: HistoryRun | OpenedLine; repeat: boolean };
export type ActivityDay = { key: string; label: string; detail: string | null; items: ActivityLine[] };

const lineTime = (item: HistoryRun | OpenedLine) =>
  item.kind === "opened" ? item.item.markedAt : item.kind === "run" ? item.rows[0]!.lead.time : item.row.lead.time;
const lineEntry = (item: HistoryRun | OpenedLine) =>
  item.kind === "opened" ? null : item.kind === "run" ? item.rows[0]!.lead : item.row.lead;

/**
 * Day groups of rows and runs, each line knowing whether the line above names the same actor. Opened files join in
 * time order, but only as far back as the loaded changes reach while older pages remain, so a later page never
 * slips a change in above an opened file it should follow.
 */
export function activityDays(
  rows: readonly HistoryRowModel[],
  opened: readonly MarkedEntry[],
  options: { complete: boolean; locale: string; t: HistoryMessages; env: HistoryEnvironment },
): ActivityDay[] {
  const days = new Map<string, ActivityDay>();
  const day = (iso: string) => {
    const key = dayKey(iso, options.env.timeZone);
    let found = days.get(key);
    if (!found) {
      found = { key, ...dayHeading(iso, options.locale, options.t, options.env), items: [] };
      days.set(key, found);
    }
    return found;
  };
  for (const group of dayGroups(rows, options.locale, options.t, options.env))
    for (const item of historyRuns(group.rows)) day(lineTime(item)).items.push({ item, repeat: false });
  const oldest = rows.at(-1)?.entries.at(-1)?.time;
  for (const item of opened) {
    if (!options.complete && (!oldest || item.markedAt < oldest)) continue;
    day(item.markedAt).items.push({ item: { kind: "opened", key: `opened:${item.base.id}:${item.entry.path}`, item }, repeat: false });
  }
  return [...days.values()]
    .sort((a, b) => b.key.localeCompare(a.key))
    .map((group) => {
      const items = group.items.sort((a, b) => lineTime(b.item).localeCompare(lineTime(a.item)));
      return {
        ...group,
        items: items.map((line, index) => {
          const entry = lineEntry(line.item);
          const previous = index > 0 ? lineEntry(items[index - 1]!.item) : null;
          return { ...line, repeat: !!entry && !!previous && sameActor(previous, entry) };
        }),
      };
    });
}

/**
 * One line of the Activity list, flat so the list keeps only the lines in view: a change, a run of changes, a change
 * inside an open run, a member of an open batch, or an opened file.
 */
export type ActivityListLine =
  | { kind: "row"; key: string; row: HistoryRowModel; batch?: { open: boolean; count: number } }
  | { kind: "run"; key: string; rows: readonly HistoryRowModel[]; open: boolean }
  | { kind: "runRow"; key: string; row: HistoryRowModel; short: boolean }
  | { kind: "member"; key: string; row: HistoryRowModel; index: number }
  | { kind: "opened"; key: string; item: MarkedEntry };

/** The days as one list: an open run or batch follows its line with its own lines, so opening moves nothing above. */
export function activityListLines(
  days: readonly ActivityDay[],
  open: ReadonlySet<string>,
  shortRun: (rows: readonly HistoryRowModel[]) => boolean,
) {
  const lines: ActivityListLine[] = [];
  for (const day of days)
    for (const { item } of day.items) {
      if (item.kind === "opened") lines.push({ kind: "opened", key: item.key, item: item.item });
      else if (item.kind === "run") {
        const expanded = open.has(item.key);
        lines.push({ kind: "run", key: item.key, rows: item.rows, open: expanded });
        if (expanded) {
          const short = shortRun(item.rows);
          for (const row of item.rows) lines.push({ kind: "runRow", key: `${item.key}/${row.key}`, row, short });
        }
      } else {
        const row = item.row;
        const batch = row.kind === "batch" ? { open: open.has(row.key), count: row.entries.length } : undefined;
        lines.push({ kind: "row", key: row.key, row, batch });
        if (batch?.open) row.entries.forEach((_, index) => lines.push({ kind: "member", key: `${row.key}/${index}`, row, index }));
      }
    }
  return lines;
}
