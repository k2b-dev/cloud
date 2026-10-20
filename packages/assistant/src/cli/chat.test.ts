import { expect, test } from "bun:test";
import { type CloudCliContext, defineCliCommands } from "@k2b/cloud/cli";
import { actionOriginMessages } from "./action-question";
import { assistantChatCommands, assistantManagementCommands } from "./chat";
import { resolveConversation } from "./turn";

const context = (args: string[] = [], flags: CloudCliContext["flags"] = {}) => {
  const requests: unknown[] = [];
  const values: unknown[] = [];
  let conversation = { id: "chat", shortId: "chat", title: "New chat", titleSource: "default" };
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://example.test", token: "test", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, method: init?.method ?? "GET", body });
      if (init?.method === "PATCH") {
        conversation = {
          ...conversation,
          title: body.title,
          titleSource: body.title !== conversation.title ? "user" : conversation.titleSource,
        };
      }
      return Response.json(init?.method ? conversation : { conversation });
    },
    readJson: (response) => response.json(),
    print: () => {},
    write: async () => {},
    error: () => {},
    json: (value) => {
      values.push(value);
    },
    jsonLine: (value) => {
      values.push(value);
    },
    table: () => {},
  };
  return { ctx, requests, values };
};
const expectedRequests = (title: string) => [
  { path: "/api/ai/conversations", method: "POST", body: {} },
  { path: "/api/ai/conversations/chat", method: "PATCH", body: { title } },
];
test.each([" ", "x".repeat(121)])("rejects invalid title %j before resolving a new chat", async (title) => {
  const { ctx, requests } = context();
  await expect(resolveConversation(ctx, { title })).rejects.toThrow("Chat titles must have 1 to 120 characters.");
  expect(requests).toEqual([]);
});
test.each([" ", "x".repeat(121)])("chats create rejects invalid title %j before any request", async (title) => {
  const { ctx, requests } = context(["chats", "create"], { title });
  await expect(
    defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantChatCommands] }).run(ctx),
  ).rejects.toThrow("Chat titles must have 1 to 120 characters.");
  expect(requests).toEqual([]);
});
test("trims an explicit title before renaming a new chat", async () => {
  const { ctx, requests } = context();
  expect(await resolveConversation(ctx, { title: " Research " })).toMatchObject({ title: "Research", titleSource: "user" });
  expect(requests).toEqual(expectedRequests("Research"));
});
test("print-mode chat resolution creates a draft then applies the user's title through metadata", async () => {
  const { ctx, requests } = context();
  expect(await resolveConversation(ctx, { title: "Research" })).toMatchObject({ title: "Research", titleSource: "user" });
  expect(requests).toEqual(expectedRequests("Research"));
});
test("chats create applies an explicit title through metadata after creation", async () => {
  const { ctx, requests } = context(["chats", "create"], { title: "Research" });
  await defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantChatCommands] }).run(ctx);
  expect(requests).toEqual(expectedRequests("Research"));
});
test("an omitted title leaves automatic naming enabled and a selected chat is not renamed", async () => {
  const { ctx, requests } = context();
  await resolveConversation(ctx, {});
  await resolveConversation(ctx, { conversationId: "chat", title: "Ignored" });
  expect(requests).toEqual([
    { path: "/api/ai/conversations", method: "POST", body: {} },
    { path: "/api/ai/conversations/chat", method: "GET", body: undefined },
  ]);
});

test("an explicit title equal to the placeholder uses the existing metadata behavior", async () => {
  const { ctx, requests } = context();
  expect(await resolveConversation(ctx, { title: "New chat" })).toMatchObject({ title: "New chat", titleSource: "default" });
  expect(requests).toEqual(expectedRequests("New chat"));
});

test("creating a titled chat preserves its project assignment", async () => {
  const { ctx, requests } = context(["chats", "create"], { title: "Research", project: "project" });
  await defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantChatCommands] }).run(ctx);
  expect(requests).toEqual([
    { path: "/api/ai/conversations", method: "POST", body: { projectId: "project" } },
    { path: "/api/ai/conversations/chat", method: "PATCH", body: { title: "Research" } },
  ]);
});

test("system-prompt --local includes this computer and the profile's local tools default", async () => {
  const { ctx, requests } = context(["prefs", "system-prompt"], { local: true });
  ctx.getDefault = async (key) => (key === "assistant.localTools" ? "off" : undefined);
  await defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantManagementCommands] }).run(ctx);
  const request = requests[0];
  if (!request || typeof request !== "object" || !("path" in request) || typeof request.path !== "string")
    throw new Error("Expected prompt request");
  const params = new URL(request.path, ctx.options.server).searchParams;
  expect(params.get("clientKind")).toBe("cli");
  expect(params.get("cwd")).toBe(process.cwd());
  expect(params.get("os")).toBeTruthy();
  expect(params.get("shell")).toBe("/bin/bash");
  expect(params.get("localTools")).toBe("off");
});

