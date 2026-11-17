import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { sql } from "../runtime/clients";
import { aiConversations } from "./store";

useUnitClients();

const chatId = "11111111-1111-4111-8111-111111111111";
const queuedId = "22222222-2222-4222-8222-222222222222";
const stoppedAt = "2026-11-16T20:00:00.000Z";

test.each([
  { held: true, sendRequested: false, expected: "Queued message is no longer ready." },
  { held: true, sendRequested: true, expected: "Conversation draft changed before the turn was submitted." },
  { held: false, sendRequested: false, expected: "Conversation draft changed before the turn was submitted." },
])("promotion rechecks a preselected candidate under the chat lock (held=$held, Send now=$sendRequested)", async (scenario) => {
  // The dispatcher already selected this entry. Hold changes before its promotion gets the chat lock.
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let heldAt: string | null = null;
  let effects = 0;
  const client = new SQL("postgres://127.0.0.1:1/unused_test");
  const tx = Object.assign(
    new Proxy(client, {
      apply(_target, _receiver, [strings]) {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.startsWith("SELECT") && query.includes("FROM ai.conversations") && query.endsWith("FOR UPDATE")) {
          locked.resolve();
          return release.promise.then(() => [{ draft_revision: 1, project_id: null, queue_held_at: heldAt }]);
        }
        if (query.startsWith("SELECT") && query.includes("FROM ai.queued_messages"))
          return Promise.resolve([{ id: queuedId, status: "pending", send_requested_at: scenario.sendRequested ? stoppedAt : null }]);
        if (query.startsWith("SELECT id FROM ai.turns")) return Promise.resolve([]);
        effects++;
        throw new Error("A held candidate must not start effects");
      },
    }),
    {
      savepoint: async () => {
        throw new Error("Unexpected savepoint");
      },
    },
  );
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return run(tx);
  });
  try {
    const promoted = aiConversations.submitChatTurn({
      conversationId: chatId,
      queuedMessageId: queuedId,
      modelId: "fixture",
      // A later, existing guard distinguishes admission from a hold rejection without starting effects.
      expectedDraftRevision: 0,
      userMessage: { role: "user", content: [{ type: "text", text: "Danach die Zusammenfassung." }] },
      runConfig: { kind: "chat", input: "Danach die Zusammenfassung.", toolSource: { kind: "none" } },
    });
    await locked.promise;
    heldAt = scenario.held ? stoppedAt : null;
    release.resolve();
    await expect(promoted).rejects.toThrow(scenario.expected);
    expect(effects).toBe(0);
  } finally {
    release.resolve();
    begin.mockRestore();
    await client.close();
  }
});
