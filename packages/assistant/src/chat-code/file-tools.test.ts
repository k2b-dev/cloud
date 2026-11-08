import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as ai from "@k2b/cloud/ai";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { chatCodeToolRoutes } from "./code-tool-routes";
import { testIdentity } from "./test-identity";

useUnitClients();
afterEach(() => mock.restore());
const identity = testIdentity("11111111-1111-4111-8111-111111111111");
const chatId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const conversation = spyOn(ai.aiConversations, "getConversation").mockResolvedValue({
    id: chatId,
    createdByUserId: identity.user.id,
    title: "Source",
    archivedAt: null,
    projectId: null,
  } as Awaited<ReturnType<typeof ai.aiConversations.getConversation>>);
  for (const name of ["code_files", "code_file_stat", "code_file_copy"]) {
    const invocation = chatCodeToolRoutes.routes.filter((route) => route.path === `/${name}`)[1];
    if (!invocation) throw new Error("Missing signed invocation middleware");
    // Credential signature checking has separate transport tests. Keep tool entry and file authorization real.
    spyOn(invocation, "handler").mockImplementation(async (_c, next) => next());
  }
  const router = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", identity.actor);
      c.set("accessSubject", identity.accessSubject);
      await next();
    })
    .route("/tools", chatCodeToolRoutes);
  return {
    conversation,
    request: (name: string, input: unknown, review = false) =>
      router.request(`/tools/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: chatId, input, review }),
      }),
  };
}
test("chat file routes list bounded metadata, stat exact versions and reject retired App scope", async () => {
  const f = fixture();
  const list = spyOn(ai, "listAiConversationFiles").mockResolvedValue([{ path: "/input.csv", size: 3, mediaType: "text/csv" }] as Awaited<
    ReturnType<typeof ai.listAiConversationFiles>
  >);
  const bytes = new Uint8Array([1, 2, 3]);
  spyOn(ai, "readAiConversationFile").mockResolvedValue({ bytes, mediaType: "text/csv", version: 1 } as Awaited<
    ReturnType<typeof ai.readAiConversationFile>
  >);
  const response = await f.request("code_files", { scope: "chat", id: chatId, limit: 1 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    data: { data: { nextAfter: "/input.csv", items: [{ location: { scope: "chat", id: chatId, path: "/input.csv" } }] } },
  });
  expect(list).toHaveBeenCalledWith(chatId, undefined, { after: "", limit: 1 });
  const stat = await (await f.request("code_file_stat", { file: { scope: "chat", id: chatId, path: "/input.csv" } })).json();
  expect(stat).toMatchObject({ ok: true, data: { data: { exists: true, size: 3, reference: { version: expect.any(String) } } } });
  expect((await f.request("code_files", { scope: "app", id: "App234" })).status).toBe(400);
  f.conversation.mockResolvedValue(null);
  expect((await f.request("code_files", { scope: "chat", id: chatId })).status).toBe(403);
  expect(list).toHaveBeenCalledTimes(1);
});
test("chat file copy checks Project write access and exact source version before writing", async () => {
  const f = fixture();
  spyOn(ai, "readAiConversationFile").mockResolvedValue({ bytes: new Uint8Array([1]), mediaType: "text/csv", version: 1 } as Awaited<
    ReturnType<typeof ai.readAiConversationFile>
  >);
  const project = spyOn(ai.aiProjects, "get").mockResolvedValue(null);
  const write = spyOn(ai.aiProjects, "writeFile");
  const stat = await (await f.request("code_file_stat", { file: { scope: "chat", id: chatId, path: "/input.csv" } })).json();
  const source = stat.data.data.reference;
  const input = { source, destination: { scope: "project", id: projectId, path: "copy.csv" }, expectedVersion: null };
  expect(await (await f.request("code_file_copy", input)).json()).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
  expect(project).toHaveBeenCalledWith(
    projectId,
    expect.objectContaining({ actor: identity.actor, accessSubject: identity.accessSubject }),
    "write",
  );
  project.mockResolvedValue({ id: projectId, name: "Destination" } as Awaited<ReturnType<typeof ai.aiProjects.get>>);
  spyOn(ai.aiProjects, "readFileByPath").mockResolvedValue(null);
  expect(await (await f.request("code_file_copy", { ...input, source: { ...source, version: "stale" } })).json()).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(write).not.toHaveBeenCalled();
});
