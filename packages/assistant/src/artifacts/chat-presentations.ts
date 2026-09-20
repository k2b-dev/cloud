import { sql } from "bun";
import { z } from "zod";
import { aiConversations, aiProjects, readAiConversationFile } from "@k2b/cloud/ai";
import { ChatPresentation, ChatPresentationInput } from "./chat-presentation-contracts";
import { LIMITS } from "./contracts";
import { ArtifactError, type ArtifactIdentity } from "./service";

async function conversation(id: string, identity: ArtifactIdentity) {
  if (identity.actor.kind !== "user") throw new ArtifactError("ACCESS_DENIED");
  const input = { ownerUserId: identity.actor.user.id };
  const chat = z.uuid().safeParse(id).success
    ? await aiConversations.getConversation({ ...input, conversationId: id })
    : await aiConversations.getConversationByShortId({ ...input, shortId: id });
  if (!chat || chat.archivedAt || (chat.allowedTools && !chat.allowedTools.includes("code_present"))) throw new ArtifactError("ACCESS_DENIED");
  if (chat.projectId && !(await aiProjects.get(chat.projectId, identity.accessSubject, "read"))) throw new ArtifactError("ACCESS_DENIED");
  return { chat, ownerUserId: identity.actor.user.id };
}
export const chatPresentations = {
  async save(raw: unknown, identity: ArtifactIdentity) {
    const input = ChatPresentationInput.parse(raw);
    const { chat, ownerUserId } = await conversation(input.conversationId, identity);
    return sql.begin(async db => {
      // Serialize the per-chat budget and duplicate delivery checks.
      await db`SELECT id FROM ai.conversations WHERE id=${chat.id}::uuid FOR UPDATE`;
      const [existing] = await db`SELECT id,title FROM assistant.chat_presentations WHERE conversation_id=${chat.id}::uuid AND call_id=${input.callId}`;
      if (existing) return { presentationId: String(existing.id), title: String(existing.title) };
      let bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
      const files = [];
      for (const ref of input.inputs) {
        const file = await readAiConversationFile({ conversationId: chat.id, ownerUserId, ...ref });
        if (!file) throw new Error(`Input version no longer available: ${ref.path}`);
        if (file.bytes.byteLength > LIMITS.inputFileBytes) throw new Error("Input exceeds file budget");
        bytes += file.bytes.byteLength;
        if (bytes > LIMITS.inputBytes) throw new ArtifactError("STORAGE_FULL");
        files.push(file);
      }
      const [usage] = await db`SELECT coalesce(sum(bytes),0)::bigint AS bytes FROM assistant.chat_presentations WHERE conversation_id=${chat.id}::uuid`;
      if (Number(usage!.bytes) + bytes > LIMITS.inputBytes) throw new ArtifactError("STORAGE_FULL");
      const id = crypto.randomUUID();
      await db`INSERT INTO assistant.chat_presentations(id,conversation_id,call_id,title,code,nodes,bytes)
        VALUES(${id}::uuid,${chat.id}::uuid,${input.callId},${input.title},${input.code},${JSON.stringify(input.nodes)}::text::jsonb,${bytes})`;
      for (const file of files) await db`INSERT INTO assistant.chat_presentation_inputs(presentation_id,path,data,media_type)
        VALUES(${id}::uuid,${file.path},${file.bytes},${file.mediaType})`;
      return { presentationId: id, title: input.title };
    });
  },
  async read(id: string, conversationId: string, identity: ArtifactIdentity): Promise<ChatPresentation> {
    const { chat } = await conversation(conversationId, identity);
    const [row] = await sql`SELECT id,title,code,nodes FROM assistant.chat_presentations WHERE id=${id}::uuid AND conversation_id=${chat.id}::uuid`;
    if (!row) throw new ArtifactError("NOT_FOUND");
    const inputs = await sql`SELECT path,octet_length(data) AS size,media_type AS "mediaType" FROM assistant.chat_presentation_inputs WHERE presentation_id=${id}::uuid ORDER BY path`;
    return ChatPresentation.parse({ ...row, conversationId: chat.shortId, inputs });
  },
  async input(id: string, conversationId: string, path: string, identity: ArtifactIdentity) {
    await this.read(id, conversationId, identity);
    const [file] = await sql<{ data: Uint8Array; mediaType: string }[]>`SELECT data,media_type AS "mediaType" FROM assistant.chat_presentation_inputs WHERE presentation_id=${id}::uuid AND path=${path}`;
    if (!file) throw new ArtifactError("NOT_FOUND");
    return file;
  },
};
