import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { app } from "./config";
import { newShortId } from "./lib/short-id";
import { migrate } from "./migrate";
import { createMailNotificationService } from "./notifications";
import type { MailRequestContext } from "./service/auth";
import { createMailbox } from "./service/mailboxes";
import { setConversationReminder } from "./service/reminders";

const suite = process.env.MAIL_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: user.uid,
      sn: "Test",
      mail: `${user.uid}@example.com`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-notifications-${user.uid}`,
});

suite("Mail collaboration notification deliveries", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId = "";
  let mailboxId = "";
  let conversationId = "";
  let context: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const [user] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-notifications-${suffix}`}, 'local', 'user', 'Mail Notifications', false)
      RETURNING id, uid
    `;
    if (!user) throw new Error("Failed to create Mail notification test user");
    userId = user.id;
    context = contextFor(user);
    const mailbox = await createMailbox(context, { name: `Mail notifications ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Reminder', 'someone@example.com', now(), 'needs_action')
      RETURNING id
    `;
    conversationId = conversation!.id;
  });

  afterAll(async () => {
    const access = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
    `;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (access.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))`;
    }
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("stops retrying a delivery that keeps failing and prunes terminal rows", async () => {
    const service = createMailNotificationService(app.notifications, {
      sender: async () => {
        throw new Error("Notification transport is down");
      },
    });
    const reminder = await setConversationReminder({
      context,
      mailboxId,
      conversationId,
      input: { dueAt: new Date(Date.now() - 1_000).toISOString(), expectedRevision: null },
    });
    expect(reminder.ok).toBe(true);
    if (!reminder.ok) return;

    const deliveryState = async () => {
      const [row] = await sql<{ state: string; attempt: number; last_error: string | null }[]>`
        SELECT state, attempt, last_error
        FROM mail.collaboration_notification_deliveries
        WHERE mailbox_id = ${mailboxId}::uuid
      `;
      return row ?? null;
    };

    for (let round = 0; round < 6; round += 1) {
      await sql`UPDATE mail.collaboration_notification_deliveries SET available_at = now() WHERE mailbox_id = ${mailboxId}::uuid`;
      const summary = await service.recover();
      if (summary.scanned === 0) break;
      expect(summary).toMatchObject({ failed: 1 });
    }

    const terminal = await deliveryState();
    expect(terminal).toMatchObject({ state: "skipped", attempt: 5 });
    expect(terminal?.last_error).toContain("Giving up after 5 attempts");

    // A terminal row must not be picked up again, however often recovery runs.
    await sql`UPDATE mail.collaboration_notification_deliveries SET available_at = now() WHERE mailbox_id = ${mailboxId}::uuid`;
    expect(await service.recover()).toMatchObject({ scanned: 0 });

    await sql`
      UPDATE mail.collaboration_notification_deliveries
      SET created_at = now() - interval '120 days'
      WHERE mailbox_id = ${mailboxId}::uuid
    `;
    await service.recover();
    expect(await deliveryState()).toBeNull();
  });
});
