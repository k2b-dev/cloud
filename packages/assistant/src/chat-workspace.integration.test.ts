import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations } from "@k2b/cloud/ai";
import { createPanesLayout } from "@k2b/ui";
import { databaseSuite, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { migrateArtifacts } from "./artifacts/migrate";
import { testIdentity } from "./artifacts/test-identity";
import type { ChatWorkspaceState } from "./chat-workspace";
import { loadAssistantChatWorkspace, saveAssistantChatWorkspace } from "./chat-workspace-service";

databaseSuite()("personal chat workspace persistence", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  const owner = testIdentity("11111111-1111-4111-8111-111111111111");
  const other = testIdentity("22222222-2222-4222-8222-222222222222");
  const empty: ChatWorkspaceState = { tabs: [], layout: null, front: null };
  const state: ChatWorkspaceState = {
    tabs: [{ id: "tab_a", key: '{"file":"/report.md"}', title: "Report", pinned: true }],
    layout: createPanesLayout(["tab_a"]),
    front: "tab_a",
  };
  beforeAll(async () => {
    database = await useMigratedDatabase("assistant_chat_workspaces");
    await migrateArtifacts();
    await migrateArtifacts();
    for (const who of [owner, other])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name)
        VALUES(${who.user.id}::uuid,${who.user.id},'local','user','Workspace test')`;
  }, 120_000);
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });
  const chat = () => aiConversations.createConversation({ ownerUserId: owner.user.id, title: "Workspace test" });

  test("load, create, update, conflict, and closing every tab", async () => {
    const conversation = await chat();
    const id = conversation.shortId;
    expect(await loadAssistantChatWorkspace(owner, id)).toEqual({ state: empty, revision: 0 });
    expect(await saveAssistantChatWorkspace(owner, id, { state, revision: 0 })).toEqual({ conflict: false, revision: 1 });
    expect(await loadAssistantChatWorkspace(owner, id)).toEqual({ state, revision: 1 });
    const next = { ...state, tabs: [{ ...state.tabs[0]!, title: "Renamed" }] };
    expect(await saveAssistantChatWorkspace(owner, id, { state: next, revision: 1 })).toEqual({ conflict: false, revision: 2 });
    expect(await saveAssistantChatWorkspace(owner, id, { state, revision: 1 })).toEqual({ conflict: true, state: next, revision: 2 });
    expect(await saveAssistantChatWorkspace(owner, id, { state: empty, revision: 1 })).toEqual({
      conflict: true,
      state: next,
      revision: 2,
    });
    // Closing every tab keeps the row and its revision: an older device cannot bring the closed tabs back.
    expect(await saveAssistantChatWorkspace(owner, id, { state: empty, revision: 2 })).toEqual({ conflict: false, revision: 3 });
    expect(await loadAssistantChatWorkspace(owner, id)).toEqual({ state: empty, revision: 3 });
    expect(await saveAssistantChatWorkspace(owner, id, { state, revision: 2 })).toEqual({ conflict: true, state: empty, revision: 3 });
    expect(await saveAssistantChatWorkspace(owner, id, { state, revision: 3 })).toEqual({ conflict: false, revision: 4 });
  });

  test("two devices writing the same revision cannot overwrite each other", async () => {
    const conversation = await chat();
    const id = conversation.shortId;
    expect(await saveAssistantChatWorkspace(owner, id, { state, revision: 0 })).toEqual({ conflict: false, revision: 1 });
    const attempts = ["First device", "Second device"].map((title) => ({ ...state, tabs: [{ ...state.tabs[0]!, title }] }));
    const results = await Promise.all(attempts.map((attempt) => saveAssistantChatWorkspace(owner, id, { state: attempt, revision: 1 })));
    expect(results.filter((result) => result?.conflict === false)).toHaveLength(1);
    const current = await loadAssistantChatWorkspace(owner, id);
    if (!current) throw new Error("Missing workspace after concurrent saves");
    expect(current.revision).toBe(2);
    expect(results.find((result) => result?.conflict)).toEqual({ conflict: true, ...current });
  });

  test("another person's chat is unreadable and unwritable, including when it has no workspace", async () => {
    const conversation = await chat();
    expect(await loadAssistantChatWorkspace(other, conversation.shortId)).toBeNull();
    await saveAssistantChatWorkspace(owner, conversation.shortId, { state, revision: 0 });
    expect(await loadAssistantChatWorkspace(other, conversation.shortId)).toBeNull();
    expect(await saveAssistantChatWorkspace(other, conversation.shortId, { state: empty, revision: 1 })).toBeNull();
    expect(await saveAssistantChatWorkspace(other, conversation.shortId, { state, revision: 1 })).toBeNull();
    expect(await loadAssistantChatWorkspace(owner, conversation.shortId)).toEqual({ state, revision: 1 });
    expect(await loadAssistantChatWorkspace(owner, "Gone01")).toBeNull();
    expect(await saveAssistantChatWorkspace(owner, "Gone01", { state, revision: 0 })).toBeNull();
  });

  test("non-user access subjects are rejected", async () => {
    const identity = { ...owner, accessSubject: { type: "service_account" as const, serviceAccountId: other.user.id } };
    await expect(loadAssistantChatWorkspace(identity, "Chat01")).rejects.toThrow("user-backed identity");
    await expect(saveAssistantChatWorkspace(identity, "Chat01", { state, revision: 0 })).rejects.toThrow("user-backed identity");
  });

  test("deleting a conversation cascades its workspace", async () => {
    const conversation = await chat();
    await saveAssistantChatWorkspace(owner, conversation.shortId, { state, revision: 0 });
    await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
    expect(await sql`SELECT 1 FROM assistant.chat_workspaces WHERE conversation_id=${conversation.id}::uuid`).toHaveLength(0);
    expect(await loadAssistantChatWorkspace(owner, conversation.shortId)).toBeNull();
  });
});
