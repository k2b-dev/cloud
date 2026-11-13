import { compareStreamCursor } from "./cursor";
import type { SharedTextSyncEvent } from "./types";

type Event = { cursor: string; data: SharedTextSyncEvent };
type Read = (docId: string, after: string | null, until: string, signal?: AbortSignal) => AsyncIterable<Event>;

/** Disposable contiguous history, capped at one log payload budget per binding. */
export const createSharedTextEventCache = (read: Read, maxBytes: number) => {
  let range: { docId: string; after: string | null; until: string; entries: Array<Event & { bytes: number }>; bytes: number } | undefined;
  const compare = (a: string | null, b: string | null) => (a === b ? 0 : !a ? -1 : !b ? 1 : compareStreamCursor(a, b));
  const remember = (docId: string, after: string | null, event: Event) => {
    if (range?.docId !== docId || range.until !== after) range = { docId, after, until: event.cursor, entries: [], bytes: 0 };
    const bytes = JSON.stringify(event).length * 2;
    range.entries.push({ ...event, bytes });
    range.until = event.cursor;
    range.bytes += bytes;
    while (range.bytes > maxBytes && range.entries.length) {
      const removed = range.entries.shift()!;
      range.bytes -= removed.bytes;
      range.after = removed.cursor;
    }
  };
  return {
    remember,
    async *events(docId: string, after: string | null, until: string, signal?: AbortSignal): AsyncIterable<Event> {
      if (after === until) {
        const exact = range?.docId === docId ? range.entries.find((entry) => entry.cursor === until) : undefined;
        if (exact) yield exact;
        else yield* read(docId, after, until, signal);
        return;
      }
      let from = after;
      if (range?.docId === docId && compare(after, range.after) >= 0 && compare(after, range.until) <= 0) {
        // Each iterator owns its covered bounds and entry list. A concurrent
        // document/read may replace the cache or evict entries while we yield.
        const coveredUntil = range.until;
        const coveredEntries = range.entries.slice();
        for (const entry of coveredEntries) {
          signal?.throwIfAborted();
          if (compare(entry.cursor, after) > 0 && compare(entry.cursor, until) <= 0) yield entry;
        }
        if (compare(until, coveredUntil) <= 0) return;
        from = coveredUntil;
      }
      for await (const event of read(docId, from, until, signal)) {
        remember(docId, from, event);
        from = event.cursor;
        yield event;
      }
    },
  };
};
