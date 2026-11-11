import { createHash, randomUUID } from "node:crypto";
import { redis } from "@k2b/cloud";
import { readAiConversationFile, statAiConversationFile } from "@k2b/cloud/ai";
import { CODE_FILE_LIMITS } from "@k2b/cloud/code";
import { type CapabilityExecutionContext, type CapabilityStream, CapabilityStreamSchema } from "@k2b/cloud/contracts";
import { decryptSecret, encryptSecret } from "@k2b/cloud/services";
import { err } from "@k2b/stdlib";
import { z } from "zod";
import { requireToolChat } from "./chat-access";
import { ArtifactError, type ArtifactIdentity, user } from "./identity";

/** L23 hook: invoke assistant.chat.file.read.v1 as the current person through
 * the ordinary capability service. Its read stream becomes a run-local FileRef
 * in createServiceCalls; pass it unchanged to an Action's SDK file argument.
 */
export const ChatAttachmentInput = z.strictObject({
  chatId: z.string().min(1).max(80).describe("Exact chat ID from this conversation."),
  path: z.string().min(1).max(500).describe("Exact attachment path from this chat's files, never an external URL."),
});
const Grant = z.strictObject({
  purpose: z.literal("assistant-chat-file-v1"),
  nonce: z.uuid(),
  owner: z.string(),
  expiresAt: z.number(),
  reference: z.strictObject({
    scope: z.literal("chat"),
    id: z.string(),
    path: z.string(),
    version: z.number().int().positive(),
    updatedAt: z.string(),
  }),
});
const identity = (context: CapabilityExecutionContext): ArtifactIdentity => ({
  actor: context.actor,
  accessSubject: context.accessSubject,
});
type ChatAttachmentDependencies = {
  authorize: (chatId: string, caller: ArtifactIdentity) => Promise<{ id: string }>;
  stat: typeof statAiConversationFile;
  read: typeof readAiConversationFile;
  seal: typeof encryptSecret;
  unseal: (value: string) => Promise<unknown>;
  consume: (nonce: string) => Promise<boolean>;
};
const attachmentDependencies: ChatAttachmentDependencies = {
  authorize: async (chatId: string, caller: ArtifactIdentity) => requireToolChat(chatId, caller, "code_run"),
  stat: statAiConversationFile,
  read: readAiConversationFile,
  seal: encryptSecret,
  unseal: decryptSecret,
  consume: async (nonce: string) =>
    (await redis.send("SET", [
      `assistant:chat-file:v1:${createHash("sha256").update(nonce).digest("hex")}`,
      "1",
      "NX",
      "EX",
      String(CODE_FILE_LIMITS.ttlSeconds),
    ])) === "OK",
};
async function attachmentOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    if (error.code === "ACCESS_DENIED") throw err.forbidden("Chat attachment access is unavailable.");
    if (error.code === "NOT_FOUND") throw err.notFound("Chat attachment");
    if (error.code === "INVALID_INPUT") throw err.badInput("Chat attachment exceeds the file or continuation budget.");
    if (error.code === "CONFLICT")
      throw err.conflict("Chat attachment changed or was already used; inspect the destination before retrying.");
    throw err.internal("Chat attachment transfer failed.");
  }
}
export function createChatAttachmentStream(dependencies = attachmentDependencies) {
  return {
    issue: (raw: z.infer<typeof ChatAttachmentInput>, context: CapabilityExecutionContext) =>
      attachmentOperation(async () => {
        const input = ChatAttachmentInput.parse(raw);
        const caller = identity(context);
        const owner = user(caller).id;
        const chat = await dependencies.authorize(input.chatId, caller);
        const file = await dependencies.stat({ conversationId: chat.id, ownerUserId: owner, path: input.path });
        if (!file) throw new ArtifactError("NOT_FOUND");
        if (file.size > CODE_FILE_LIMITS.fileBytes) throw new ArtifactError("INVALID_INPUT");
        context.signal.throwIfAborted();
        const expiresAt = Date.now() + CODE_FILE_LIMITS.ttlSeconds * 1000;
        const id = await dependencies.seal({
          purpose: "assistant-chat-file-v1",
          nonce: randomUUID(),
          owner,
          expiresAt,
          reference: { scope: "chat", id: chat.id, path: file.path, version: file.version, updatedAt: file.updatedAt },
        });
        if (Buffer.byteLength(id) > 2048) throw new ArtifactError("INVALID_INPUT");
        return CapabilityStreamSchema.parse({
          id,
          direction: "read",
          name: file.path.split("/").at(-1),
          mediaType: file.mediaType,
          size: file.size,
          expiresAt: new Date(expiresAt).toISOString(),
        });
      }),
    read: (stream: CapabilityStream, context: CapabilityExecutionContext): Promise<Response> =>
      attachmentOperation(async () => {
        const caller = identity(context);
        const grant = Grant.parse(await dependencies.unseal(stream.id));
        if (grant.owner !== user(caller).id || grant.expiresAt <= Date.now()) throw new ArtifactError("ACCESS_DENIED");
        // Recheck conversation ownership, archive state, Project access and allowed tools.
        await dependencies.authorize(grant.reference.id, caller);
        context.signal.throwIfAborted();
        // Reserve single use before loading bytes, including simultaneous requests
        // and failed reads. Obtain a fresh reference after inspecting an uncertain transfer.
        if (!(await dependencies.consume(grant.nonce))) throw new ArtifactError("CONFLICT");
        const file = await dependencies.read({
          conversationId: grant.reference.id,
          ownerUserId: grant.owner,
          path: grant.reference.path,
          version: grant.reference.version,
          maxBytes: CODE_FILE_LIMITS.fileBytes,
        });
        if (!file || file.updatedAt !== grant.reference.updatedAt) throw new ArtifactError("CONFLICT");
        if (
          file.size > CODE_FILE_LIMITS.fileBytes ||
          file.bytes.byteLength !== stream.size ||
          file.mediaType !== stream.mediaType ||
          file.path.split("/").at(-1) !== stream.name
        )
          throw new ArtifactError("CONFLICT");
        context.signal.throwIfAborted();
        return new Response(new Uint8Array(file.bytes), {
          headers: {
            "content-type": file.mediaType,
            "content-length": String(file.bytes.byteLength),
            "content-disposition": "attachment",
            "x-content-type-options": "nosniff",
          },
        });
      }),
  };
}
const attachment = createChatAttachmentStream();
export const chatAttachmentReadQuery = {
  title: "Read chat attachment",
  description:
    "Open one file from your Gustav chat as a ten-minute single-use read stream. Current chat and Project access are checked again on transfer.",
  input: ChatAttachmentInput,
  data: z.strictObject({ available: z.boolean() }),
  openWorld: false,
  stream: { direction: "read" as const, maxBytes: CODE_FILE_LIMITS.fileBytes, read: attachment.read },
  run: async (input: z.infer<typeof ChatAttachmentInput>, context: CapabilityExecutionContext) => ({
    ok: true as const,
    data: { data: { available: true }, stream: await attachment.issue(input, context) },
  }),
};
