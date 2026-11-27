import { fuzzy } from "@k2b/stdlib";

/**
 * The tools a catalog search finds: those whose text holds every word of the search. Only when none does, the fuzzy
 * matches stand in, so a typo ("pasword") still finds its tool. Fuzzy alone matched far too much: "uuid" found 12 of
 * 15 tools.
 */
export const findTools = <T>(search: string, tools: readonly T[], searchText: (tool: T) => string): T[] => {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...tools];
  const exact = tools.filter((tool) => {
    const text = searchText(tool);
    return words.every((word) => text.includes(word));
  });
  return exact.length > 0 ? exact : fuzzy.filter(words.join(" "), [...tools], { key: searchText }).map((hit) => hit.item);
};
