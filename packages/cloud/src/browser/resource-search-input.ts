import type { SearchApp } from "../api/search/schemas";

export type SearchTag = NonNullable<SearchApp["tags"]>[number] & { appName: string; appIcon: string };

/** Keep aliases discoverable without listing the same facet repeatedly. */
export const searchTags = (apps: readonly SearchApp[], appId?: string | null): SearchTag[] => {
  const seen = new Set<string>();
  return apps
    .filter((app) => !appId || app.id === appId)
    .flatMap((app) =>
      (app.tags ?? []).flatMap((tag) => {
        if (seen.has(tag.tag)) return [];
        seen.add(tag.tag);
        return [{ ...tag, appName: app.name, appIcon: app.icon }];
      }),
    );
};

export const tagAtCursor = (text: string, caret: number) => {
  const pos = Math.min(caret, text.length);
  let start = pos;
  let end = pos;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  if (text[start] !== "#" || pos <= start || text.slice(start + 1, end).includes("#")) return null;
  return { start, end, prefix: text.slice(start + 1, pos).toLowerCase() };
};

/** Only whitespace commits a typed/pasted tag; an unfinished #prefix is not an error. */
export const commitTypedTags = (text: string, caret: number) => {
  const tags: string[] = [];
  let nextCaret = caret;
  const input = text.replace(/(^|\s)#([^\s#]+)(?=\s)/g, (match: string, space: string, tag: string, offset: number) => {
    tags.push(tag.toLowerCase());
    if (offset < caret) nextCaret -= Math.min(match.length - space.length, caret - offset - space.length);
    return space;
  });
  return { input, caret: Math.max(0, nextCaret), tags };
};

export const matchingSearchTags = (tags: readonly SearchTag[], prefix: string, selected: readonly string[]) =>
  tags.filter(
    (tag) =>
      !selected.some((value) => value === tag.tag || tag.aliases?.includes(value)) &&
      (!prefix || [tag.tag, tag.title.toLowerCase(), ...(tag.aliases ?? [])].some((value) => value.startsWith(prefix))),
  );
