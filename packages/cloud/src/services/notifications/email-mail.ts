import { type MailMessage, MailMessageSchema, type MailRecord } from "../../contracts/outgoing-mail";
import { messageRecord, outgoingMailMessages } from "../outgoing-mail/messages";
import { sendMail } from "../outgoing-mail/send";
import { OutgoingMailError } from "../outgoing-mail/store";
import { prepareNotificationEmail } from "./email-frame";

export const notificationMailError = (error: unknown): Error & { code: string; retryable: boolean } => {
  const code = error instanceof OutgoingMailError ? error.code : "mail_unavailable";
  return Object.assign(new Error(error instanceof Error ? error.message : "Outgoing mail is unavailable."), {
    code,
    retryable: ["mail_unavailable", "backlog_full", "quota_exceeded", "attachment_storage_full"].includes(code),
  });
};

const notificationMailMessage = async (
  to: string,
  subject: string,
  body: { content?: string; rawHtml?: string },
  key?: string,
): Promise<MailMessage> => {
  const parsed = MailMessageSchema.safeParse({ to: [to], subject, ...(await prepareNotificationEmail(body)), ...(key ? { key } : {}) });
  if (!parsed.success) throw new OutgoingMailError("bad_input", "Invalid notification email.", 400);
  return parsed.data;
};

export const sendNotificationMail = async (
  to: string,
  subject: string,
  body: { content?: string; rawHtml?: string },
  key?: string,
  signal?: AbortSignal,
): Promise<MailRecord> => {
  try {
    return await sendMail("core", await notificationMailMessage(to, subject, body, key), signal, { trustedHtml: true });
  } catch (error) {
    throw notificationMailError(error);
  }
};

export const notificationMailOutcome = async (record: MailRecord) => {
  const row = await outgoingMailMessages.read(record.id, "core").catch(() => undefined);
  const status = row?.status ?? record.status;
  const errorCode = row?.error_code ?? (record.error ? "smtp_failed" : null);
  const errorMessage = row?.error_message ?? row?.smtp_response ?? record.error ?? null;
  if (status === "sent" || status === "bounced") return { status: "delivered" as const, outgoingMailId: record.id };
  if (status === "failed" || status === "cancelled") {
    throw Object.assign(new Error(errorMessage ?? `Outgoing mail ${status}.`), {
      code: errorCode ?? "smtp_failed",
      retryable: false,
      outgoingMailId: record.id,
    });
  }
  const next = row?.next_attempt_at ? new Date(row.next_attempt_at).getTime() - Date.now() : 60_000;
  // Keep polling within the notification retry interval bounds.
  const retryAfterMs = Number.isFinite(next) ? Math.min(5 * 60_000, Math.max(2_000, next)) : 60_000;
  return { status: "pending" as const, outgoingMailId: record.id, retryAfterMs, errorMessage };
};

export const notificationMailOutcomeById = async (id: string) => {
  const row = await outgoingMailMessages.read(id, "core").catch((error: unknown) => {
    throw notificationMailError(error);
  });
  if (!row) {
    // Retention may remove a settled mail before notification recovery. Its
    // stored identity must never turn that recovery into another SMTP send.
    throw Object.assign(new Error("Outgoing mail record is no longer available."), {
      code: "smtp_failed",
      retryable: false,
      outgoingMailId: id,
    });
  }
  return notificationMailOutcome(messageRecord(row));
};
