import type { NoteRecord } from "./model";

/** The server answers for at most 200 read links per request. */
const BATCH = 200;
/** Five requests per poll stay at 15 a minute, below the server's 50 per address. */
const MAX_BATCHES = 5;

/** Shared notes to ask about, the most recently changed first, in batches the server accepts. */
export function presenceBatches(records: NoteRecord[]): { id: string; readId: string }[][] {
  const shared = records
    .flatMap((record) => (record.share ? [{ id: record.id, readId: record.share.readId, updatedAt: record.updatedAt }] : []))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, BATCH * MAX_BATCHES)
    .map(({ id, readId }) => ({ id, readId }));
  const batches: { id: string; readId: string }[][] = [];
  for (let start = 0; start < shared.length; start += BATCH) batches.push(shared.slice(start, start + BATCH));
  return batches;
}
