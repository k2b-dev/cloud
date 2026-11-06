/** Case-insensitive literal matching: exact, name prefix, word prefix, substring. */
export const nameMatchRank = (name: string, query: string): number | null => {
  const text = name.toLowerCase();
  const q = query.toLowerCase();
  if (text === q) return 0;
  if (text.startsWith(q)) return 1;
  let offset = text.indexOf(q);
  while (offset >= 0) {
    if (!/[\p{L}\p{N}_]/u.test(Array.from(text.slice(0, offset)).at(-1) ?? "")) return 2;
    offset = text.indexOf(q, offset + 1);
  }
  return text.includes(q) ? 3 : null;
};
export type SearchCandidate<T> = { hit: T; name: string; archived: boolean; activity: string; key: string };
export const rankSearchCandidates = <T>(candidates: SearchCandidate<T>[], query: string, limit: number): T[] =>
  candidates
    .flatMap((candidate) => {
      const rank = nameMatchRank(candidate.name, query);
      return rank === null ? [] : [{ ...candidate, rank }];
    })
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) || a.rank - b.rank || b.activity.localeCompare(a.activity) || a.key.localeCompare(b.key),
    )
    .slice(0, limit)
    .map(({ hit }) => hit);
