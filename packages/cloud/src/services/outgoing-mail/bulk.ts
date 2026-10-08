export const MAIL_RECOVERY_MS = 30_000;
export const mailSlotMs = (pacePerMinute: number): number => 60_000 / pacePerMinute;
export const mailBacklogFull = (queued: number, added: number, pacePerMinute: number): boolean =>
  added > 0 && queued + added > pacePerMinute * 1440;
export const mailBatchId = (proposed: string, rows: readonly ({ batch_id: string | null } | undefined)[]): string => {
  const previous = rows[0]?.batch_id;
  return previous && rows.every((row) => row?.batch_id === previous) ? previous : proposed;
};
// Later submissions join a coalesced continuation, so long backoffs must not hide fresh mail.
export const mailNextDrainDelay = (now: number, slot: number, due: number): number =>
  Math.min(MAIL_RECOVERY_MS, Math.max(0, Math.max(slot, due) - now));
