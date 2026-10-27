import { expect, spyOn, test } from "bun:test";
import type { AiConversation, AiTurn } from "@k2b/cloud/ai";
import * as ai from "@k2b/cloud/ai";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { hostFetch } from "./agent-host";
import { createArtifactServiceRoutes } from "./api";
import { testIdentity } from "./test-identity";

const identity = testIdentity("00000000-0000-4000-8000-000000000001");
const conversation: AiConversation = {
  id: "00000000-0000-4000-8000-000000000002",
  shortId: "Chat23",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "",
  archivedAt: null,
  runStatus: "running",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: identity.user.id,
  createdAt: "",
  updatedAt: "",
};
const turn: AiTurn = {
  id: "00000000-0000-4000-8000-000000000003",
  shortId: "Turn23",
  conversationId: conversation.id,
  status: "running",
  attempt: 1,
  modelId: null,
  createdAt: "",
  completedAt: null,
  error: null,
};
const spec = { view: "table", title: "Rows", columns: [{ id: "n", type: "number" }], rows: [{ n: 42 }] };
const body = { conversationId: conversation.id, turnId: turn.id, runId: "call", index: 0, view: spec };
const ref = { path: "/views/rows-12345678.view.json", view: "table", title: "Rows", rows: 1, columns: 1, footer: false } as const;
const router = () =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", identity.actor);
      c.set("accessSubject", identity.accessSubject);
      await next();
    })
    .route("/", createArtifactServiceRoutes());
const request = (value: unknown = body) =>
  router().request("/runtime/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

test("view route resolves the chat owner and returns only the stored reference", async () => {
  const chat = spyOn(ai.aiConversations, "getConversation").mockResolvedValue(conversation);
  const save = spyOn(ai, "createAiConversationView").mockResolvedValue(ref);
  try {
    expect(await (await request()).json()).toEqual(ref);
    expect(chat).toHaveBeenCalledWith({ conversationId: conversation.id, ownerUserId: identity.user.id });
    expect(save).toHaveBeenCalledWith({ ...body, ownerUserId: identity.user.id });
  } finally {
    chat.mockRestore();
    save.mockRestore();
  }
});

test("view route rejects missing, archived, restricted and unreadable Project chats", async () => {
  const chat = spyOn(ai.aiConversations, "getConversation");
  const project = spyOn(ai.aiProjects, "get").mockResolvedValue(null);
  const save = spyOn(ai, "createAiConversationView").mockResolvedValue(ref);
  try {
    for (const value of [
      null,
      { ...conversation, archivedAt: "2026-01-01" },
      { ...conversation, allowedTools: ["chart"] },
      { ...conversation, projectId: "project" },
    ]) {
      chat.mockResolvedValue(value);
      expect((await request()).status).toBe(403);
    }
    expect(save).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledWith("project", identity.accessSubject, "read");
  } finally {
    chat.mockRestore();
    project.mockRestore();
    save.mockRestore();
  }
});

test("view route maps contract, conflict and storage errors and rejects extra body keys", async () => {
  const chat = spyOn(ai.aiConversations, "getConversation").mockResolvedValue(conversation);
  const save = spyOn(ai, "createAiConversationView");
  try {
    save.mockRejectedValue(new ai.AiViewInvalidError(["rows[0].n: Expected a number or null."]));
    const invalid = await request();
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_INPUT", message: "View rejected: rows[0].n: Expected a number or null." });
    for (const [code, status] of [
      ["CONFLICT", 409],
      ["STORAGE_FULL", 400],
    ] as const) {
      save.mockRejectedValue(new ai.AiFileWriteError(code, "Rejected"));
      expect((await request()).status).toBe(status);
    }
    expect((await request({ ...body, extra: true })).status).toBe(400);
    expect((await request({ ...body, index: 64 })).status).toBe(400);
  } finally {
    chat.mockRestore();
    save.mockRestore();
  }
});

test("managed Chromium host reaches the view route as the user's actor", async () => {
  const context = { ...identity, conversationId: conversation.id, locale: "en", timeZone: "UTC", signal: new AbortController().signal };
  const session: Parameters<typeof hostFetch>[1] = {
    phase: "running",
    id: crypto.randomUUID(),
    key: conversation.id,
    conversationId: conversation.id,
    turnId: turn.id,
    background: false,
    context,
    lastUsed: Date.now(),
    busy: new Set(),
    checks: new Map(),
    checkScopes: new Set(),
    decisions: new Map(),
    capabilityTransport: async () => {
      throw new Error("Unexpected capability");
    },
    host: Promise.resolve({ health: async () => {}, execute: async () => null, call: async () => null, close: async () => {} }),
  };
  const authorization = spyOn(ai, "authorizeCodeExecution").mockResolvedValue({
    conversation,
    turn,
    config: { kind: "chat", input: "Run" },
  });
  const chat = spyOn(ai.aiConversations, "getConversation").mockResolvedValue(conversation);
  const save = spyOn(ai, "createAiConversationView").mockResolvedValue(ref);
  try {
    const response = await hostFetch(context, session, "/api/assistant/artifacts/runtime/views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ref);
    expect(save).toHaveBeenCalledWith({ ...body, ownerUserId: identity.user.id });
  } finally {
    authorization.mockRestore();
    chat.mockRestore();
    save.mockRestore();
  }
});
