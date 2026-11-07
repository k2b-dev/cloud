import { afterAll, beforeAll, expect, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { AI_NOTIFICATIONS } from "../../../core/src/ai-notifications";
import { sql } from "../runtime/clients";
import { buildEnrichmentTranscript } from "./enrich";
import { migrateCloudAi } from "./migrate";
import { dismissAiNextMessage, saveAiNextMessage } from "./next-message-store";
import { aiUserPrefs } from "./prefs";
import { userResourceContext } from "./projects.test-fixture";
import { publicAiStoredMessages } from "./public-projection";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import { loadAiStreamState } from "./stream";
import { assistantVisibleTextFromMessage } from "./timeline";

const frozen = "2026-11-07T09:00:00.000Z";
const suggestion = "Ja, entwirf die Antwort an Jana";
databaseSuite()("next message storage and projections", () => {
  const users: string[] = [];
  const chats: string[] = [];
  beforeAll(async () => {
    await migrateCloudAi();
  });
  afterAll(async () => {
    for (const id of chats) await sql`DELETE FROM ai.conversations WHERE id = ${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });
  const person = async () => {
    const uid = `next-message-${crypto.randomUUID()}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${uid}, 'local', 'user', 'Jana Fixture', ${`${uid}@example.test`}, 'Jana', 'Fixture') RETURNING id`;
    users.push(row!.id);
    return row!.id;
  };
  const fixture = async () => {
    const userId = await person();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    chats.push(conversation.id);
    const turnId = crypto.randomUUID();
    const messageId = createAiShortId();
    const runConfig = { kind: "chat", signedInSession: true, actor: userResourceContext({ type: "user", userId }).actor };
    await sql`INSERT INTO ai.turns (id, short_id, conversation_id, status, run_config, created_at)
      VALUES (${turnId}::uuid, ${createAiShortId()}, ${conversation.id}::uuid, 'running', ${JSON.stringify(runConfig)}::jsonb, ${frozen}::timestamptz)`;
    await sql`INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text, loop_id, created_at)
      VALUES (${messageId}, ${conversation.id}::uuid, 1, 'message', 'assistant',
      ${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Soll ich Jana antworten?" }], stopReason: "stop" })}::jsonb,
      'Soll ich Jana antworten?', ${turnId}, ${frozen}::timestamptz)`;
    const input = { conversationId: conversation.id, turnId, userId, text: suggestion };
    const complete = () => sql`UPDATE ai.turns SET status = 'completed', completed_at = ${frozen}::timestamptz WHERE id = ${turnId}::uuid`;
    const read = async (viewer: string | null = userId) =>
      publicAiStoredMessages(await aiConversations.listMessages({ conversationId: conversation.id }), conversation, viewer);
    return { userId, conversation, turnId, messageId, input, complete, read };
  };

  test("stores only the first suggestion and projects it to its trigger person on reload", async () => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    expect((await f.read())[0]?.suggestedNextMessage).toBeUndefined();
    await saveAiNextMessage({ ...f.input, text: "Second suggestion must not replace the first" });
    await f.complete();
    expect((await f.read())[0]?.suggestedNextMessage).toEqual({ text: suggestion, dismissedAt: null });
    expect((await f.read(await person()))[0]?.suggestedNextMessage).toBeUndefined();
    expect((await f.read(null))[0]?.suggestedNextMessage).toBeUndefined();
    expect((await loadAiStreamState(f.conversation, f.userId)).messages[0]?.suggestedNextMessage?.text).toBe(suggestion);
    expect((await loadAiStreamState(f.conversation)).messages[0]?.suggestedNextMessage).toBeUndefined();
  });

  test("dismiss is personal, idempotent and survives a reload", async () => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    await f.complete();
    const input = { conversationId: f.conversation.id, messageShortId: f.messageId, userId: f.userId };
    expect(await dismissAiNextMessage({ ...input, userId: await person() })).toBe(false);
    expect(await dismissAiNextMessage(input)).toBe(true);
    const dismissedAt = (await f.read())[0]?.suggestedNextMessage?.dismissedAt;
    expect(Number.isFinite(Date.parse(dismissedAt ?? ""))).toBe(true);
    expect(await dismissAiNextMessage(input)).toBe(true);
    expect((await f.read())[0]?.suggestedNextMessage?.dismissedAt).toBe(dismissedAt);
  });

  test.each(["failed", "aborted", "waiting_for_action"])("never projects a %s turn", async (status) => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    await sql`UPDATE ai.turns SET status = ${status} WHERE id = ${f.turnId}::uuid`;
    expect((await f.read())[0]?.suggestedNextMessage).toBeUndefined();
  });

  test.each(["stop", "redirect", "approval", "question", "queue"])("does not store after %s", async (kind) => {
    const f = await fixture();
    if (kind === "stop") await sql`UPDATE ai.turns SET cancel_requested_at = ${frozen}::timestamptz WHERE id = ${f.turnId}::uuid`;
    if (kind === "redirect")
      await sql`INSERT INTO ai.turn_steers (conversation_id, turn_id, seq, client_request_id, text, status)
      VALUES (${f.conversation.id}::uuid, ${f.turnId}::uuid, 1, 'fixture', 'Andere Aufgabe', 'consumed')`;
    if (kind === "approval" || kind === "question")
      await sql`INSERT INTO ai.pending_actions (turn_id, conversation_id, call_id, kind, tool_name, args, approval_scope, status)
      VALUES (${f.turnId}::uuid, ${f.conversation.id}::uuid, 'fixture', ${kind === "approval" ? "approval" : "client_tool"},
      ${kind === "approval" ? "send" : "survey"}, '{}'::jsonb, 'fixture', 'pending')`;
    if (kind === "queue")
      await sql`INSERT INTO ai.queued_messages (id, conversation_id, content, submission)
      VALUES (${crypto.randomUUID()}::uuid, ${f.conversation.id}::uuid, '[]'::jsonb, '{}'::jsonb)`;
    await saveAiNextMessage(f.input);
    await f.complete();
    expect((await f.read())[0]?.suggestedNextMessage).toBeUndefined();
    const [row] = await sql`SELECT suggested_next_message FROM ai.messages WHERE short_id = ${f.messageId}`;
    expect(row?.suggested_next_message).toBeNull();
  });

  test("a newer message invalidates the previous answer's suggestion", async () => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    await f.complete();
    await sql`INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text)
      VALUES (${createAiShortId()}, ${f.conversation.id}::uuid, 2, 'message', 'user', '{"role":"user","content":[{"type":"text","text":"Andere Frage"}]}'::jsonb, 'Andere Frage')`;
    expect((await f.read())[0]?.suggestedNextMessage).toBeUndefined();
  });

  test("preference defaults on and explicit off survives unrelated saves", async () => {
    const userId = await person();
    expect((await aiUserPrefs.get(userId)).suggestNextMessage).toBe(true);
    expect((await aiUserPrefs.update(userId, { suggestNextMessage: false })).suggestNextMessage).toBe(false);
    expect((await aiUserPrefs.update(userId, { memoryEnabled: false })).suggestNextMessage).toBe(false);
    expect((await aiUserPrefs.update(userId, { suggestNextMessage: true })).suggestNextMessage).toBe(true);
  });

  test("answer text export excludes the private composer field", async () => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    await f.complete();
    const [answer] = await f.read();
    expect(answer?.suggestedNextMessage?.text).toBe(suggestion);
    expect(assistantVisibleTextFromMessage(answer!.message)).toBe("Soll ich Jana antworten?");
    expect(JSON.stringify(await aiConversations.listContextMessages({ conversationId: f.conversation.id }))).not.toContain(suggestion);
  });
  test("title enrichment never reads suggestions", async () => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    await f.complete();
    expect(buildEnrichmentTranscript(await f.read())).toBe("assistant: Soll ich Jana antworten?");
  });
  test("message search never indexes suggestions", async () => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    await f.complete();
    expect((await aiConversations.searchConversationMessages({ conversationId: f.conversation.id, query: "entwirf" })).messages).toEqual(
      [],
    );
    expect(
      (await aiConversations.searchConversationMessages({ conversationId: f.conversation.id, query: "antworten" })).messages,
    ).toHaveLength(1);
  });
  test("completion notifications accept only a chat id and use fixed text", async () => {
    const f = await fixture();
    await saveAiNextMessage(f.input);
    await f.complete();
    const data = AI_NOTIFICATIONS.turnCompleted.data.parse({
      conversationId: f.conversation.shortId,
      suggestedNextMessage: (await f.read())[0]?.suggestedNextMessage,
    });
    expect(data).toEqual({ conversationId: f.conversation.shortId });
    expect(JSON.stringify(await AI_NOTIFICATIONS.turnCompleted.render(data, { locale: "de" }))).not.toContain(suggestion);
  });
});
