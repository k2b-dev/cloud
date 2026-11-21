import { afterAll, expect, spyOn } from "bun:test";
import { z } from "zod";
import { databaseSuite, testFor } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import "../../../../../scripts/fixtures/authorization-preload";
import { defineApp, notification } from "../..";
import * as bulk from "../outgoing-mail/enqueue";
import { toPgTextArray, toPgUuidArray } from "../postgres";
import { decryptSecret } from "../secrets";
import { notifications } from ".";
import { __notificationBatchTest } from "./batches";
import { browserNotifications } from "./browser";
import { getNotificationChannel } from "./channels";
import { processNotificationDelivery } from "./dispatcher";
import * as runtime from "./runtime";

const suite = databaseSuite();

const secret = "Content after the lock";

const app = defineApp({
  id: "notification-lock-test",
  name: "Notification Lock Test",
  icon: "ti ti-bell",
  description: "Account lock fixture for notification delivery.",
  baseUrl: "http://notification-lock-test:3000",
  routes: ["/notification-lock-test"],
  notifications: {
    required: notification({
      recipient: "user",
      label: "Required",
      description: "Goes to the browser and by email.",
      delivery: { required: ["browser", "email"] },
      data: z.object({ text: z.string() }),
      render: ({ text }) => ({ title: "Update", body: text, preview: text }),
    }),
    recommended: notification({
      recipient: "user",
      label: "Recommended",
      description: "Goes to the browser first, then by email.",
      delivery: { recommended: ["browser", "email"] },
      data: z.object({ text: z.string() }),
      render: ({ text }) => ({ title: "Update", body: text, preview: text }),
    }),
    email: notification({
      recipient: "user",
      label: "Email",
      description: "Goes by email.",
      delivery: { recommended: ["email"] },
      data: z.object({ text: z.string() }),
      render: ({ text }) => ({ title: "Update", body: text }),
    }),
  },
});

const createUser = async () => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`notification-lock-${suffix}`}, 'ipa', 'user', 'Lock Test', ${`lock-${suffix}@example.test`}, 'Lock', 'Test')
    RETURNING id
  `;
  const userId = user!.id;
  await browserNotifications.registerEndpoint({
    userId,
    label: "Phone",
    subscription: {
      endpoint: `https://push.example.test/subscriptions/${suffix}`,
      expirationTime: null,
      keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
    },
  });
  return userId;
};

const lock = (userId: string) => sql`
  INSERT INTO auth.user_ipa_data (user_id, locked_at) VALUES (${userId}::uuid, now())
  ON CONFLICT (user_id) DO UPDATE SET locked_at = now()
`;
const unlock = (userId: string) => sql`UPDATE auth.user_ipa_data SET locked_at = NULL WHERE user_id = ${userId}::uuid`;

/** Observes the browser and email transports without contacting a push service or mail server. */
const interceptTransports = (emailOutcome?: { status: "pending"; retryAfterMs: number; outgoingMailId: string }) => {
  const sent: { channel: string; payload: unknown }[] = [];
  const spies = (["browser", "email"] as const).map((channel) => {
    const driver = getNotificationChannel(channel);
    if (!driver) throw new Error(`The ${channel} channel is not registered`);
    return spyOn(driver, "deliver").mockImplementation(async (payload) => {
      sent.push({ channel, payload });
      return channel === "email" ? emailOutcome : undefined;
    });
  });
  const enqueue = spyOn(runtime, "enqueueNotificationDeliveries").mockResolvedValue(undefined);
  const enqueueOne = spyOn(runtime, "enqueueNotificationDelivery").mockResolvedValue(undefined);
  return {
    sent,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
      enqueue.mockRestore();
      enqueueOne.mockRestore();
    },
  };
};

const storedPayloads = async (eventId: string) =>
  sql<{ channel: string; status: string; error_code: string | null; payload_encrypted: string | null }[]>`
    SELECT channel, status, error_code, payload_encrypted FROM notifications.deliveries WHERE event_id = ${eventId}::uuid ORDER BY channel
  `;

