import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { sql } from "bun";
import { z } from "zod";
import { listApps } from "../../_internal/registry";
import { parsePgJsonValue } from "../postgres";
import { deleteMailObjects, verifyMailAttachment } from "./attachments";
import { mailBackoffMs, mailEnvelope } from "./message";
import { allowedMailProfile, type MessageRow, messageAttachmentRefs, messageRecord, outgoingMailMessages } from "./messages";
import { OutgoingMailError, resolveMailCredentials } from "./store";
import { mailAttachments, mailSettled } from "./sync";
import { smtpFailureMessage } from "./test-send";
import { buildMailTransport } from "./transport";

export const cleanupMailAttachments = async (id: string): Promise<void> => {
  const row = await outgoingMailMessages.read(id);
  if (!row || ["queued", "sending"].includes(row.status)) return;
  await deleteMailObjects(messageAttachmentRefs(row));
  await sql`UPDATE outgoing_mail.messages SET attachment_refs = NULL WHERE id = ${id}::uuid AND status NOT IN ('queued','sending')`;
};
export const publishMailSettled = async (id: string): Promise<void> => {
  await mailSettled().publish({ tenantId: id, data: id });
};
const smtpResponseRetryable = (error: unknown): boolean => {
  const responseCode = error && typeof error === "object" && "responseCode" in error ? Number(error.responseCode) : undefined;
  return responseCode === undefined || !Number.isFinite(responseCode) || responseCode < 500;
};
export const smtpRetryable = (error: unknown): boolean => {
  if (error && typeof error === "object" && "rejectedErrors" in error && Array.isArray(error.rejectedErrors) && error.rejectedErrors.length)
    return error.rejectedErrors.some(smtpResponseRetryable);
  return smtpResponseRetryable(error);
};
const rejectReason = (error: unknown, fallback: string): string =>
  error && typeof error === "object" && "response" in error && typeof error.response === "string" ? error.response : fallback;
