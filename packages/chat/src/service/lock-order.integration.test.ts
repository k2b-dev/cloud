import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { messageFixtures } from "../api/messages.test-fixture";
import { deliverMessage, notificationOutbox } from "./notification-delivery";

const waitForBlockedTransaction = async (blockerPid: number) => {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const [waiting] = await sql<{ blocked: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))
    ) AS blocked`;
    if (waiting?.blocked) return;
    if (performance.now() >= deadline) throw new Error("Notification delivery did not reach the row lock barrier");
    await Bun.sleep(10);
  }
};

suiteFor(
  "database",
  "nats",
  "valkey",
)("Chat conversation/message lock order", () => {
  const f = messageFixtures();

  test("a reaction holding the conversation can finish while notification delivery waits", async () => {
    const wake = spyOn(notificationOutbox, "notify").mockResolvedValue(undefined);
    const delivery = Promise.withResolvers<boolean>();
    // Observe rejection immediately, including when the old lock order chooses delivery as the deadlock victim.
    const delivered = delivery.promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let started = false;
    try {
      const author = await f.person("Nora Weber");
      const recipient = await f.person("Lea Müller");
      const chat = await f.fixture(author, [{ person: recipient, permission: "write" }]);
      const response = await f.request(author.headers, `/${chat.shortId}/messages`, "POST", {
        body: "React while this message is being delivered",
        clientId: crypto.randomUUID(),
      });
      expect(response.status).toBe(201);
      const [message] = await sql<
        { id: string }[]
      >`SELECT id FROM chat.messages WHERE conversation_id = ${chat.id}::uuid AND kind = 'text'`;
      if (!message) throw new Error("Missing fixture message");

      await sql.begin(async (db) => {
        await db`SET LOCAL statement_timeout = '5s'`;
        // The first half of reactions.set: serialize the reaction budget and access with all chat writes.
        await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
        const [self] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!self) throw new Error("Missing reaction transaction");
        started = true;
        void deliverMessage(message.id).then(delivery.resolve, delivery.reject);

        // A database barrier, not a timing race: old delivery holds the message and waits at its conversation FK;
        // fixed delivery waits for the conversation before taking the message. Both are blocked by this transaction.
        await waitForBlockedTransaction(self.pid);

        // The second half of reactions.set: FK KEY SHARE on the message, then its revision update.
        await db`INSERT INTO chat.message_reactions (message_id, principal_type, principal_id, display_name, emoji)
          VALUES (${message.id}::uuid, 'user', ${recipient.id}::uuid, ${recipient.name}, '👍')`;
        const [head] = await db<{ rev: string }[]>`UPDATE chat.conversations SET rev = rev + 1 WHERE id = ${chat.id}::uuid RETURNING rev`;
        if (!head) throw new Error("Missing reaction conversation");
        await db`UPDATE chat.messages SET rev = ${head.rev} WHERE id = ${message.id}::uuid`;
      });

      expect(await delivered).toEqual({ ok: true, value: false });
      expect(await sql`SELECT 1 FROM chat.message_reactions WHERE message_id = ${message.id}::uuid`).toHaveLength(1);
      expect(
        await sql`SELECT 1 FROM chat.notification_pending WHERE message_id = ${message.id}::uuid AND user_id = ${recipient.id}::uuid`,
      ).toHaveLength(1);
      expect(await sql`SELECT 1 FROM chat.messages WHERE id = ${message.id}::uuid AND notification_done`).toHaveLength(1);
    } finally {
      // The reaction transaction has committed or rolled back, so delivery can release every lock before cleanup.
      if (started) await delivered;
      wake.mockRestore();
    }
  }, 15_000);

  test("delivery leaves conversation FK checks available to the first push-state insert", async () => {
    const wake = spyOn(notificationOutbox, "notify").mockResolvedValue(undefined);
    const delivery = Promise.withResolvers<boolean>();
    const delivered = delivery.promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let started = false;
    try {
      const author = await f.person("Nora Weber");
      const recipient = await f.person("Lea Müller");
      const chat = await f.fixture(author, [{ person: recipient, permission: "write" }]);
      const response = await f.request(author.headers, `/${chat.shortId}/messages`, "POST", {
        body: "Deliver while the first push state is created",
        clientId: crypto.randomUUID(),
      });
      expect(response.status).toBe(201);
      const [message] = await sql<
        { id: string }[]
      >`SELECT id FROM chat.messages WHERE conversation_id = ${chat.id}::uuid AND kind = 'text'`;
      if (!message) throw new Error("Missing fixture message");

      await sql.begin(async (db) => {
        // Pause real delivery after its conversation lock but before it can insert push state.
        await db`SELECT id FROM chat.messages WHERE id = ${message.id}::uuid FOR UPDATE`;
        const [self] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!self) throw new Error("Missing message blocker");
        started = true;
        void deliverMessage(message.id).then(delivery.resolve, delivery.reject);
        await waitForBlockedTransaction(self.pid);

        await sql.begin(async (push) => {
          await push`SET LOCAL lock_timeout = '1s'`;
          // sendPush's first insert must finish its conversation FK before delivery reaches ON CONFLICT.
          // Otherwise this uncommitted row and delivery's conversation lock can form another cycle.
          await push`INSERT INTO chat.notification_push_state (user_id, conversation_id)
            VALUES (${recipient.id}::uuid, ${chat.id}::uuid) ON CONFLICT DO NOTHING`;
        });
      });

      expect(await delivered).toEqual({ ok: true, value: false });
      expect(
        await sql`SELECT 1 FROM chat.notification_pending WHERE message_id = ${message.id}::uuid AND user_id = ${recipient.id}::uuid`,
      ).toHaveLength(1);
    } finally {
      if (started) await delivered;
      wake.mockRestore();
    }
  }, 15_000);
});
