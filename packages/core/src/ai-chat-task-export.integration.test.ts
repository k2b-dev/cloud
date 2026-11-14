import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations } from "@k2b/cloud/ai";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { aiChatTaskRoutes } from "./ai-chat-task-routes";

suiteFor(
  "database",
  "nats",
  "valkey",
)("routine export HTTP permissions", () => {
  const users: string[] = [];
  let ownerToken: string;
  let otherToken: string;
  let adminToken: string;
  let chatId: string;
  let conversationId: string;
  beforeAll(async () => {
    const token = async (uid: string, admin = false) => {
      const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${uid}, ${admin}) RETURNING id`;
      users.push(user!.id);
      return createTestSession(user!.id);
    };
    ownerToken = await token("routine-export-http-owner");
    otherToken = await token("routine-export-http-other");
    adminToken = await token("routine-export-http-admin", true);
    const conversation = await aiConversations.createConversation({ ownerUserId: users[0]!, title: "Report target" });
    chatId = conversation.shortId;
    conversationId = conversation.id;
    await sql`INSERT INTO ai.chat_tasks(short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, run_at, timezone, state)
      VALUES ('ExTask', ${conversation.id}::uuid, ${users[0]}::uuid, 'Write a report', 'once', '2030-01-07T09:00:00Z', 'UTC', 'completed')`;
  });
  afterAll(async () => {
    if (conversationId) await sql`DELETE FROM ai.conversations WHERE id = ${conversationId}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });
  const read = (path: string, token?: string) =>
    aiChatTaskRoutes.request(path, { headers: token ? { cookie: `session_token=${token}` } : {} });
  test("serves a person's definitions, rejects unauthenticated and installation-wide reads, and permits admins", async () => {
    expect((await read("/tasks/export")).status).toBe(401);
    const own = await read("/tasks/export", ownerToken);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      format: "cloud.chat-tasks",
      version: 1,
      items: [{ id: "ExTask", targetChat: { id: chatId } }],
    });
    expect(await (await read("/tasks/export", otherToken)).json()).toMatchObject({ items: [] });
    expect((await read("/admin/tasks/export", ownerToken)).status).toBe(403);
    let after: string | null = null;
    let found = false;
    do {
      const installation = await read(`/admin/tasks/export${after ? `?after=${after}` : ""}`, adminToken);
      expect(installation.status).toBe(200);
      const exported = await installation.json();
      expect(exported.scope).toBe("installation");
      found ||= exported.items.some((item: { id: string }) => item.id === "ExTask");
      expect(JSON.stringify(exported)).not.toContain(ownerToken);
      after = exported.nextCursor;
    } while (after);
    expect(found).toBe(true);
  });
});
