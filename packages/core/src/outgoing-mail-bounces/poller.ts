import type { MailBounceErrorCode } from "@k2b/cloud/contracts";
import { logger } from "@k2b/cloud/services/logging";
import { applyOutgoingMailBounce } from "@k2b/cloud/services/outgoing-mail/messages";
import { type ImapMailProfile, saveImapMailCheck } from "@k2b/cloud/services/outgoing-mail/store";
import { type BounceStructure, type DeliveryReport, DSN_PART_BYTES, dsnParts, parseDsn } from "./parser";

export const BOUNCE_BATCH_SIZE = 200;
export const BOUNCE_ERROR_WRITE_BUDGET_MS = 30_000;
/** This interface deliberately has no flags, moves, deletes or expunge operations. */
export type BounceMailbox = {
  open: (folder: string, options: { readOnly: true }) => Promise<{ uidValidity: string }>;
  listUids: (query: { after?: number; since?: Date; limit: number }) => Promise<{ uids: number[]; through: number }>;
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
export const pollProfileBounces = async (profile: ImapMailProfile, connect: () => BounceMailbox, signal: AbortSignal): Promise<void> => {
  let mailbox: BounceMailbox | undefined;
  let uidValidity: string | undefined;
  let lastUid = profile.lastUid;
  let stage: MailBounceErrorCode = "open_failed";
  const open = async () => {
    stage = "open_failed";
    mailbox?.close();
    mailbox = connect();
    const opened = await abortable(() => mailbox!.open(profile.imap.folder, { readOnly: true }), signal);
    if (uidValidity !== undefined && uidValidity !== opened.uidValidity) throw new Error("Mailbox UIDVALIDITY changed during polling.");
    return opened;
  };
  const readReport = async (uid: number) => {
    const structure = await abortable(() => mailbox!.bodyStructure(uid), signal);
    const parts = structure && dsnParts(structure);
    if (!parts) return null;
    const status = await abortable(() => mailbox!.fetchPart(uid, parts.status, DSN_PART_BYTES), signal);
    const headers = await abortable(() => mailbox!.fetchPart(uid, parts.headers, DSN_PART_BYTES), signal);
    return status && headers ? parseDsn(Buffer.from(status).toString("utf8"), Buffer.from(headers).toString("utf8")) : null;
  };
  try {
    const opened = await open();
    uidValidity = opened.uidValidity;
    const reset = profile.uidValidity === null || profile.uidValidity !== uidValidity || profile.lastUid === null;
    lastUid = reset ? null : profile.lastUid;
    stage = "search_failed";
    const scan = await abortable(
      () =>
        mailbox!.listUids({
          ...(reset ? { since: new Date(Date.now() - 7 * 24 * 60 * 60_000) } : { after: lastUid ?? 0 }),
          limit: BOUNCE_BATCH_SIZE,
        }),
      signal,
    );
    const uids = [...new Set(scan.uids)].filter((uid) => Number.isSafeInteger(uid) && uid > (lastUid ?? 0)).sort((a, b) => a - b);
    for (const uid of uids.slice(0, BOUNCE_BATCH_SIZE)) {
      let report: DeliveryReport | null;
      try {
        report = await readReport(uid);
      } catch {
        signal.throwIfAborted();
        await open();
        try {
          report = await readReport(uid);
        } catch {
          signal.throwIfAborted();
          logger("outgoing-mail-bounces").warn("Skipping unreadable delivery report after retry.", { profile: profile.key, uid });
          lastUid = uid;
          await open();
          continue;
        }
      }
      if (report) {
        stage = "apply_failed";
        await abortable(() => applyOutgoingMailBounce(profile.id, report.id, report.messageId, report.failures), signal);
      }
      lastUid = uid;
    }
    // Only advance through the complete scan when every returned message was processed.
    if (uids.length <= BOUNCE_BATCH_SIZE && scan.through > (lastUid ?? 0)) lastUid = scan.through;
    stage = "save_failed";
    await abortable(() => saveImapMailCheck(profile, { uidValidity: opened.uidValidity, lastUid }), signal);
  } catch {
    // Server exceptions can contain credentials and protocol frames. Store only our code.
    const error = signal.aborted ? "interrupted" : stage;
    try {
      await abortable(
        () => saveImapMailCheck(profile, { ...(uidValidity !== undefined ? { uidValidity, lastUid } : {}), error }),
        AbortSignal.timeout(BOUNCE_ERROR_WRITE_BUDGET_MS),
      );
    } catch {
      logger("outgoing-mail-bounces").error("Could not save bounce check.", { code: "save_failed", profile: profile.key });
    } finally {
      logger("outgoing-mail-bounces").error("Bounce check failed.", { code: error, profile: profile.key });
    }
  } finally {
    mailbox?.close();
  }
};