const cancelled = async (row: MessageRow, code: "profile_removed" | "profile_not_allowed") => {
  await sql`UPDATE outgoing_mail.messages SET status = 'cancelled', error_code = ${code}, error_message = ${code === "profile_removed" ? "Outgoing mail profile was removed." : "Outgoing mail profile access was revoked."},
    next_attempt_at = NULL, updated_at = now() WHERE id = ${row.id}::uuid AND status = 'sending' AND attempt_count = ${row.attempt_count}`;
};
export const processOutgoingMail = async (id: string, signal?: AbortSignal): Promise<void> => {
  const [row] = await sql<
    MessageRow[]
  >`UPDATE outgoing_mail.messages SET status = 'sending', attempt_count = attempt_count + 1, updated_at = now()
    WHERE id = ${id}::uuid AND status = 'queued' AND lane = 'immediate' AND (next_attempt_at IS NULL OR next_attempt_at <= now() OR deadline_at <= now())
    RETURNING *, created_at::text AS cursor_created_at`;
  if (!row) return;
  let credentials: Awaited<ReturnType<typeof resolveMailCredentials>> | undefined;
  try {
    if (new Date(row.deadline_at).getTime() <= Date.now()) {
      await sql`UPDATE outgoing_mail.messages SET status = 'failed', error_code = COALESCE(error_code, 'smtp_failed'), error_message = COALESCE(error_message, 'Outgoing mail delivery deadline expired.'), next_attempt_at = NULL, updated_at = now() WHERE id = ${id}::uuid AND status = 'sending' AND attempt_count = ${row.attempt_count}`;
      return;
    }
    if (!row.profile_id) {
      await cancelled(row, "profile_removed");
      return;
    }
    const apps = await listApps();
    const app = apps.find((app) => app.id === row.app_id);
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended('outgoing_mail.policy', 0))`;
        const profile = await allowedMailProfile(tx, row.app_id, row.profile_key);
        if (profile.id !== row.profile_id) throw new OutgoingMailError("profile_removed", "Outgoing mail profile was replaced.");
      });
    } catch (error) {
      if (
        error instanceof OutgoingMailError &&
        ["profile_unknown", "profile_removed", "mail_unavailable", "profile_not_allowed", "profile_required"].includes(error.code)
      ) {
        await cancelled(
          row,
          ["profile_unknown", "profile_removed", "mail_unavailable"].includes(error.code) ? "profile_removed" : "profile_not_allowed",
        );
        return;
      }
      throw error;
    }
    const refs = messageAttachmentRefs(row);
    const metadata = messageRecord(row).attachments;
    if (refs.length !== metadata.length) throw new OutgoingMailError("attachment_lost", "An outgoing mail attachment is missing.");
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 60_000);
    const streams: Readable[] = [];
    try {
      for (const [index, ref] of refs.entries()) await verifyMailAttachment(ref, metadata[index]!, attempt.signal);
      const attachments = [];
      for (const [index, ref] of refs.entries()) {
        const stored = await mailAttachments().get(ref, { signal: attempt.signal });
        if (!stored) throw new OutgoingMailError("attachment_lost", "An outgoing mail attachment is missing.");
        const item = metadata[index]!;
        const stream = Readable.from(
          (async function* () {
            const reader = stored.body.getReader();
            const hash = createHash("sha256");
            let bytes = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > item.size) throw new OutgoingMailError("attachment_lost", "Attachment size changed.");
                hash.update(chunk.value);
                yield chunk.value;
              }
              if (bytes !== item.size || hash.digest("hex") !== item.sha256)
                throw new OutgoingMailError("attachment_lost", "Attachment checksum changed.");
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          })(),
        );
        streams.push(stream);
        attachments.push({ filename: item.filename, contentType: item.contentType, content: stream });
      }
      // Load the checked profile by ID: a profile deleted (or recreated under its key) since the check is profile_removed.
      credentials = await resolveMailCredentials({ id: row.profile_id });
      const socket = new Socket();
      // DNS can complete after cancellation; tear down a late connection too.
      socket.once("connect", () => {
        if (attempt.signal.aborted) socket.destroy();
      });
      const transport = buildMailTransport(credentials, socket);
      const stop = () => {
        socket.destroy();
        transport.close();
        for (const stream of streams) stream.destroy();
      };
      attempt.signal.addEventListener("abort", stop, { once: true });
      try {
        if (attempt.signal.aborted) throw new Error("SMTP attempt cancelled");
        const result = await transport.sendMail({
          ...mailEnvelope(credentials, app?.name || row.app_id, row.from_name),
          envelope: { from: credentials.fromAddress, to: row.to_addresses },
          to: row.to_addresses,
          subject: row.subject,
          text: row.text_body ?? "",
          html: row.html_body ?? undefined,
          replyTo: row.reply_to ?? undefined,
          messageId: row.message_id_header,
          headers: row.headers === null ? undefined : z.record(z.string(), z.string()).parse(parsePgJsonValue(row.headers)),
          attachments,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        const failures = (result.rejected ?? []).map((recipient: string, index: number) => ({
          recipient,
          reason: rejectReason(result.rejectedErrors?.[index], "Recipient rejected."),
          at: new Date().toISOString(),
        }));
        await sql`UPDATE outgoing_mail.messages SET status = 'sent', sent_at = now(), next_attempt_at = NULL, error_code = NULL, error_message = NULL,
          smtp_response = ${result.response}, failures = ${JSON.stringify(failures)}::text::jsonb, updated_at = now()
          WHERE id = ${id}::uuid AND status = 'sending' AND attempt_count = ${row.attempt_count}`;
      } finally {
        attempt.signal.removeEventListener("abort", stop);
        socket.destroy();
        transport.close();
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      attempt.abort();
      for (const stream of streams) stream.destroy();
    }
  } catch (error) {
    if (error instanceof OutgoingMailError && ["profile_unknown", "profile_removed"].includes(error.code)) {
      await cancelled(row, "profile_removed");
      return;
    }
    const secrets = credentials
      ? [
          credentials.smtpUser,
          credentials.smtpPassword,
          credentials.smtpUser ? `\0${credentials.smtpUser}\0${credentials.smtpPassword ?? ""}` : null,
        ]
      : [];
    const message =
      credentials || error instanceof OutgoingMailError
        ? smtpFailureMessage(error, secrets)
        : "Outgoing mail delivery is temporarily unavailable.";
    const lost = error instanceof OutgoingMailError && error.code === "attachment_lost";
    const retry = !lost && smtpRetryable(error) && new Date(row.deadline_at).getTime() > Date.now();
    const next = new Date(Date.now() + mailBackoffMs(row.attempt_count));
    await sql`UPDATE outgoing_mail.messages SET status = ${retry ? "queued" : "failed"}, error_code = ${lost ? "attachment_lost" : "smtp_failed"}, error_message = ${message},
      next_attempt_at = ${retry ? next : null}, updated_at = now() WHERE id = ${id}::uuid AND status = 'sending' AND attempt_count = ${row.attempt_count}`;
  } finally {
    // Cleanup failure must never turn SMTP success into another delivery attempt.
    await cleanupMailAttachments(id).catch(() => {});
    await publishMailSettled(id).catch(() => {});
  }
};
export const recoverOutgoingMail = async (): Promise<string[]> => {
  await sql`WITH stale AS (SELECT id FROM outgoing_mail.messages WHERE lane = 'immediate' AND status = 'sending' AND updated_at < now() - INTERVAL '5 minutes' LIMIT 1000 FOR UPDATE SKIP LOCKED)
    UPDATE outgoing_mail.messages SET status = 'queued', next_attempt_at = now(), updated_at = now() WHERE id IN (SELECT id FROM stale)`;
  const cleanup = await sql<
    { id: string }[]
  >`SELECT id FROM outgoing_mail.messages WHERE status NOT IN ('queued','sending') AND attachment_refs IS NOT NULL LIMIT 1000`;
  for (const row of cleanup) await cleanupMailAttachments(row.id).catch(() => {});
  const due = await sql<{ id: string }[]>`SELECT id FROM outgoing_mail.messages WHERE lane = 'immediate' AND status = 'queued'
    AND (next_attempt_at IS NULL OR next_attempt_at <= now() OR deadline_at <= now()) ORDER BY next_attempt_at NULLS FIRST, created_at LIMIT 1000`;
  return due.map((row) => row.id);
};