suite("notifications to locked accounts", () => {
  afterAll(async () => {
    await sql`DELETE FROM notifications.definitions WHERE app_id = 'notification-lock-test'`;
  });

  testFor("database", "nats")("a locked account receives no notifications, and receives them again after unlocking", async () => {
    const userId = await createUser();
    const transports = interceptTransports();
    try {
      await lock(userId);
      const locked = await notifications.send(app.notifications.required, {
        recipient: { userId },
        data: { text: secret },
        idempotencyKey: `locked-${userId}`,
      });
      expect(locked.status).toBe("suppressed");
      expect(locked.deliveries).toEqual([expect.objectContaining({ channel: "none", errorCode: "account_locked" })]);
      expect(await storedPayloads(locked.id)).toEqual([expect.objectContaining({ channel: "none", payload_encrypted: null })]);
      expect(transports.sent).toEqual([]);

      // The deprecated direct email API refuses the same account.
      expect(await notifications.sendToUser({ userId, subject: "Update", content: secret })).toEqual({
        ok: false,
        error: "User account is locked",
      });

      await unlock(userId);
      const unlocked = await notifications.send(app.notifications.required, {
        recipient: { userId },
        data: { text: secret },
        idempotencyKey: `unlocked-${userId}`,
      });
      expect(unlocked.status).toBe("delivered");
      expect(transports.sent.map((entry) => entry.channel).sort()).toEqual(["browser", "email"]);
      expect(JSON.stringify(transports.sent)).toContain(secret);
    } finally {
      transports.restore();
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  testFor("database", "nats")("a notification prepared before the lock does not go out after it", async () => {
    const userId = await createUser();
    const transports = interceptTransports();
    try {
      const sent = await notifications.send(app.notifications.recommended, {
        recipient: { userId },
        data: { text: secret },
        idempotencyKey: `prepared-${userId}`,
      });
      expect(sent.status).toBe("queued");
      const [browser] = await sql<{ id: string; payload_encrypted: string }[]>`
        SELECT id, payload_encrypted FROM notifications.deliveries WHERE event_id = ${sent.id}::uuid AND channel = 'browser'
      `;
      expect(JSON.stringify(await decryptSecret(browser!.payload_encrypted))).toContain(secret);

      await lock(userId);
      expect((await processNotificationDelivery(browser!.id)).status).toBe("suppressed");
      expect(await storedPayloads(sent.id)).toEqual([
        expect.objectContaining({ channel: "browser", status: "suppressed", error_code: "account_locked", payload_encrypted: null }),
        expect.objectContaining({ channel: "email", status: "suppressed", error_code: "account_locked", payload_encrypted: null }),
      ]);
      expect(transports.sent).toEqual([]);
    } finally {
      transports.restore();
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  testFor("database", "nats")("mail that outgoing mail still holds for a retry is cancelled when the account is locked", async () => {
    const userId = await createUser();
    const mailId = crypto.randomUUID();
    await sql`
      INSERT INTO outgoing_mail.messages (
        id, app_id, profile_key, lane, to_addresses, recipient_count, subject, text_body, message_id_header, status, deadline_at
      ) VALUES (
        ${mailId}::uuid, 'core', 'default', 'immediate', ${toPgTextArray([`${userId}@example.test`])}::text[], 1, 'Update',
        ${secret}, ${`<${mailId}@example.test>`}, 'queued', now() + interval '1 hour'
      )
    `;
    const transports = interceptTransports({ status: "pending", retryAfterMs: 60_000, outgoingMailId: mailId });
    try {
      const sent = await notifications.send(app.notifications.email, {
        recipient: { userId },
        data: { text: secret },
        idempotencyKey: `retry-${userId}`,
      });
      const [email] = await sql<{ id: string }[]>`
        SELECT id FROM notifications.deliveries WHERE event_id = ${sent.id}::uuid AND channel = 'email'
      `;
      // Outgoing mail accepted the message before the lock and keeps it for a retry.
      expect((await processNotificationDelivery(email!.id)).status).toBe("pending");
      await sql`UPDATE notifications.deliveries SET next_attempt_at = now() WHERE id = ${email!.id}::uuid`;

      await lock(userId);
      expect((await processNotificationDelivery(email!.id)).status).toBe("suppressed");
      const [mail] = await sql<{ status: string; error_code: string | null }[]>`
        SELECT status, error_code FROM outgoing_mail.messages WHERE id = ${mailId}::uuid
      `;
      expect(mail).toEqual({ status: "cancelled", error_code: "account_locked" });
      expect(transports.sent).toHaveLength(1);
    } finally {
      transports.restore();
      await sql`DELETE FROM outgoing_mail.messages WHERE id = ${mailId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  testFor("database")("a locked account is not a batch recipient, and an account locked after finalization is skipped", async () => {
    const first = await createUser();
    const second = await createUser();
    const enqueue = spyOn(bulk, "enqueueMail").mockImplementation(async (_app, messages) => ({
      batchId: crypto.randomUUID(),
      ids: messages.map(() => crypto.randomUUID()),
    }));
    let batchId: string | undefined;
    try {
      await lock(first);
      const candidates = async () =>
        (await __notificationBatchTest.resolveCandidates({ userIds: [first, second] })).map((candidate) => candidate.id).sort();
      expect(await candidates()).toEqual([second]);
      await unlock(first);
      expect(await candidates()).toEqual([first, second].sort());

      const [batch] = await sql<{ id: string }[]>`
        INSERT INTO notifications.batches (subject, body_markdown, body_html, selection, selection_hash, status, target_count, deliverable_count)
        VALUES ('Update', ${secret}, ${`<p>${secret}</p>`}, ${JSON.stringify({ userIds: [second] })}::text::jsonb, ${second}, 'ready', 1, 1)
        RETURNING id
      `;
      batchId = batch!.id;
      await sql`
        INSERT INTO notifications.batch_recipients (batch_id, user_id, recipient, uid, display_name, provider, profile)
        SELECT ${batchId}::uuid, u.id, u.mail, u.uid, u.display_name, u.provider, u.profile
        FROM auth.users u WHERE u.id = ANY(${toPgUuidArray([second])}::uuid[])
      `;
      await lock(second);
      await __notificationBatchTest.processBatchChunk(batchId);
      expect(enqueue).not.toHaveBeenCalled();
      const [recipient] = await sql<{ status: string; error: string | null }[]>`
        SELECT status, error FROM notifications.batch_recipients WHERE batch_id = ${batchId}::uuid
      `;
      expect(recipient).toEqual({ status: "skipped", error: "The account is locked." });
    } finally {
      enqueue.mockRestore();
      if (batchId) await sql`DELETE FROM notifications.batches WHERE id = ${batchId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray([first, second])}::uuid[])`;
    }
  });
});
