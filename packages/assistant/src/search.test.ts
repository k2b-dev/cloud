import { expect, test } from "bun:test";
import type { AiConversation, AiConversationService, AiStoredMessage } from "@k2b/cloud/ai";
import { UniversalSearchDataSchema } from "@k2b/cloud/contracts";
import { searchAssistant } from "./search";

const chat: AiConversation = {
  id: "internal-chat",
  shortId: "Chat01",
  title: "Planning",
  titleSource: "user",
  description: "Team planning",
  descriptionSource: "user",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  done: false,
  isDone: false,
  lastUsedAt: "2026-09-16T00:00:00Z",
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "owner",
  createdAt: "2026-09-16T00:00:00Z",
  updatedAt: "2026-09-16T00:00:00Z",
};
const message: AiStoredMessage = {
  id: "internal-message",
  shortId: "Msg001",
  conversationId: chat.id,
  seq: 42,
  kind: "message",
  message: { role: "user", content: [{ type: "text", text: "Find the\nlaunch plan" }] },
  loopId: null,
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-09-16T00:00:00Z",
};
const projects = { getByShortId: async () => null };
const input = { query: "launch", tags: [], limit: 1 };
const context = { accessSubject: { type: "user" as const, userId: "owner" }, locale: "de" };
const calls: unknown[] = [];
const store: Pick<AiConversationService, "listConversations" | "getConversationByShortId" | "searchConversationMessages"> = {
  listConversations: async (request) => {
    calls.push(request);
    return [chat];
  },
  getConversationByShortId: async (request) => {
    calls.push(request);
    return request.shortId === chat.shortId && request.ownerUserId === chat.createdByUserId ? chat : null;
  },
  searchConversationMessages: async (request) => {
    calls.push(request);
    return { messages: [message, { ...message, shortId: "Msg002", seq: 43 }] };
  },
};
test("app-wide search delegates content matching to the owner-scoped service and returns public chat links", async () => {
  calls.length = 0;
  const result = await searchAssistant(input, context, store, projects);
  expect(calls).toEqual([{ ownerUserId: "owner", search: "launch", limit: 1 }]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(UniversalSearchDataSchema.safeParse(result.data.data).success).toBe(true);
  expect(result.data.data[0]?.ref).toEqual({ type: "assistant.chat", id: "Chat01" });
  expect(result.data.data[0]?.links[0]?.href).toBe("/app/assistant?conversation=Chat01");
});
test("scoped search authorizes the chat before querying messages and bounds views with deep links", async () => {
  calls.length = 0;
  const result = await searchAssistant({ ...input, scope: { type: "assistant.chat", id: "Chat01" } }, context, store, projects);
  expect(calls).toEqual([
    { shortId: "Chat01", ownerUserId: "owner" },
    { conversationId: "internal-chat", query: "launch", limit: 1 },
  ]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.data).toHaveLength(1);
  expect(UniversalSearchDataSchema.safeParse(result.data.data).success).toBe(true);
  expect(result.data.data[0]).toMatchObject({
    ref: { type: "assistant.message", id: "Msg001" },
    title: "Find the launch plan",
    links: [{ rel: "open", href: "/app/assistant?conversation=Chat01&message=42" }],
  });
});
test("inaccessible scopes and non-user subjects cannot fall back to unscoped search", async () => {
  calls.length = 0;
  expect(
    (
      await searchAssistant(
        { ...input, scope: { type: "assistant.chat", id: "Chat01" } },
        { ...context, accessSubject: { type: "user", userId: "other" } },
        store,
        projects,
      )
    ).ok,
  ).toBe(false);
  expect(calls).toEqual([{ shortId: "Chat01", ownerUserId: "other" }]);
  calls.length = 0;
  expect((await searchAssistant({ ...input, scope: { type: "notebooks.notebook", id: "Chat01" } }, context, store, projects)).ok).toBe(
    false,
  );
  expect(calls).toEqual([]);
  expect(
    (await searchAssistant(input, { ...context, accessSubject: { type: "service_account", serviceAccountId: "service" } }, store, projects))
      .ok,
  ).toBe(false);
  expect(calls).toEqual([]);
});

test("project search authorizes the project and filters owned chats before limiting", async () => {
  calls.length = 0;
  const project = {
    id: "project-internal",
    shortId: "Proj01",
    name: "Work",
    description: "",
    icon: "ti ti-folders",
    instructions: "",
    defaultModelProfileId: null,
    permission: "read" as const,
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  const result = await searchAssistant({ ...input, scope: { type: "assistant.project", id: "Proj01" } }, context, store, {
    getByShortId: async (id, subject) => {
      expect(id).toBe("Proj01");
      expect(subject).toEqual(context.accessSubject);
      return project;
    },
  });
  expect(result.ok).toBe(true);
  expect(calls).toEqual([{ ownerUserId: "owner", search: "launch", limit: 1, projectId: "project-internal" }]);
  calls.length = 0;
  expect((await searchAssistant({ ...input, scope: { type: "assistant.project", id: "missing" } }, context, store, projects)).ok).toBe(
    false,
  );
  expect(calls).toEqual([]);
});
