import { fuzzy } from "@k2b/stdlib";
import { deriveLines } from "./derive";
import type { NoteRecord } from "./model";

export type Ranges = ReadonlyArray<readonly [number, number]>;
export type SearchResults = {
  notes: { noteId: string; record: NoteRecord; title: string; ranges: Ranges }[];
  text: { noteId: string; line: string; ranges: Ranges }[];
  headings: { noteId: string; heading: string; ranges: Ranges }[];
  tags: { tag: string; count: number; ranges: Ranges }[];
};

/** Each group contains at most four results. Ranges use end-exclusive UTF-16 offsets. */
export function search(query: string, notes: { record: NoteRecord; text: string }[], opts: { limit?: number } = {}): SearchResults {
  const result: SearchResults = { notes: [], text: [], headings: [], tags: [] };
  const q = query.trim();
  if (!q) return result;
  const limit = Math.max(0, Math.min(4, opts.limit ?? 4));
  result.notes = fuzzy.filter(q, notes, { key: (note) => note.record.meta.title, limit }).map((hit) => ({
    noteId: hit.item.record.id,
    record: hit.item.record,
    title: hit.target,
    ranges: hit.ranges,
  }));
  const compact = (ranges: Ranges, extra: number) => (ranges.at(-1)?.[1] ?? 0) - (ranges[0]?.[0] ?? 0) <= q.length + extra;
  const headings = notes.flatMap((note) => note.record.meta.headings.map((heading) => ({ noteId: note.record.id, heading })));
  result.headings = fuzzy
    .filter(q, headings, { key: (item) => item.heading })
    .filter((hit) => compact(hit.ranges, 3))
    .slice(0, limit)
    .map((hit) => ({ ...hit.item, ranges: hit.ranges }));
  const counts = new Map<string, number>();
  for (const note of notes) for (const tag of new Set(note.record.meta.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  result.tags = fuzzy
    .filter(q, [...counts.keys()])
    .filter((hit) => compact(hit.ranges, 2))
    .slice(0, limit)
    .map((hit) => ({ tag: hit.item, count: counts.get(hit.item) ?? 0, ranges: hit.ranges }));
  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  for (const note of notes) {
    for (const line of deriveLines(note.text)) {
      const match = pattern.exec(line);
      if (!match || result.text.length >= limit) continue;
      const index = match.index;
      const start = Math.max(0, index - Math.floor(Math.max(0, 90 - q.length) / 2));
      const end = Math.min(line.length, Math.max(start + 90, index + q.length));
      const prefix = start ? "…" : "";
      result.text.push({
        noteId: note.record.id,
        line: prefix + line.slice(start, end) + (end < line.length ? "…" : ""),
        ranges: [[index - start + prefix.length, index - start + prefix.length + q.length]],
      });
    }
  }
  return result;
}
