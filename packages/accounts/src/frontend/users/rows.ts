import type { AccountDirectoryEntry } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import type { ListMessages } from "../list-messages";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The heading a row stands under when the list is grouped: a group, or an email address. */
export type RowGroup = { id: string; name: string };
/** One line of the account list: an account, and what it stands under when the list is grouped. */
export type UserRow = { key: string; entry: AccountDirectoryEntry; group: RowGroup | null };
/** How the rows of a page are arranged: by group, by email address, or not at all. */
export type RowGrouping = "member-of" | "mail" | undefined;

/**
 * When an account was last active, as the list says it: "heute", "vor 5 Tagen" within a month, else the day. `now`
 * comes from the server for the first picture, so the server and the browser write the same words.
 */
export const lastLoginText = (iso: string | null, t: ListMessages, context: { locale: string; timeZone: string; now: Date }): string => {
  if (!iso) return t.never;
  const days = Math.floor((context.now.getTime() - Date.parse(iso)) / DAY_MS);
  if (days < 30) return new Intl.RelativeTimeFormat(context.locale, { numeric: "auto" }).format(-Math.max(0, days), "day");
  return dates.formatDate(iso, { locale: context.locale, timeZone: context.timeZone, style: "numeric" });
};

/** The address an account is grouped under, as the duplicate check compares it: trimmed, any case. */
const addressOf = (entry: AccountDirectoryEntry): string | null =>
  entry.kind === "person" && entry.mail?.trim() ? entry.mail.trim().toLowerCase() : null;

/** The headings of one account: its groups (people only), or its address. */
const headingsOf = (entry: AccountDirectoryEntry, grouping: "member-of" | "mail"): RowGroup[] => {
  if (grouping === "member-of") return entry.kind === "person" ? entry.groups : [];
  const address = addressOf(entry);
  return address ? [{ id: address, name: address }] : [];
};

/**
 * The rows of a page: one per account, or, grouped, one per account under each of its headings. Headings follow their
 * names; accounts without one come last. Within a heading the page's sort stays.
 */
export const userRows = (entries: readonly AccountDirectoryEntry[], grouping: RowGrouping, locale: string): UserRow[] => {
  if (!grouping) return entries.map((entry) => ({ key: entry.id, entry, group: null }));
  const headings = new Map<string, RowGroup>();
  for (const entry of entries) for (const heading of headingsOf(entry, grouping)) headings.set(heading.id, heading);
  const order = [...headings.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
  const rows: UserRow[] = [];
  for (const heading of order)
    for (const entry of entries)
      if (headingsOf(entry, grouping).some((own) => own.id === heading.id))
        rows.push({ key: `${heading.id}:${entry.id}`, entry, group: heading });
  for (const entry of entries)
    if (headingsOf(entry, grouping).length === 0) rows.push({ key: `none:${entry.id}`, entry, group: null });
  return rows;
};

/** How many people of the page stand in more than one group when the list is grouped by group. */
export const inSeveralGroups = (entries: readonly AccountDirectoryEntry[]): number =>
  entries.filter((entry) => entry.kind === "person" && entry.groups.length > 1).length;

/** How many addresses of the page more than one account uses, when the list is grouped by address. */
export const sharedAddresses = (entries: readonly AccountDirectoryEntry[]): number => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const address = addressOf(entry);
    if (address) counts.set(address, (counts.get(address) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
};
