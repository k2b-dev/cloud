import type { ActivityEntry, HistoryAction } from "../activity-contracts";
import { actorOf, type HistoryEnvironment, placeOf, visible } from "./history-actions";
import type { HistoryMessages } from "./history-messages";

/** What a summary counts: the actions a person reads as one kind of change. */
export type ChangeKind = "added" | "changed" | "moved" | "removed" | "shared" | "other";

const KINDS: readonly [ChangeKind, readonly HistoryAction[]][] = [
  ["added", ["file.upload", "file.create", "folder.create", "item.copy", "version.restore_copy"]],
  ["changed", ["file.edit", "file.overwrite", "version.restore", "version.comment"]],
  ["moved", ["item.move", "item.rename"]],
  ["removed", ["item.trash", "item.purge", "version.delete"]],
  ["shared", ["share.create", "share.revoke"]],
];
export const changeKind = (action: HistoryAction): ChangeKind => KINDS.find(([, actions]) => actions.includes(action))?.[0] ?? "other";

export type SummaryCount = { key: string; label: string; count: number };
export type ActivitySummary = { people: SummaryCount[]; places: SummaryCount[]; kinds: (SummaryCount & { kind: ChangeKind })[] };

/** The most first, then by name; at most `limit` lines, so the column stays a glance. */
const top = <T extends SummaryCount>(counts: Map<string, T>, limit: number) =>
  [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit);

/**
 * Who changed most, where, and what kind of change, over the changes the list has loaded: the summary under Activity's
 * list, so a page of changes also reads as a picture. Bounded by the loaded pages.
 */
export function activitySummary(
  entries: readonly ActivityEntry[],
  t: HistoryMessages,
  env: HistoryEnvironment,
  limit = 5,
): ActivitySummary {
  const people = new Map<string, SummaryCount>();
  const places = new Map<string, SummaryCount>();
  const kinds = new Map<string, SummaryCount & { kind: ChangeKind }>();
  const add = <T extends SummaryCount>(map: Map<string, T>, key: string, make: () => T) => {
    const found = map.get(key) ?? make();
    found.count += 1;
    map.set(key, found);
  };
  // each change once, as the list's counter counts them: a page may bring a change again
  const counted = new Set<string>();
  for (const entry of entries) {
    if (counted.has(entry.id)) continue;
    counted.add(entry.id);
    const actor = actorOf(entry, t, env);
    const name = actor.person?.name ?? actor.label;
    // a person by who they are; two people of the same name stay two lines
    const personKey = actor.person?.userId ?? `${actor.kind}:${name}`;
    add(people, personKey, () => ({ key: personKey, label: name, count: 0 }));
    const side = visible(entry.after) ? entry.after : visible(entry.before) ? entry.before : null;
    if (side) {
      // the storage and its first folder: a place a person knows, not every subfolder; keyed by where it is
      const label = placeOf(env, { kind: "side", side }).slice(0, 2).join(" › ");
      const folder = (side.relativePath ?? side.path).split("/").filter(Boolean).slice(0, -1).slice(0, 1).join("/");
      const placeKey = `${side.publicBaseId ?? label}/${folder}`;
      if (label) add(places, placeKey, () => ({ key: placeKey, label, count: 0 }));
    }
    const kind = changeKind(entry.action);
    add(kinds, kind, () => ({ key: kind, kind, label: t[`v2Kind_${kind}`], count: 0 }));
  }
  return { people: top(people, limit), places: top(places, limit), kinds: top(kinds, KINDS.length + 1) };
}
