import { expect, test } from "bun:test";
import { type CloudCliContext, defineCliCommands } from "@k2b/cloud/cli";
import { assistantChatCommands } from "./chat";
import { resolveConversation } from "./turn";

const context = (args: string[] = [], flags: CloudCliContext["flags"] = {}) => {
  const requests: unknown[] = [];
  let conversation = { id: "chat", title: "New chat", titleSource: "default" };
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
    json: () => {},
    jsonLine: () => {},
    table: () => {},
  };
  return { ctx, requests };
};
const expectedRequests = (title: string) => [
  { path: "/api/ai/conversations", method: "POST", body: {} },
  { path: "/api/ai/conversations/chat", method: "PATCH", body: { title } },
];
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
