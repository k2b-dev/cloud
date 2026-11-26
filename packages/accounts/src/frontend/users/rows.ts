import type { UserDirectoryEntry } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import type { ListMessages } from "../list-messages";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One line of the user list: an account, and the group it stands under when the list is grouped. */
export type UserRow = { key: string; entry: UserDirectoryEntry; group: { id: string; name: string } | null };

/**
 * When an account last signed in, as the list says it: "heute", "vor 5 Tagen" within a month, else the day. `now`
 * comes from the server for the first picture, so the server and the browser write the same words.
 */
export const lastLoginText = (iso: string | null, t: ListMessages, context: { locale: string; timeZone: string; now: Date }): string => {
  if (!iso) return t.never;
  const days = Math.floor((context.now.getTime() - Date.parse(iso)) / DAY_MS);
  if (days < 30) return new Intl.RelativeTimeFormat(context.locale, { numeric: "auto" }).format(-Math.max(0, days), "day");
  return dates.formatDate(iso, { locale: context.locale, timeZone: context.timeZone, style: "numeric" });
};

/** The rows of a page: one per account, or, grouped by group, one per account in each of its groups. */
export const userRows = (entries: readonly UserDirectoryEntry[], grouped: boolean, locale: string): UserRow[] => {
  if (!grouped) return entries.map((entry) => ({ key: entry.id, entry, group: null }));
  // The groups follow their names; accounts without a group come last. Within a group the page's sort stays.
  const groups = new Map<string, { id: string; name: string }>();
  for (const entry of entries) for (const group of entry.groups) groups.set(group.id, group);
  const order = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
  const rows: UserRow[] = [];
  for (const group of order)
    for (const entry of entries)
      if (entry.groups.some((own) => own.id === group.id)) rows.push({ key: `${group.id}:${entry.id}`, entry, group });
  for (const entry of entries) if (entry.groups.length === 0) rows.push({ key: `none:${entry.id}`, entry, group: null });
  return rows;
};

/** How many accounts of the page stand in more than one group when the list is grouped. */
export const inSeveralGroups = (entries: readonly UserDirectoryEntry[]): number =>
  entries.filter((entry) => entry.groups.length > 1).length;
