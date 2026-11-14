import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import type { UserRequestActor } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { accounts } from "../services/accounts";
import { ChatTaskExportForbiddenError, exportChatTasks } from "./chat-task-export";
import { aiChatTasks } from "./chat-tasks";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

// No inference, scheduler or provider is needed to export a definition.
databaseSuite()("routine definition export", () => {
  const users: string[] = [];
  let owner: UserRequestActor;
  let other: UserRequestActor;
  let admin: UserRequestActor;
  let conversationId = "";
  let chatId = "";
  beforeAll(async () => {
    setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    await migrateCloudAi();
    const actor = async (uid: string, isAdmin = false): Promise<UserRequestActor> => {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${uid}, ${isAdmin}) RETURNING id`;
      const user = await accounts.users.get({ id: row!.id });
      if (!user) throw new Error("Missing export fixture user");
      users.push(user.id);
      return { kind: "user", user };
    };
    owner = await actor("task-export-owner");
    other = await actor("task-export-other");
    admin = await actor("task-export-admin", true);
    const conversation = await aiConversations.createConversation({ ownerUserId: owner.user.id, title: "Weekly report" });
    conversationId = conversation.id;
    chatId = conversation.shortId;
    const task = await aiChatTasks.create({
      userId: owner.user.id,
      chatId,
      prompt: "Summarize my mailbox and report here.",
      schedule: { kind: "cron", cron: "0 9 * * 1" },
      timezone: "Europe/Berlin",
      grants: [{ kind: "http", fixedInput: { origin: "https://example.test", method: "GET" } }],
    });
    if (!task) throw new Error("Missing fixture task");
    await aiChatTasks.setState({ userId: owner.user.id, taskId: task.shortId, state: "paused" });
    // More than the ordinary list's 100-task limit; use deterministic identities.
    await sql`INSERT INTO ai.chat_tasks(id, short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, cron, timezone, state)
      SELECT ('44bc0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Ex' || lpad(n::text, 4, '0'),
        ${conversationId}::uuid, ${owner.user.id}::uuid, 'Historical definition', 'cron', '0 9 * * 1', 'Europe/Berlin', 'completed'
      FROM generate_series(1, 101) n`;
  });
  afterAll(async () => {
    if (conversationId) await sql`DELETE FROM ai.conversations WHERE id = ${conversationId}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    setSystemTime();
  });
  test("exports every state with schedule, timezone, grants and mandate summary", async () => {
    const entries = [];
    let after: string | undefined;
    do {
      const page = await exportChatTasks(owner, { after });
      expect(page).toMatchObject({ format: "cloud.chat-tasks", version: 1, authority: "none", scope: "person" });
      entries.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(entries).toHaveLength(102);
    expect(entries.find((item) => item.state === "paused")).toMatchObject({
      prompt: "Summarize my mailbox and report here.",
      targetChat: { id: chatId, title: "Weekly report" },
      schedule: { kind: "cron", cron: "0 9 * * 1" },
      timezone: "Europe/Berlin",
      grants: [{ kind: "http", fixedInput: { origin: "https://example.test", method: "GET" } }],
      mandateSummary: { state: "paused", apps: ["assistant"], operations: ["runtime.http"] },
    });
    expect(JSON.stringify(entries)).not.toMatch(/credential|authorization_snapshot|access_token|refresh_token/iu);
  });
  test("people export only their own routines; only current admins export the installation", async () => {
    expect((await exportChatTasks(other)).items).toEqual([]);
    await expect(exportChatTasks(other, { all: true })).rejects.toBeInstanceOf(ChatTaskExportForbiddenError);
    await expect(
      exportChatTasks(
        { ...admin, delegation: { kind: "invocation", callingAppId: "assistant", credentialKind: "mandate", invocationId: "fixture" } },
        { all: true },
      ),
    ).rejects.toBeInstanceOf(ChatTaskExportForbiddenError);
    expect((await exportChatTasks(admin, { all: true })).scope).toBe("installation");
    await sql`UPDATE auth.users SET admin = false WHERE id = ${admin.user.id}::uuid`;
    await expect(exportChatTasks(admin, { all: true })).rejects.toBeInstanceOf(ChatTaskExportForbiddenError);
  });
});
