import { fuzzy } from "@k2b/stdlib";
import type { ChatCommand, ChatCommandScope, ChatCommandSection } from "./ChatComposer";
import { chatCommandKey, foldChatSearchText } from "./chat-behavior";

const wordPattern = /[^\s\-_.\/·:,()„“"']+/gu;
const words = (text: string) => [...text.matchAll(wordPattern)];
type Rank = { rank: number; highlight?: readonly [number, number] };

const prepare = (command: ChatCommand) => {
  const title = command.label ?? command.name;
  // Each folded UTF-16 position maps to the whole original character and its combining marks.
  const starts: number[] = [],
    ends: number[] = [];
  let foldedTitle = "";
  for (const part of title.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const folded = foldChatSearchText(part[0]);
    foldedTitle += folded;
    for (let i = 0; i < folded.length; i++) {
      starts.push(part.index);
      ends.push(part.index + part[0].length);
    }
  }
  return {
    foldedTitle,
    starts,
    ends,
    titleWords: words(foldedTitle),
    keywords: [...(command.keywords ?? []), ...(command.label !== undefined ? [command.name] : [])].map(foldChatSearchText),
    app: foldChatSearchText(command.app ?? ""),
    descriptionWords: words(foldChatSearchText(command.description)),
  };
};

const rankPrepared = (entry: ReturnType<typeof prepare>, query: string): Rank | null => {
  if (!query) return { rank: 0 };
  const titleMatch = (rank: number, index: number): Rank => ({
    rank,
    highlight: [entry.starts[index]!, entry.ends[index + query.length - 1]!],
  });
  if (entry.foldedTitle.startsWith(query)) return titleMatch(0, 0);
  const word = entry.titleWords.find((word) => word[0].startsWith(query));
  if (word) return titleMatch(1, word.index);
  const index = entry.foldedTitle.indexOf(query);
  if (index >= 0) return titleMatch(2, index);
  if (entry.keywords.some((word) => word.startsWith(query))) return { rank: 3 };
  if (entry.app.startsWith(query)) return { rank: 4 };
  if (query.length >= 3 && entry.descriptionWords.some((word) => word[0].startsWith(query))) return { rank: 5 };
  if (query.length >= 4) {
    for (const word of [...entry.titleWords.map((word) => word[0]), ...entry.keywords]) {
      for (const length of [query.length - 1, query.length, query.length + 1]) {
        if (word.length >= length && fuzzy.distance(query, word.slice(0, length)) <= 1) return { rank: 6 };
      }
    }
  }
  return null;
};

export const rankChatCommand = (command: ChatCommand, query: string): Rank | null =>
  rankPrepared(prepare(command), foldChatSearchText(query).trim());

export function resolveChatCommandScope(word: string, scopes: readonly ChatCommandScope[]): ChatCommandScope | undefined {
  const query = foldChatSearchText(word);
  const folded = scopes.map((scope) => ({ scope, words: scope.words.map(foldChatSearchText) }));
  const exact = folded.filter((entry) => entry.words.includes(query));
  if (exact.length) return exact.length === 1 ? exact[0]?.scope : undefined;
  if (query.length < 3) return undefined;
  let best: ChatCommandScope | undefined,
    extension = Infinity;
  for (const entry of folded) {
    const extra = Math.min(...entry.words.filter((word) => word.startsWith(query)).map((word) => word.length - query.length));
    if (extra < extension) {
      best = entry.scope;
      extension = extra;
    } else if (extra === extension) best = undefined;
  }
  return best;
}

export function parseChatCommandQuery(query: string, scopes: readonly ChatCommandScope[]): { scope?: ChatCommandScope; query: string } {
  const match = /^(\S+)\s(.*)$/s.exec(query);
  const scope = match ? resolveChatCommandScope(match[1]!, scopes) : undefined;
  return scope ? { scope, query: match![2]!.trimStart() } : { query };
}

export type ChatCommandRow = { command: ChatCommand; highlight?: readonly [number, number] };
type Group = { section?: ChatCommandSection; scopeTitle?: string; rows: ChatCommandRow[]; loading: boolean; placeholder: boolean };

export function chatCommandListModel(input: {
  query: string;
  scopes?: readonly ChatCommandScope[];
  sections?: readonly ChatCommandSection[];
  commands: readonly ChatCommand[];
  searchResults: readonly ChatCommand[];
  searchResultsFresh: boolean;
  searching: boolean;
}): { scope?: ChatCommandScope; groups: Group[]; rows: ChatCommandRow[]; empty: boolean } {
  const { scope, query: rawQuery } = parseChatCommandQuery(input.query, input.scopes ?? []);
  const query = foldChatSearchText(rawQuery).trim();
  const overview = !scope && !query;
  const groups: Group[] = scope
    ? [{ scopeTitle: scope.title, rows: [], loading: input.searching, placeholder: false }]
    : [
        ...(input.sections ?? []).map((section) => ({
          section,
          rows: [],
          loading: Boolean(section.searched && input.searching && !(overview && section.searchOnly)),
          placeholder: false,
        })),
        { rows: [], loading: !input.sections?.length && input.searching, placeholder: false },
      ];
  const bySection = new Map(groups.map((group, index) => [group.section?.id, index]));
  const buckets = groups.map(() => new Map<string, { command: ChatCommand; server: boolean }>());
  for (const [commands, server] of [
    [scope ? [] : input.commands, false],
    [input.searchResults, true],
  ] as const) {
    for (const command of commands) {
      const index = scope ? 0 : (bySection.get(command.section) ?? groups.length - 1);
      const bucket = buckets[index]!;
      const key = chatCommandKey(command);
      if (!bucket.has(key)) bucket.set(key, { command, server });
    }
  }
  const seen = new Set<string>();
  for (const [index, group] of groups.entries()) {
    // A search-only section is absent from the overview, rows and placeholder included.
    if (overview && group.section?.searchOnly) continue;
    const ranked: (ChatCommandRow & { rank: number })[] = [];
    for (const [key, { command, server }] of buckets[index]!) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (overview && command.hiddenUntilSearch) continue;
      const match = rankPrepared(prepare(command), query);
      if (!overview && !match && !(server && input.searchResultsFresh)) continue;
      ranked.push({ command, highlight: match?.highlight, rank: match?.rank ?? Infinity });
    }
    if (!overview) ranked.sort((a, b) => a.rank - b.rank);
    group.rows = ranked.map(({ command, highlight }) => ({ command, highlight }));
    group.placeholder = group.loading && group.rows.length === 0;
  }
  // A section without rows has no heading, also in the overview; a scope always shows its title.
  const visible = groups.filter((group) => scope || group.rows.length || group.loading);
  const rows = visible.flatMap((group) => group.rows);
  return { scope, groups: visible, rows, empty: rows.length === 0 && !input.searching };
}
