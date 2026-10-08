import { logger } from "@k2b/cloud/services/logging";
import { applyOutgoingMailBounce } from "@k2b/cloud/services/outgoing-mail/messages";
import { type ImapMailProfile, saveImapMailCheck } from "@k2b/cloud/services/outgoing-mail/store";
import { type BounceStructure, DSN_PART_BYTES, dsnParts, parseDsn } from "./parser";

export const BOUNCE_BATCH_SIZE = 200;
/** This interface deliberately has no flags, moves, deletes or expunge operations. */
export type BounceMailbox = {
  open: (folder: string, options: { readOnly: true }) => Promise<{ uidValidity: string }>;
  listUids: (query: { after?: number; since?: Date; limit: number }) => Promise<number[]>;
  bodyStructure: (uid: number) => Promise<BounceStructure | null>;
  fetchPart: (uid: number, part: string, maxBytes: number) => Promise<Uint8Array | null>;
  close: () => void;
};
/** Bound even injected mailbox calls; the real adapter closes its socket on abort. */
export const abortable = async <T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([run(), cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
};
export const pollProfileBounces = async (profile: ImapMailProfile, mailbox: BounceMailbox, signal: AbortSignal): Promise<void> => {
  let stage = "open mailbox";
  try {
    const opened = await abortable(() => mailbox.open(profile.imap.folder, { readOnly: true }), signal);
    const reset = profile.uidValidity === null || profile.uidValidity !== opened.uidValidity || profile.lastUid === null;
    let lastUid = reset ? null : profile.lastUid;
    stage = "search mailbox";
    const uids = await abortable(
      () =>
        mailbox.listUids({
          ...(reset ? { since: new Date(Date.now() - 7 * 24 * 60 * 60_000) } : { after: lastUid ?? 0 }),
          limit: BOUNCE_BATCH_SIZE,
        }),
      signal,
    );
    for (const uid of [...new Set(uids)]
      .filter((uid) => Number.isSafeInteger(uid) && uid > (lastUid ?? 0))
      .sort((a, b) => a - b)
      .slice(0, BOUNCE_BATCH_SIZE)) {
      stage = "read delivery report";
      const structure = await abortable(() => mailbox.bodyStructure(uid), signal);
      const parts = structure && dsnParts(structure);
      if (parts) {
        const status = await abortable(() => mailbox.fetchPart(uid, parts.status, DSN_PART_BYTES), signal);
        const headers = await abortable(() => mailbox.fetchPart(uid, parts.headers, DSN_PART_BYTES), signal);
        const report =
          status && headers && parseDsn(Buffer.from(status).toString("utf8"), Buffer.from(headers).toString("utf8"), profile.fromAddress);
        if (report) {
          stage = "apply delivery report";
          signal.throwIfAborted();
          await abortable(() => applyOutgoingMailBounce(profile.id, report.messageId, report.failures), signal);
        }
      }
      lastUid = uid;
    }
    stage = "save mailbox cursor";
    signal.throwIfAborted();
    await abortable(() => saveImapMailCheck(profile, { uidValidity: opened.uidValidity, lastUid }), signal);
  } catch {
    // Server exceptions can contain credentials and protocol frames. Store only our stage.
    const error = signal.aborted ? "Bounce polling interrupted." : `Could not ${stage}. Check the IMAP connection and configuration.`;
    try {
      // Leave at most 30 seconds for recording a failure, even after the run was aborted.
      await abortable(() => saveImapMailCheck(profile, { error }), AbortSignal.timeout(30_000));
    } finally {
      logger("outgoing-mail-bounces").error(error, { profile: profile.key });
    }
  } finally {
    mailbox.close();
  }
};
