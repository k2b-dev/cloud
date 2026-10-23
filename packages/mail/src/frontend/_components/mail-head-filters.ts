import type { MailSearchExpression, MailSearchState } from "../../contracts";
import type { ResolvedMailSearchRoute } from "../../search-url";
import { buildMailSearchClearHref, buildMailSearchHref, MAIL_SEARCH_FROM_PARAMETER } from "./mail-navigation";

type DateTerm = Extract<MailSearchExpression, { type: "date" }>;
/** Derived from the URL expression, never a second filter store. */
export type MailHeadFilters = {
  folderId: string | null;
  unread: boolean;
  flagged: boolean;
  attachment: boolean;
  tagId: string | null;
  dates: DateTerm[];
};

export const emptyMailHeadFilters = (folderId: string | null): MailHeadFilters => ({
  folderId,
  unread: false,
  flagged: false,
  attachment: false,
  tagId: null,
  dates: [],
});

/** Only the simple conjunction represented by the chips. Arbitrary trees stay in the search builder. */
export function readMailHeadFilters(url: URL, search: ResolvedMailSearchRoute, effectiveFolderId: string | null): MailHeadFilters | null {
  if (search.error || search.query || url.searchParams.has("savedView")) return null;
  if (!search.expression) return emptyMailHeadFilters(effectiveFolderId);
  const terms = search.expression.type === "and" ? search.expression.expressions : [search.expression];
  const folders = terms.filter((term) => term.type === "folder_id");
  if (folders.length > 1) return null;
  const result = emptyMailHeadFilters(folders[0]?.folderId ?? null);
  const seen = new Set<string>();
  for (const term of terms) {
    const key = term.type === "date" ? `${term.type}:${term.operator}` : term.type;
    if (seen.has(key)) return null;
    seen.add(key);
    switch (term.type) {
      case "folder_id":
        break;
      case "local_tag_id":
        result.tagId = term.tagId;
        break;
      case "unread":
      case "flagged":
        if (!result.folderId || term.folderId !== result.folderId) return null;
        result[term.type] = true;
        break;
      case "size":
        if (!result.folderId || term.field !== "attachment" || term.operator !== "at_least" || term.bytes !== 0) return null;
        result.attachment = true;
        break;
      case "date":
        if (!result.folderId || term.field !== "internal_date" || !["on_or_after", "before"].includes(term.operator)) return null;
        result.dates.push(term);
        break;
      default:
        return null;
    }
  }
  return result;
}

export function mailHeadFilterState(filters: MailHeadFilters): MailSearchState | null {
  const terms: MailSearchExpression[] = [];
  if (filters.folderId) terms.push({ type: "folder_id", folderId: filters.folderId });
  if (filters.folderId && filters.unread) terms.push({ type: "unread", folderId: filters.folderId });
  if (filters.folderId && filters.flagged) terms.push({ type: "flagged", folderId: filters.folderId });
  if (filters.attachment) terms.push({ type: "size", field: "attachment", operator: "at_least", bytes: 0 });
  terms.push(...filters.dates);
  if (filters.tagId) terms.push({ type: "local_tag_id", tagId: filters.tagId });
  if (!terms.length) return null;
  return { expression: terms.length === 1 ? terms[0]! : { type: "and", expressions: terms }, sort: "newest" };
}

export function mailHeadFilterSource(url: URL, current: MailHeadFilters | null): URL {
  const source = new URL(url);
  if (current && !source.searchParams.has(MAIL_SEARCH_FROM_PARAMETER)) {
    // A direct chip URL has no recorded starting view. Its search is the current filter,
    // not an origin to restore when the final chip is removed.
    source.searchParams.delete("search");
    if (current.folderId) {
      source.searchParams.delete("view");
      source.searchParams.delete("savedView");
      source.searchParams.set("folder", current.folderId);
    }
  }
  return source;
}

export function mailHeadFilterHref(url: URL, filters: MailHeadFilters, current: MailHeadFilters | null = filters): string {
  const source = mailHeadFilterSource(url, current);
  if (!filters.unread && !filters.flagged && !filters.attachment && !filters.tagId && filters.dates.length === 0)
    return buildMailSearchClearHref(source);
  const state = mailHeadFilterState(filters)!;
  const search: Record<string, string> = { search: JSON.stringify(state) };
  // A tag retains the existing All-tab presentation. Its expression still keeps the originating folder.
  if (filters.folderId && !filters.tagId) search.folder = filters.folderId;
  return buildMailSearchHref(source, search);
}

/** Fixed instants make a bookmarked range stable on Back/reload; a new choice starts a new range. */
export const mailHeadFilterDays = (days: 7 | 30, now: number): DateTerm[] => [
  { type: "date", field: "internal_date", operator: "on_or_after", value: new Date(now - days * 86_400_000).toISOString() },
  { type: "date", field: "internal_date", operator: "before", value: new Date(now).toISOString() },
];

export function mailHeadFilterDayCount(dates: DateTerm[]): 7 | 30 | null {
  const start = dates.find((date) => date.operator === "on_or_after");
  const end = dates.find((date) => date.operator === "before");
  if (!start || !end) return null;
  const days = (Date.parse(end.value) - Date.parse(start.value)) / 86_400_000;
  return days === 7 || days === 30 ? days : null;
}
