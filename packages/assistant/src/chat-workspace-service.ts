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
  return row ? { state: ChatWorkspaceStateSchema.parse(row.state), revision: row.revision } : emptyWorkspace();
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
  if (state.tabs.length === 0) {
    const removed = await sql<{ revision: number }[]>`DELETE FROM assistant.chat_workspaces
      WHERE conversation_id=${chat.conversationId}::uuid AND user_id=${chat.userId}::uuid AND revision=${revision}
      RETURNING revision::float8 AS revision`;
    if (removed.length) return { conflict: false, revision: 0 };
    const current = await readWorkspace(chat.conversationId, chat.userId);
    return current.revision === 0 ? { conflict: false, revision: 0 } : { conflict: true, ...current };
  }
  const [saved] = await sql<{ revision: number }[]>`INSERT INTO assistant.chat_workspaces(conversation_id,user_id,state)
    VALUES(${chat.conversationId}::uuid,${chat.userId}::uuid,${JSON.stringify(state)}::jsonb)
    ON CONFLICT(conversation_id,user_id) DO UPDATE SET state=EXCLUDED.state,
      revision=chat_workspaces.revision+1,updated_at=now()
    WHERE chat_workspaces.revision=${revision} RETURNING revision::float8 AS revision`;
  if (saved) return { conflict: false, revision: saved.revision };
  return { conflict: true, ...(await readWorkspace(chat.conversationId, chat.userId)) };
};
