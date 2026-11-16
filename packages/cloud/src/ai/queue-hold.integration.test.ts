import { expect } from "bun:test";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import {
  drainQueuedMessages,
  enqueueChatMessage,
  listQueuedMessages,
  migrateAiMessageQueue,
  requestQueuedMessageSendNow,
} from "./message-queue";
import type { AiStoredMessageOrigin } from "./queue-contracts";
import { aiConversations } from "./store";
import type { AiConversationService } from "./types";

const integration = testFor("database");
type Submission = Parameters<AiConversationService["submitChatTurn"]>[0];

/** A chat with a running turn and two waiting entries, one of a person and one of an automation (fictional data). */
const fixture = async () => {
  await migrateAiMessageQueue();
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,mail,given_name,sn)
    VALUES (${crypto.randomUUID()},'local','user','Hold owner','hold-owner@example.test','Hold','Owner') RETURNING id`;
  const chat = await aiConversations.createConversation({ ownerUserId: user!.id });
  const input = (text: string, origin: AiStoredMessageOrigin): Submission => ({
    conversationId: chat.id,
    modelId: "fixture",
    userMessage: { role: "user", content: [{ type: "text", text }] },
    runConfig: {
      kind: "chat",
      input: text,
      accessSubject: { type: "user", userId: user!.id },
      writerOrigin: origin,
      toolSource: { kind: "none" },
    },
  });
  const add = async (text: string, origin: AiStoredMessageOrigin = { kind: "person", id: user!.id }) => {
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, input(text, origin), [{ type: "text", text }]);
    return id;
  };
  const [turn] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id, conversation_id, status)
    VALUES (${`hold-${crypto.randomUUID()}`}, ${chat.id}::uuid, 'running') RETURNING id`;
  const person = await add("Danach eine kurze Zusammenfassung für Tom.");
  const automation = await add("Lagerbestand prüfen", { kind: "automation", id: "fictional-automation", runId: "fictional-run" });
  /** A person's Stop, then the turn ends as stopped. */
  const stop = async () => {
    expect((await aiConversations.requestTurnAbort({ conversationId: chat.id, turnId: turn!.id, reason: "user" })).found).toBe(true);
    await sql`UPDATE ai.turns SET status='aborted', completed_at=now() WHERE id=${turn!.id}::uuid`;
  };
  const jobs: Array<{ conversationId: string; turnId: string }> = [];
  const drain = () =>
    drainQueuedMessages(async (job) => {
      jobs.push(job);
    }, chat.id);
  const started = async () =>
    (
      await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id=${chat.id}::uuid AND id <> ${turn!.id}::uuid`
    )[0]!.count;
  return {
    chat,
    userId: user!.id,
    person,
    automation,
    add,
    stop,
    drain,
    jobs,
    started,
    async finish(turnId: string) {
      await sql`UPDATE ai.turns SET status='completed', completed_at=now() WHERE id=${turnId}::uuid`;
    },
    async close() {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    },
  };
};

integration("after a person's Stop no turn starts by itself, also 8 s later, and every entry stays queued", async () => {
  const f = await fixture();
  try {
    await f.stop();
    await f.drain();
    // The hold does not lapse with time: 8 s after the Stop (the preview's gap, #108) the queue still waits.
    await sql`UPDATE ai.conversations SET queue_held_at = queue_held_at - interval '8 seconds' WHERE id=${f.chat.id}::uuid`;
    await f.drain();
    expect(f.jobs).toEqual([]);
    expect(await f.started()).toBe(0);
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([f.person, f.automation]);
  } finally {
    await f.close();
  }
});

integration("Send now starts exactly its entry; the rest stays held", async () => {
  const f = await fixture();
  try {
    await f.stop();
    expect(await requestQueuedMessageSendNow(f.chat.id, f.automation)).toEqual({ interrupt: null });
    await f.drain();
    expect(f.jobs).toHaveLength(1);
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([f.person]);
    await f.finish(f.jobs[0]!.turnId);
    await f.drain();
    expect(f.jobs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

integration("a new message of the person resumes the queue in its order; an automation's message does not", async () => {
  const f = await fixture();
  try {
    await f.stop();
    await f.add("Neue Prüfung", { kind: "automation", id: "fictional-automation", runId: "fictional-run-2" });
    await f.drain();
    expect(f.jobs).toEqual([]);
    const mine = await f.add("Und jetzt bitte weiter.");
    await f.drain();
    expect(f.jobs).toHaveLength(1);
    // Normal order again: the oldest entry goes first, the new message waits at the end.
    const remaining = (await listQueuedMessages(f.chat.id)).map(({ id }) => id);
    expect(remaining[0]).toBe(f.automation);
    expect(remaining.at(-1)).toBe(mine);
    expect(remaining).not.toContain(f.person);
  } finally {
    await f.close();
  }
});

integration("archiving a chat with queued entries lets them lapse (#108)", async () => {
  const f = await fixture();
  try {
    await f.stop();
    expect(await aiConversations.archiveConversation({ conversationId: f.chat.id, ownerUserId: f.userId })).toBe(true);
    expect(await listQueuedMessages(f.chat.id)).toEqual([]);
    const lapsed = await sql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM ai.queued_messages WHERE conversation_id=${f.chat.id}::uuid ORDER BY position`;
    expect(lapsed).toEqual([
      { status: "cancelled", error: "chat_archived" },
      { status: "cancelled", error: "chat_archived" },
    ]);
    await f.drain();
    expect(f.jobs).toEqual([]);
  } finally {
    await f.close();
  }
});