test.each(["json", "jsonl"] as const)("chats create emits an absolute canonical permalink in %s", async (output) => {
  const { ctx, values } = context(["chats", "create"]);
  ctx.options.output = output;
  await defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantChatCommands] }).run(ctx);
  expect(values).toMatchObject([{ id: "chat", permalink: "http://example.test/open/core.ai.chat/~chat" }]);
});

test.each(["pin", "unpin", "restore", "done", "reopen"])("chats %s returns an absolute permalink with the updated chat", async (action) => {
  const { ctx, values } = context(["chats", action, "chat"]);
  await defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantChatCommands] }).run(ctx);
  expect(values).toMatchObject([{ id: "chat", permalink: "http://example.test/open/core.ai.chat/~chat" }]);
});

test("actions list prints the shared question block with absolute links and exact commands; JSON stays raw", async () => {
  const action = {
    type: "approval_request" as const,
    conversationId: "chat-7",
    turnId: "turn-8",
    callId: "call-9",
    name: "mail.send",
    args: { id: "draft-1" },
    message: "Old clients retain this message.",
    allowAlways: false,
    allowChat: false,
    app: { id: "mail", name: "Mail" },
    chatTitle: "Maintenance",
    review: {
      locale: "en",
      ask: "sends" as const,
      sentence: {
        action: "Send email {mail} to {to}",
        running: "Sending {mail}",
        done: "Sent {mail}",
        confirm: "Send to Lea",
        decline: "Don't send",
        notRun: "Didn't send {mail}",
      },
      slots: {
        mail: { kind: "object" as const, title: "Maintenance" },
        to: { kind: "person" as const, people: [{ name: "Lea Berg", address: "lea.berg@example.com" }] },
      },
      preview: {
        kind: "message" as const,
        from: { name: "Team Ops", address: "ops@example.com" },
        to: [{ name: "Lea Berg", address: "lea.berg@example.com" }],
        subject: "Maintenance",
        body: "Hello Lea,\nMaintenance is on Tuesday.",
        format: "plain" as const,
      },
      links: [{ rel: "open" as const, href: "/mail/drafts/draft-1?revision=7" }],
    },
  };
  for (const output of ["text", "json", "jsonl"] as const) {
    const { ctx, values } = context(["actions", "list", "chat-7", "turn-8"]);
    const printed: string[] = [];
    const tables: unknown[] = [];
    ctx.options.output = output;
    ctx.fetch = async () => Response.json([action]);
    ctx.print = (line = "") => printed.push(line);
    ctx.table = (rows) => tables.push(rows);
    await defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantManagementCommands] }).run(ctx);
    if (output === "json") {
      expect(values).toEqual([[action]]);
      expect(printed).toEqual([]);
    } else if (output === "jsonl") {
      expect(values).toEqual([
        {
          call: "call-9",
          type: "approval_request",
          name: "mail.send",
          detail: action.message,
        },
      ]);
    } else {
      expect(printed).toEqual([
        "? Send email “Maintenance” to Lea Berg <lea.berg@example.com>?",
        "  I'm asking because this leaves Cloud.",
        "  Mail · Chat “Maintenance”",
        "  From:    Team Ops <ops@example.com>",
        "  To:      Lea Berg <lea.berg@example.com>",
        "  Subject: Maintenance",
        "  Hello Lea,",
        "  Maintenance is on Tuesday.",
        "  Read all: http://example.test/mail/drafts/draft-1?revision=7",
        "  Send to Lea: cld assistant actions approve chat-7 turn-8 call-9",
        "  Don't send:  cld assistant actions reject chat-7 turn-8 call-9",
      ]);
      expect(tables).toEqual([]);
    }
  }
});

test("question origin labels cover both locales", () => {
  expect(actionOriginMessages.check()).toEqual([]);
  expect(actionOriginMessages.resolve(["de"]).t.chat({ title: "Wartung" })).toBe("Chat „Wartung“");
  expect(actionOriginMessages.resolve(["en"]).t.expires({ at: "16 Oct, 23:14" })).toBe("open until 16 Oct, 23:14");
});

test("actions list sanitizes legacy question lines at the terminal boundary", async () => {
  const { ctx } = context(["actions", "list", "chat", "turn"]);
  const printed: string[] = [];
  ctx.options.output = "text";
  ctx.fetch = async () =>
    Response.json([
      {
        type: "approval_request",
        conversationId: "chat",
        turnId: "turn",
        callId: "call",
        name: "send",
        args: {},
        message: "Mail: Send this\nTo: Lea\u001b[2J",
        app: { id: "mail", name: "Mail" },
        allowAlways: false,
        allowChat: false,
      },
    ]);
  ctx.print = (line = "") => printed.push(line);
  await defineCliCommands({ name: "assistant", summary: "Assistant", commands: [...assistantManagementCommands] }).run(ctx);
  expect(printed[0]).toBe("? Send this?");
  expect(printed).toContain("  To: Lea\\u001b[2J");
});
