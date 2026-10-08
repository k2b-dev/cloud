import { createHash } from "node:crypto";
import { type ObjectRef, StoreFullError } from "@k2b/sync";
import type { MailAttachment, MailRecord } from "../../contracts/outgoing-mail";
import { OutgoingMailError } from "./store";
import { mailAttachments } from "./sync";

export type UploadedAttachments = { metadata: MailRecord["attachments"]; refs: ObjectRef[] };
export const MAIL_ATTACHMENT_UPLOAD_MS = 60_000;
export const cancelMailStreams = (attachments: unknown = []): void => {
  if (!Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    if (
      attachment &&
      typeof attachment === "object" &&
      "content" in attachment &&
      attachment.content instanceof ReadableStream &&
      !attachment.content.locked
    )
      void attachment.content.cancel().catch(() => {});
  }
};
export const deleteMailObjects = async (refs: readonly ObjectRef[]): Promise<void> => {
  // Sequential deletion bounds load even for a large attachment collection.
  for (const ref of refs) await mailAttachments().delete({ tenantId: ref.tenantId, key: ref.key });
};
const contentStream = (content: MailAttachment["content"]): ReadableStream<Uint8Array> => {
  if (content instanceof ReadableStream) return content;
  if (content instanceof Blob) return content.stream();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
};
export const uploadMailAttachments = async (
  id: string,
  attachments: readonly MailAttachment[],
  limit: number,
): Promise<UploadedAttachments> => {
  const result: UploadedAttachments = { metadata: [], refs: [] };
  let total = 0;
  const controller = new AbortController();
  // The caller's signal cancels the wait only. All attachments share one bounded upload.
  const timer = setTimeout(() => controller.abort(new Error("Attachment upload timed out")), MAIL_ATTACHMENT_UPLOAD_MS);
  try {
    for (const [index, attachment] of attachments.entries()) {
      const hash = createHash("sha256");
      let size = 0;
      let exceeded = false;
      const key = `${id}-${index}`;
      try {
        const stream = contentStream(attachment.content).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, output) {
              total += chunk.byteLength;
              size += chunk.byteLength;
              if (total > limit) {
                exceeded = true;
                throw new OutgoingMailError("attachments_too_large", "Attachments exceed the profile's total byte limit.");
              }
              hash.update(chunk);
              output.enqueue(chunk);
            },
          }),
          { signal: controller.signal },
        );
        const ref = await mailAttachments().put({ tenantId: id, key, body: stream, signal: controller.signal });
        result.refs.push(ref);
        result.metadata.push({ filename: attachment.filename, contentType: attachment.contentType, size, sha256: hash.digest("hex") });
      } catch (error) {
        // A failed put can have written chunks before the final metadata was published.
        await mailAttachments()
          .delete({ tenantId: id, key })
          .catch(() => {});
        if (exceeded) throw new OutgoingMailError("attachments_too_large", "Attachments exceed the profile's total byte limit.");
        if (
          error instanceof StoreFullError ||
          (error instanceof Error &&
            /maximum bytes|maximum storage|insufficient (?:storage|resources)|storage resources|store.*full|resource limits exceeded/i.test(
              error.message,
            ))
        )
          throw new OutgoingMailError("attachment_storage_full", "Outgoing mail attachment storage is full.");
        throw error;
      }
    }
    return result;
  } catch (error) {
    await deleteMailObjects(result.refs).catch(() => {});
    cancelMailStreams(attachments);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

/** Verify before SMTP DATA; open a second, verified stream for nodemailer. */
export const verifyMailAttachment = async (
  ref: ObjectRef,
  metadata: MailRecord["attachments"][number],
  signal?: AbortSignal,
): Promise<void> => {
  const object = await mailAttachments().get(ref, { signal });
  if (!object) throw new OutgoingMailError("attachment_lost", "An outgoing mail attachment is missing or changed.");
  const reader = object.body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > metadata.size) throw new Error("Attachment size mismatch");
      hash.update(chunk.value);
    }
    if (size !== metadata.size || hash.digest("hex") !== metadata.sha256) throw new Error("Attachment digest mismatch");
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && /stalled|timeout|timed out|connection/i.test(error.message)))
      throw new Error("Attachment verification was interrupted.");
    throw new OutgoingMailError("attachment_lost", "An outgoing mail attachment is missing or changed.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
