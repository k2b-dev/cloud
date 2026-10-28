import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { type AuthContext, createAccess } from "@k2b/cloud/server";
import { browserNotifications, notifications, serviceAccountCredentials, toPgUuidArray } from "@k2b/cloud/services";
import { processNotificationDelivery } from "@k2b/cloud/services/notifications/dispatcher";
import type { sendTypedNotification } from "@k2b/cloud/services/notifications/platform";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import chatApi from "../api";
import { messageFixtures, type Person } from "../api/messages.test-fixture";
import { app } from "../config";
import { type PushData, PushDataSchema, renderPush } from "../notifications";
import { badgeCount } from "./badge";
import { alertKey, allowAlert, deliverMessage, notificationLifecycle, notificationOutbox, sendPush } from "./notification-delivery";

const typedNotifications: { send: typeof sendTypedNotification } = notifications;
setDefaultTimeout(30_000);

suiteFor(
  "database",
  "nats",
  "valkey",
)("Chat notification delivery", () => {
  const f = messageFixtures();
  const people: Person[] = [];
  const agentIds: string[] = [];
  const bulkUsers: string[] = [];
  const person = async (name: string) => {
    const p = await f.person(name);
    people.push(p);
    return p;
  };
  let send: ReturnType<typeof spyOn<typeof typedNotifications, "send">> | undefined;
  const sent: { key: string; data: PushData; locale?: string }[] = [];
  const capture = () => {
    send = spyOn(typedNotifications, "send").mockImplementation(async (definition, input) => {
      sent.push({ key: definition.key, data: PushDataSchema.parse(input.data), locale: input.locale });
      return { id: crypto.randomUUID(), created: true, status: "queued", deliveries: [] };
    });
  };
  afterEach(async () => {
    send?.mockRestore();
    send = undefined;
    sent.length = 0;
    for (const p of people) {
      await redis.del(alertKey(p.id));
      await sql`DELETE FROM notifications.events WHERE recipient_user_id = ${p.id}::uuid`;
    }
    await app.settings.remove("chat.push_preview");
    for (const id of agentIds) {
      await sql`DELETE FROM audit.events WHERE actor_uid = ${id} OR target_id = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    agentIds.length = 0;
    if (people.length) {
      await sql`DELETE FROM chat.notification_outbox o USING chat.conversations c WHERE c.id = o.conversation_id
        AND c.created_by_type = 'user' AND c.created_by_id = ANY(${toPgUuidArray(people.map((p) => p.id))}::uuid[])`;
      await sql`DELETE FROM chat.notification_pending WHERE user_id = ANY(${toPgUuidArray(people.map((p) => p.id))}::uuid[])`;
    }
    if (bulkUsers.length) await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(bulkUsers)}::uuid[])`;
    bulkUsers.length = 0;
  });
  const post = async (owner: Person, chat: string, body = "A complete message", rest: Record<string, unknown> = {}) => {
    const response = await f.request(owner.headers, `/${chat}/messages`, "POST", { body, clientId: crypto.randomUUID(), ...rest });
    expect(response.status).toBe(201);
    const data = z.object({ id: z.string(), seq: z.number() }).parse(await response.json());
    const [row] = await sql<{ id: string }[]>`SELECT id FROM chat.messages WHERE short_id = ${data.id}`;
    if (!row) throw new Error("Missing message");
    return { ...data, uuid: row.id };
  };
  const due = async (chat: string) => {
    await sql`UPDATE chat.notification_pending SET due_at = clock_timestamp() - interval '1 second' WHERE conversation_id = ${chat}::uuid`;
  };
  const setup = async () => {
    const author = await person("Nora Weber"),
      recipient = await person("Lea Müller");
    const chat = await f.fixture(author, [{ person: recipient, permission: "write" }]);
    capture();
    return { author, recipient, chat };
  };
  test("final message creates a transactional outbox row; read during the delay skips every device", async () => {
    const { author, recipient, chat } = await setup();
    const message = await post(author, chat.shortId);
    expect(await sql`SELECT 1 FROM chat.notification_outbox WHERE message_id = ${message.uuid}::uuid AND user_id IS NULL`).toHaveLength(1);
    await deliverMessage(message.uuid);
    expect(await sendPush(recipient.id, chat.id)).toBeGreaterThan(0);
    expect((await f.request(recipient.headers, `/${chat.shortId}/read`, "POST", { seq: message.seq, thread: "all" })).status).toBe(200);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(0);
  });
  test("revoked access between fan-out and push suppresses all content", async () => {
    const { author, recipient, chat } = await setup();
    const message = await post(author, chat.shortId);
    await deliverMessage(message.uuid);
    await sql`UPDATE auth.access SET permission = 'none' WHERE id = ${chat.entries.get(recipient.id)!}::uuid`;
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(0);
    expect(await badgeCount(recipient.context)).toBe(0);
  });
  test("coalesces messages once, replaces quietly, and alerts again after a read", async () => {
    const { author, recipient, chat } = await setup();
    await sql`INSERT INTO chat.account_prefs (principal_type, principal_id, locale) VALUES ('user', ${recipient.id}::uuid, 'de-CH')`;
    const first = await post(author, chat.shortId, "First");
    const second = await post(author, chat.shortId, "Second");
    await deliverMessage(first.uuid);
    await deliverMessage(first.uuid);
    await deliverMessage(second.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ chat: chat.shortId, further: 1, alert: true });
    expect(sent[0]!.locale).toBe("de-CH");
    expect(renderPush(sent[0]!.data, { locale: "de-CH" }).preview).toContain("(+1 weitere)");
    const third = await post(author, chat.shortId, "Third");
    await deliverMessage(third.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent.at(-1)!.data.alert).toBe(false);
    await f.request(recipient.headers, `/${chat.shortId}/read`, "POST", { seq: third.seq, thread: "all" });
    await redis.del(alertKey(recipient.id));
    const fourth = await post(author, chat.shortId, "Fourth");
    await deliverMessage(fourth.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent.at(-1)!.data.alert).toBe(true);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(3);
  });
  test("one alert budget spans chats; a mention is exempt and beats the message kind", async () => {
    const { author, recipient, chat } = await setup();
    const other = await f.fixture(author, [{ person: recipient, permission: "write" }]);
    for (const conversation of [chat, other]) {
      const message = await post(author, conversation.shortId);
      await deliverMessage(message.uuid);
      await due(conversation.id);
      await sendPush(recipient.id, conversation.id);
    }
    expect(sent.map((item) => item.data.alert)).toEqual([true, false]);
    const mention = await post(author, other.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    await deliverMessage(mention.uuid);
    await due(other.id);
    await sendPush(recipient.id, other.id);
    expect(sent.at(-1)!.key).toBe("mention");
    expect(sent.at(-1)!.data.alert).toBe(true);
    expect(await allowAlert(recipient.id, true, false)).toBe(false);
  });
  test("none blocks personal and message; expired none returns to the default", async () => {
    const { author, recipient, chat } = await setup();
    await sql`UPDATE chat.participants SET notify = 'none', notify_until = clock_timestamp() + interval '1 hour'
      WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${recipient.id}::uuid`;
    const muted = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    await deliverMessage(muted.uuid);
    expect(await sql`SELECT * FROM chat.notification_pending WHERE conversation_id = ${chat.id}::uuid`).toHaveLength(0);
    await sql`UPDATE chat.participants SET notify_until = clock_timestamp() - interval '1 second'
      WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${recipient.id}::uuid`;
    const expired = await post(author, chat.shortId);
    await deliverMessage(expired.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe("message");
  });
  test("read-only channel members default to all even with a writable discovery grant", async () => {
    const author = await person("Nora Weber"),
      recipient = await person("Lea Müller");
    const chat = await f.fixture(author, [{ person: recipient, permission: "read" }]);
    const access = await createAccess({ principal: { type: "user", userId: recipient.id }, permission: "write" });
    if (!access.ok) throw new Error(access.error.message);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'discoverable', 'user', ${author.id}::uuid)`;
    await sql`UPDATE chat.conversations SET member_count = 21 WHERE id = ${chat.id}::uuid`;
    capture();
    const message = await post(author, chat.shortId);
    await deliverMessage(message.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe("message");
    expect(sent[0]!.data.badge).toBe(1);
  });
  test("preview off removes message text from browser and email presentation", async () => {
    const { author, recipient, chat } = await setup();
    await app.settings.set("chat.push_preview", false);
    const message = await post(author, chat.shortId, "Private design details");
    await deliverMessage(message.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    const rendered = renderPush(sent[0]!.data, { locale: "en" });
    expect(rendered.preview).toBe("New message from Nora Weber");
    expect(JSON.stringify(rendered)).not.toContain("Private design details");
    expect(sent[0]!.data.text).toBe("");
  });
  test("added notifies another member on creation; the creator is excluded", async () => {
    const author = await person("Nora Weber"),
      recipient = await person("Lea Müller");
    capture();
    const chat = await f.create(author, [recipient]);
    const [message] = await sql<
      { id: string }[]
    >`SELECT id FROM chat.messages WHERE conversation_id = ${chat.id}::uuid AND system_code = 'conversation_created'`;
    await deliverMessage(message!.id);
    await due(chat.id);
    await sendPush(recipient.id, chat.id, message!.id);
    expect(sent.map((entry) => entry.key)).toEqual(["added"]);
  });
  test("self-joining a channel does not create an added notification", async () => {
    const author = await person("Nora Weber"),
      recipient = await person("Lea Müller");
    const chat = await f.fixture(author);
    const access = await createAccess({ principal: { type: "user", userId: recipient.id }, permission: "read" });
    if (!access.ok) throw new Error(access.error.message);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'discoverable', 'user', ${author.id}::uuid)`;
    expect((await f.request(recipient.headers, `/${chat.shortId}/join`, "POST")).status).toBe(200);
    expect(await sql`SELECT 1 FROM chat.notification_outbox WHERE conversation_id = ${chat.id}::uuid`).toHaveLength(0);
  });
  test("membership additions capture only new people even when a group overlaps", async () => {
    const { author, recipient, chat } = await setup();
    const newcomer = await person("Mika Schmidt");
    const groupId = await f.group([recipient, newcomer]);
    const response = await f.request(author.headers, `/${chat.shortId}/members`, "POST", {
      members: [{ type: "group", groupId }],
    });
    expect(response.status).toBe(200);
    const [message] = await sql<{ id: string; notification_added_users: string[] }[]>`
      SELECT id, to_jsonb(notification_added_users) AS notification_added_users FROM chat.messages WHERE conversation_id = ${chat.id}::uuid AND system_code = 'groups_added'`;
    expect(message!.notification_added_users).toEqual([newcomer.id]);
    await deliverMessage(message!.id);
    await sendPush(newcomer.id, chat.id, message!.id);
    await sendPush(recipient.id, chat.id, message!.id);
    expect(sent.map((entry) => entry.key)).toEqual(["added"]);
  });
  test("muting after fan-out prevents a push and interactive reads retain the recipient locale", async () => {
    const { author, recipient, chat } = await setup();
    const message = await post(author, chat.shortId);
    await deliverMessage(message.uuid);
    await sql`UPDATE chat.participants SET notify = 'none' WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${recipient.id}::uuid`;
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(0);
    const response = await f.request({ ...recipient.headers, "accept-language": "de" }, `/${chat.shortId}/read`, "POST", {
      seq: message.seq,
      thread: "all",
    });
    expect(response.status).toBe(200);
    const [prefs] = await sql<
      { locale: string }[]
    >`SELECT locale FROM chat.account_prefs WHERE principal_type = 'user' AND principal_id = ${recipient.id}::uuid`;
    expect(prefs!.locale).toBe("de");
  });
  test("badge route and push share all-chat plus For you count; own messages do not count", async () => {
    const { author, recipient, chat } = await setup();
    const message = await post(author, chat.shortId);
    await deliverMessage(message.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent[0]!.data.badge).toBe(1);
    expect(await badgeCount(author.context)).toBe(0);
    const response = await new Hono<AuthContext>()
      .route("/api/chat", chatApi)
      .request("https://cloud.example.test/api/chat/badge", { headers: recipient.headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 1 });
  });
  test("quoted authors receive personal notifications at mentions level", async () => {
    const { author, recipient, chat } = await setup();
    const original = await post(recipient, chat.shortId, "Question");
    await sql`UPDATE chat.participants SET notify = 'mentions' WHERE principal_id = ${recipient.id}::uuid AND conversation_id = ${chat.id}::uuid`;
    const reply = await post(author, chat.shortId, "Answer", { replyTo: original.id });
    await deliverMessage(reply.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent[0]!.key).toBe("mention");
    expect(sent[0]!.data.reason).toBe("reply");
    expect(renderPush(sent[0]!.data, { locale: "de" }).title).toBe("Nora Weber hat dir geantwortet");
  });
  test("thread pushes keep the conversation group and use the existing thread deep link", async () => {
    const { author, recipient, chat } = await setup();
    const shortId = testShortId();
    const [thread] = await sql<{ id: string }[]>`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id)
      VALUES (${shortId}, ${chat.id}::uuid, 'Plans', 'user', ${author.id}::uuid) RETURNING id`;
    const message = await post(author, chat.shortId, "Thread update", { thread: shortId });
    const [row] = await sql<{ thread_id: string }[]>`SELECT thread_id FROM chat.messages WHERE id = ${message.uuid}::uuid`;
    expect(row!.thread_id).toBe(thread!.id);
    await deliverMessage(message.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent[0]!.data).toMatchObject({ chat: chat.shortId, href: `/app/chat/c/${chat.shortId}/t/${shortId}/m/${message.id}` });
  });
  test("agent final messages notify once; this API rejects an unsupported in-progress state", async () => {
    const { author, recipient, chat } = await setup();
    const [agent] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('Planning assistant', 'agent') RETURNING id`;
    agentIds.push(agent!.id);
    const access = await createAccess({ principal: { type: "service_account", serviceAccountId: agent!.id }, permission: "write" });
    if (!access.ok) throw new Error(access.error.message);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${author.id}::uuid)`;
    const credential = await serviceAccountCredentials.createApiToken({
      serviceAccountId: agent!.id,
      name: "chat fixture",
      scopes: ["openid", "read", "write"],
    });
    if (!credential.ok) throw new Error(credential.error.message);
    const headers = { authorization: `Bearer ${credential.data.token}` };
    const clientId = "agent-final";
    expect((await f.request(headers, `/${chat.shortId}/messages`, "POST", { clientId, body: "Draft", inProgress: true })).status).toBe(400);
    expect(await sql`SELECT * FROM chat.notification_pending WHERE conversation_id = ${chat.id}::uuid`).toHaveLength(0);
    const response = await f.request(headers, `/${chat.shortId}/messages`, "POST", { clientId, body: "Final plan" });
    expect(response.status).toBe(201);
    const final = z.object({ id: z.string() }).parse(await response.json());
    const [message] = await sql<{ id: string }[]>`SELECT id FROM chat.messages WHERE short_id = ${final.id}`;
    expect((await f.request(headers, `/${chat.shortId}/messages`, "POST", { clientId, body: "Final plan" })).status).toBe(200);
    await deliverMessage(message!.id);
    await deliverMessage(message!.id);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data.agent).toBe(true);
    expect(renderPush(sent[0]!.data, { locale: "en" }).preview).toContain("Planning assistant (Agent)");
  });
  test("system follows and stale Chat membership cannot authorize background delivery", async () => {
    const { author, recipient, chat } = await setup();
    const message = await post(author, chat.shortId);
    const thread = testShortId();
    const [item] = await sql<
      { id: string }[]
    >`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id)
      VALUES (${thread}, ${chat.id}::uuid, 'Task', 'user', ${author.id}::uuid, 'spaces.item', ${testShortId()}) RETURNING id`;
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = 'spaces.space', resource_id = ${testShortId()} WHERE id = ${chat.id}::uuid`;
    await sql`UPDATE chat.messages SET thread_id = ${item!.id}::uuid WHERE id = ${message.uuid}::uuid`;
    await sql`INSERT INTO chat.thread_follows (principal_type, principal_id, conversation_id, thread_id)
      VALUES ('user', ${recipient.id}::uuid, ${chat.id}::uuid, ${item!.id}::uuid)`;
    await deliverMessage(message.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(0);
  });
  test("platform dispatcher applies DND without catch-up", async () => {
    const { author, recipient, chat } = await setup();
    send?.mockRestore();
    send = undefined;
    const subscription = {
      endpoint: `https://push.example.test/chat/${recipient.id}`,
      expirationTime: null,
      keys: { p256dh: "p".repeat(65), auth: "a".repeat(24) },
    };
    await browserNotifications.registerEndpoint({ userId: recipient.id, subscription, label: "Chat fixture" });
    const quiet = await notifications.user.quiet.update({
      userId: recipient.id,
      update: { doNotDisturbUntil: new Date(Date.now() + 60_000).toISOString() },
      fallbackTimeZone: "UTC",
    });
    expect(quiet.ok).toBe(true);
    const message = await post(author, chat.shortId);
    await deliverMessage(message.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    const [delivery] = await sql<
      { id: string }[]
    >`SELECT d.id FROM notifications.deliveries d JOIN notifications.events e ON e.id = d.event_id
      WHERE e.recipient_user_id = ${recipient.id}::uuid AND e.definition_id = 'chat.message' AND d.channel = 'browser'`;
    expect(delivery).toBeDefined();
    expect((await processNotificationDelivery(delivery!.id)).status).toBe("suppressed");
    await notifications.user.quiet.update({ userId: recipient.id, update: { doNotDisturbUntil: null }, fallbackTimeZone: "UTC" });
    await sendPush(recipient.id, chat.id);
    const [state] = await sql<
      { status: string; error_code: string }[]
    >`SELECT status, error_code FROM notifications.deliveries WHERE id = ${delivery!.id}::uuid`;
    expect(state).toEqual({ status: "suppressed", error_code: "do_not_disturb" });
    await browserNotifications.disableEndpoint({ userId: recipient.id, subscription });
  });
  test("fan-out advances in 500-recipient pages without counting a replay twice", async () => {
    const { author, chat } = await setup();
    const extra = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      SELECT 'chat-batch-' || gen_random_uuid()::text, 'local', 'user', 'Batch reader' FROM generate_series(1, 500) RETURNING id`;
    bulkUsers.push(...extra.map((row) => row.id));
    const entries = await sql<{ id: string; user_id: string }[]>`INSERT INTO auth.access (user_id, permission)
      SELECT id, 'read' FROM auth.users WHERE id = ANY(${toPgUuidArray(bulkUsers)}::uuid[]) RETURNING id, user_id`;
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      SELECT ${chat.id}::uuid, id, 'member', 'user', ${author.id}::uuid FROM auth.access WHERE id = ANY(${toPgUuidArray(entries.map((entry) => entry.id))}::uuid[])`;
    await sql`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq, notify)
      SELECT 'user', id, ${chat.id}::uuid, 'direct', 0, 'all' FROM auth.users WHERE id = ANY(${toPgUuidArray(bulkUsers)}::uuid[])`;
    await sql`UPDATE chat.conversations SET member_count = 502 WHERE id = ${chat.id}::uuid`;
    // Keep the existing recipient explicit as well; a default writer at this size has mentions only.
    await sql`UPDATE chat.participants SET notify = 'all' WHERE conversation_id = ${chat.id}::uuid`;
    const message = await post(author, chat.shortId);
    expect(await deliverMessage(message.uuid)).toBe(true);
    const count = async () =>
      (
        await sql<{ count: number; total: number }[]>`SELECT count(*)::int AS count, sum(message_count)::int AS total
      FROM chat.notification_pending WHERE conversation_id = ${chat.id}::uuid`
      )[0];
    expect(await count()).toEqual({ count: 500, total: 500 });
    expect(await deliverMessage(message.uuid)).toBe(false);
    expect(await count()).toEqual({ count: 501, total: 501 });
    expect(await deliverMessage(message.uuid)).toBe(false);
    expect(await count()).toEqual({ count: 501, total: 501 });
  });
  test("outbox and real Sync workers deliver one delayed push and drain cleanly", async () => {
    const { author, chat } = await setup();
    try {
      await notificationLifecycle.start();
      await post(author, chat.shortId);
      await notificationOutbox.reconcile();
      const deadline = Date.now() + 10_000;
      while (!sent.length && Date.now() < deadline) await Bun.sleep(50);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.data.chat).toBe(chat.shortId);
      expect(sent[0]!.key).toBe("message");
    } finally {
      await notificationLifecycle.stop();
    }
  });
  test("notification kinds expose browser recommendations and the email exclusion reason", () => {
    expect(app.notifications.message.delivery).toEqual({ recommended: ["browser"], required: [], excluded: ["email"] });
    expect(app.notifications.message.presentation?.translations.de?.excludedReason).toBe(
      "Nicht verfügbar: Jede Nachricht als E-Mail wäre zu viel.",
    );
    expect(app.notifications.mention.delivery?.recommended).toEqual(["browser"]);
    expect(app.notifications.added.delivery?.recommended).toEqual(["browser"]);
  });
});
