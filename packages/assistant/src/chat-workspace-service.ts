import { sql } from "@k2b/cloud";
import { type AiResourceContext, aiConversations } from "@k2b/cloud/ai";
import {
  type ChatWorkspaceSnapshot,
  ChatWorkspaceStateSchema,
  type SaveChatWorkspaceInput,
  type SaveChatWorkspaceResult,
  SaveChatWorkspaceSchema,
} from "./chat-workspace";

const emptyWorkspace = (): ChatWorkspaceSnapshot => ({ state: { tabs: [], layout: null, front: null }, revision: 0 });

const workspaceConversation = async (identity: AiResourceContext, chatShortId: string) => {
  if (identity.accessSubject.type !== "user") throw new Error("A user-backed identity is required.");
  const userId = identity.accessSubject.userId;
  const conversation = await aiConversations.getConversationByShortId({ shortId: chatShortId, ownerUserId: userId });
  return conversation ? { conversationId: conversation.id, userId } : null;
};

const readWorkspace = async (conversationId: string, userId: string): Promise<ChatWorkspaceSnapshot> => {
  const [row] = await sql<{ state: unknown; revision: number }[]>`SELECT state, revision::float8 AS revision
    FROM assistant.chat_workspaces WHERE conversation_id=${conversationId}::uuid AND user_id=${userId}::uuid`;
  if (!row) return emptyWorkspace();
  // A state an older or newer version stored that this one cannot read starts empty; the next save replaces it.
  const parsed = ChatWorkspaceStateSchema.safeParse(row.state);
  return { state: parsed.success ? parsed.data : emptyWorkspace().state, revision: row.revision };
};

export const loadAssistantChatWorkspace = async (
  identity: AiResourceContext,
  chatShortId: string,
): Promise<ChatWorkspaceSnapshot | null> => {
  const chat = await workspaceConversation(identity, chatShortId);
  return chat ? readWorkspace(chat.conversationId, chat.userId) : null;
};

export const saveAssistantChatWorkspace = async (
  identity: AiResourceContext,
  chatShortId: string,
  input: SaveChatWorkspaceInput,
): Promise<SaveChatWorkspaceResult | null> => {
  const chat = await workspaceConversation(identity, chatShortId);
  if (!chat) return null;
  const { state, revision } = SaveChatWorkspaceSchema.parse(input);
  // An empty state stays a row, so its revision keeps counting and an older device cannot bring closed tabs back.
  const [saved] = await sql<{ revision: number }[]>`INSERT INTO assistant.chat_workspaces(conversation_id,user_id,state)
    VALUES(${chat.conversationId}::uuid,${chat.userId}::uuid,(${JSON.stringify(state)}::text)::jsonb)
    ON CONFLICT(conversation_id,user_id) DO UPDATE SET state=EXCLUDED.state,
      revision=chat_workspaces.revision+1,updated_at=now()
    WHERE chat_workspaces.revision=${revision} RETURNING revision::float8 AS revision`;
  if (saved) return { conflict: false, revision: saved.revision };
  return { conflict: true, ...(await readWorkspace(chat.conversationId, chat.userId)) };
};
