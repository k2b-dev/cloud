import { aiConversations, aiProjects } from "@k2b/cloud/ai";
import { sql } from "bun";
import { z } from "zod";
import { ChatPresentation, ChatPresentationInput } from "./chat-presentation-contracts";
import { LIMITS } from "./contracts";
import { databaseConfigLock } from "./database-lock";
import { appChecks } from "./html/check-service";
import { ArtifactError, type ArtifactIdentity, readArtifactRevision, requireArtifact } from "./service";

async function conversation(id: string, identity: ArtifactIdentity) {
  if (identity.actor.kind !== "user") throw new ArtifactError("ACCESS_DENIED");
  const input = { ownerUserId: identity.actor.user.id };
  const chat = z.uuid().safeParse(id).success
    ? await aiConversations.getConversation({ ...input, conversationId: id })
    : await aiConversations.getConversationByShortId({ ...input, shortId: id });
  if (!chat || chat.archivedAt || (chat.allowedTools && !chat.allowedTools.includes("code_present")))
    throw new ArtifactError("ACCESS_DENIED");
  if (chat.projectId && !(await aiProjects.get(chat.projectId, identity.accessSubject, "read"))) throw new ArtifactError("ACCESS_DENIED");
  return chat;
}
export const chatPresentations = {
  async save(raw: unknown, identity: ArtifactIdentity) {
    const input = ChatPresentationInput.parse(raw);
    const chat = await conversation(input.conversationId, identity);
    // A saved app is only referenced; the card loads it with the viewer's access every time it starts.
    return sql.begin(async (db) => {
      await databaseConfigLock(db);
      const resource = input.artifactId ? await requireArtifact(db, input.artifactId, identity, "read") : undefined;
      const bundle = resource
        ? await readArtifactRevision(
            db,
            resource.row,
            resource.permission,
            resource.permission === "admin" ? resource.row.revision : resource.row.published_revision!,
          )
        : undefined;
      await appChecks.assert(bundle?.source ?? { entry: "index.html", files: input.files! }, input.artifactId, identity, chat.id, db);
      // Serialize the per-chat budget and duplicate delivery checks.
      await db`SELECT id FROM ai.conversations WHERE id=${chat.id}::uuid FOR UPDATE`;
      const [existing] =
        await db`SELECT id,title FROM assistant.chat_presentations WHERE conversation_id=${chat.id}::uuid AND call_id=${input.callId}`;
      if (existing) return { presentationId: String(existing.id), title: String(existing.title) };
      const files = input.files ? JSON.stringify(input.files) : null;
      const bytes = files ? new TextEncoder().encode(files).byteLength : 0;
      const [usage] =
        await db`SELECT coalesce(sum(bytes),0)::bigint AS bytes FROM assistant.chat_presentations WHERE conversation_id=${chat.id}::uuid`;
      if (Number(usage!.bytes) + bytes > LIMITS.inputBytes) throw new ArtifactError("STORAGE_FULL");
      const [app] = input.artifactId ? await db`SELECT id FROM assistant.artifacts WHERE short_id=${input.artifactId}` : [];
      if (input.artifactId && !app) throw new ArtifactError("NOT_FOUND");
      const id = crypto.randomUUID();
      await db`INSERT INTO assistant.chat_presentations(id,conversation_id,call_id,title,files,artifact_id,bytes)
        VALUES(${id}::uuid,${chat.id}::uuid,${input.callId},${input.title},${files}::text::jsonb,${app?.id ?? null}::uuid,${bytes})`;
      return { presentationId: id, title: input.title };
    });
  },
  async read(id: string, conversationId: string, identity: ArtifactIdentity): Promise<ChatPresentation> {
    const chat = await conversation(conversationId, identity);
    const [row] = await sql`SELECT p.id,p.title,p.files,a.short_id AS "artifactId" FROM assistant.chat_presentations p
      LEFT JOIN assistant.artifacts a ON a.id=p.artifact_id WHERE p.id=${id}::uuid AND p.conversation_id=${chat.id}::uuid`;
    if (!row) throw new ArtifactError("NOT_FOUND");
    return ChatPresentation.parse({ ...row, conversationId: chat.shortId });
  },
};
