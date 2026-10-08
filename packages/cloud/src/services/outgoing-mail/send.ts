import { sql } from "bun";
import type { MailMessage, MailRecord } from "../../contracts/outgoing-mail";
import { cancelMailStreams, deleteMailObjects, uploadMailAttachments } from "./attachments";
import {
  allowedMailProfile,
  type MailAcceptanceOptions,
  MailQuotaError,
  mailQuotaUsed,
  messageRecord,
  outgoingMailMessages,
  recordMailSend,
} from "./messages";
import { OutgoingMailError } from "./store";
import { mailAttachments, mailSendJob, mailSettled, submitMail } from "./sync";

export const MAIL_WAIT_MS = 30_000;
export const waitForMail = async (appId: string, initial: MailRecord, signal?: AbortSignal): Promise<MailRecord> => {
  if (signal?.aborted || !["queued", "sending"].includes(initial.status)) return initial;
  const controller = new AbortController();
  let wake: (() => void) | undefined;
  const abort = () => {
    controller.abort();
    wake?.();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, MAIL_WAIT_MS);
  // A lost wakeup cannot lose a result: Postgres is polled independently.
  const follower = (async () => {
    try {
      for await (const _event of mailSettled().follow({ tenantId: initial.id, signal: controller.signal })) wake?.();
    } catch {
      /* Postgres polling remains authoritative while Sync is unavailable. */
    }
  })();
  const read = async () => {
    if (controller.signal.aborted) return undefined;
    let release: (() => void) | undefined;
    const stopped = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
      controller.signal.addEventListener("abort", release, { once: true });
    });
    try {
      return await Promise.race([outgoingMailMessages.read(initial.id, appId).catch(() => undefined), stopped]);
    } finally {
      if (release) controller.signal.removeEventListener("abort", release);
    }
  };
  let current = initial;
  try {
    while (!controller.signal.aborted) {
      const row = await read();
      if (row) current = messageRecord(row);
      if (!row || (current.status !== "sending" && (current.status !== "queued" || row.attempt_count > 0))) return current;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        const timer = setTimeout(finish, 2000);
        wake = finish;
        if (controller.signal.aborted) finish();
      });
    }
    return current;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    void follower;
  }
};
export const sendMail = async (
  appId: string,
  message: MailMessage,
  signal?: AbortSignal,
  options?: MailAcceptanceOptions,
): Promise<MailRecord> => {
  const existing = await outgoingMailMessages.known(appId, message.key);
  if (existing) {
    cancelMailStreams(message.attachments);
    await recordMailSend(appId, message, existing).catch(() => {});
    return messageRecord(existing);
  }
  // Ensure coordination storage is reachable before accepting durable mail.
  await Promise.all([mailSendJob().ready(), mailSettled().ready(), mailAttachments().ready()]);
  const profile = await sql.begin(async (tx) => {
    const profile = await allowedMailProfile(tx, appId, message.profile);
    if (profile.daily_recipient_limit !== null) {
      const used = await mailQuotaUsed(tx, appId, profile.id);
      if (used + message.to.length > profile.daily_recipient_limit)
        throw new MailQuotaError(profile.daily_recipient_limit, used, message.to.length);
    }
    return profile;
  });
  const id = crypto.randomUUID();
  const uploaded = await uploadMailAttachments(id, message.attachments ?? [], profile.max_attachment_bytes);
  let accepted: Awaited<ReturnType<typeof outgoingMailMessages.accept>>;
  try {
    accepted = await outgoingMailMessages.accept(appId, id, message, uploaded, options);
  } catch (error) {
    // If the commit reply was lost, or another call won while this transaction
    // failed, an existing record still owns the outcome and its objects.
    const recovered =
      (await outgoingMailMessages.read(id, appId).catch(() => undefined)) ??
      (await outgoingMailMessages.known(appId, message.key).catch(() => undefined));
    if (recovered) {
      if (recovered.id !== id) {
        await deleteMailObjects(uploaded.refs).catch(() => {});
        await recordMailSend(appId, message, recovered).catch(() => {});
      }
      const record = messageRecord(recovered);
      void submitMail(recovered.id).catch(() => {});
      return waitForMail(appId, record, signal).catch(() => record);
    }
    // Policy/quota errors roll back before acceptance. An unavailable database
    // cannot prove that COMMIT failed; retain uncertain objects until their TTL.
    if (error instanceof OutgoingMailError) await deleteMailObjects(uploaded.refs).catch(() => {});
    throw error;
  }
  if (!accepted.created) {
    await recordMailSend(appId, message, accepted.row).catch(() => {});
    await deleteMailObjects(uploaded.refs).catch(() => {});
    return messageRecord(accepted.row);
  }
  const record = messageRecord(accepted.row);
  // From this point a row exists. A failed wakeup is recovered by Core.
  void submitMail(id).catch(() => {});
  return waitForMail(appId, record, signal).catch(() => record);
};
