import { expect, test } from "bun:test";
import { ASSISTANT_SIDEBAR_CHATS, sidebarChat, sidebarPage } from "./sidebar";

test("the sidebar shows at most the bound of open chats and says when more exist", () => {
  const chats = (count: number) => Array.from({ length: count }, (_, index) => `chat-${index}`);
  expect(sidebarPage(chats(ASSISTANT_SIDEBAR_CHATS))).toEqual({ conversations: chats(ASSISTANT_SIDEBAR_CHATS), more: false });
  const over = sidebarPage(chats(ASSISTANT_SIDEBAR_CHATS + 1));
  expect(over.conversations).toHaveLength(ASSISTANT_SIDEBAR_CHATS);
  expect(over.conversations.at(-1)).toBe(`chat-${ASSISTANT_SIDEBAR_CHATS - 1}`);
  expect(over.more).toBe(true);
  expect(sidebarPage([])).toEqual({ conversations: [], more: false });
});

test("a row of the sidebar carries what the row shows, never the chat's draft, tools or keywords", () => {
  const row = sidebarChat({
    id: "c1",
    shortId: "c1",
    title: "Angebot",
    titleSource: "user",
    description: "Für Müller",
    descriptionSource: "ai",
    keywords: ["angebot"],
    pinnedAt: null,
    archivedAt: null,
    done: null,
    isDone: false,
    lastUsedAt: "2026-11-27T08:00:00.000Z",
    runStatus: "idle",
    runError: null,
    unreadCompletion: false,
    projectId: null,
    draft: { content: [{ type: "text", text: "a long unsent message" }], revision: 3, updatedAt: null },
    createdByUserId: "u1",
    allowedTools: ["files.read"],
    activity: { completed: 0, total: 0, step: null, tool: null },
    createdAt: "2026-11-27T08:00:00.000Z",
    updatedAt: "2026-11-27T08:00:00.000Z",
  });
  expect(row).toEqual({
    id: "c1",
    shortId: "c1",
    title: "Angebot",
    description: "Für Müller",
    pinnedAt: null,
    done: null,
    isDone: false,
    lastUsedAt: "2026-11-27T08:00:00.000Z",
    runStatus: "idle",
    unreadCompletion: false,
    projectId: null,
  });
});
