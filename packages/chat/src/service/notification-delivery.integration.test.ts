import { afterEach, expect, setDefaultTimeout, setSystemTime, spyOn, test } from "bun:test";
import { env } from "@k2b/cloud/config";
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
import { conversations } from "./conversations";
import { forYou, forYouUnread } from "./for-you";
import { alertKey, allowAlert, deliverMessage, notificationLifecycle, notificationOutbox, sendPush } from "./notification-delivery";
import { resourceReaderDependencies } from "./resource-access";
import {
  INTERACTIVE_READER_APP_LIMIT,
  INTERACTIVE_READER_PERSON_LIMIT,
  readableSystemRecipients,
  systemNotificationDependencies,
  systemNotificationHealth,
} from "./system-notification-access";

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
  let reader: ReturnType<typeof spyOn<typeof systemNotificationDependencies, "invoke">> | undefined;
  const credentialDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_CREDENTIAL");
  const configureSystem = () => Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", { value: "fixture-workload", configurable: true });
  const sent: { key: string; data: PushData; locale?: string }[] = [];
  const capture = () => {
    send = spyOn(typedNotifications, "send").mockImplementation(async (definition, input) => {
      sent.push({ key: definition.key, data: PushDataSchema.parse(input.data), locale: input.locale });
      return { id: crypto.randomUUID(), created: true, status: "queued", deliveries: [] };
    });
  };
  afterEach(async () => {
    setSystemTime();
    await redis.del("chat:system-reader:health:spaces", "chat:system-reader:health:notebooks");
    reader?.mockRestore();
    reader = undefined;
    if (credentialDescriptor) Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", credentialDescriptor);
    else Reflect.deleteProperty(env, "CLOUD_APP_CREDENTIAL");
    send?.mockRestore();
    send = undefined;
    sent.length = 0;
    for (const p of people) {
      await redis.del(alertKey(p.id));
      const keys = await redis.keys(`chat:system-reader:v1:${p.id}:*`);
      if (keys.length) await redis.del(...keys);
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
  test("out-of-order fan-out keeps the newest personal reason and its mention alert exemption", async () => {
    const { author, recipient, chat } = await setup();
    const original = await post(recipient, chat.shortId, "Question");
    const reply = await post(author, chat.shortId, "Answer", { replyTo: original.id });
    const mention = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    await deliverMessage(mention.uuid);
    await deliverMessage(reply.uuid);
    await due(chat.id);
    expect(await allowAlert(recipient.id, true, false)).toBe(true);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ reason: "mention", text: "Hello Lea", further: 1, alert: true });
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
    expect(await sendPush(recipient.id, chat.id, message!.id)).toBeGreaterThan(0);
    await sql`UPDATE chat.messages SET created_at = clock_timestamp() - interval '4 seconds' WHERE id = ${message!.id}::uuid`;
    await sendPush(recipient.id, chat.id, message!.id);
    expect(sent.map((entry) => entry.key)).toEqual(["added"]);
  });
  test("reading an addition during its delay also suppresses the added push", async () => {
    const author = await person("Nora Weber"),
      recipient = await person("Lea Müller");
    capture();
    const chat = await f.create(author, [recipient]);
    const [message] = await sql<{ id: string; seq: string }[]>`SELECT id, seq FROM chat.messages
      WHERE conversation_id = ${chat.id}::uuid AND system_code = 'conversation_created'`;
    await deliverMessage(message!.id);
    expect((await f.request(recipient.headers, `/${chat.shortId}/read`, "POST", { seq: Number(message!.seq), thread: "all" })).status).toBe(
      200,
    );
    await sql`UPDATE chat.messages SET created_at = clock_timestamp() - interval '4 seconds' WHERE id = ${message!.id}::uuid`;
    await sendPush(recipient.id, chat.id, message!.id);
    expect(sent).toHaveLength(0);
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
    await sql`UPDATE chat.messages SET created_at = clock_timestamp() - interval '4 seconds' WHERE id = ${message!.id}::uuid`;
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
    expect(
      await sql`SELECT 1 FROM chat.notification_pending WHERE user_id = ${recipient.id}::uuid AND conversation_id = ${chat.id}::uuid`,
    ).toHaveLength(0);
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
    Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", { value: undefined, configurable: true });
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
  const asSystem = async (chatId: string, authorId: string, messageIds: string[], recipientId: string) => {
    const [thread] = await sql<
      { id: string }[]
    >`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id)
      VALUES (${testShortId()}, ${chatId}::uuid, 'Task', 'user', ${authorId}::uuid, 'spaces.item', ${testShortId()}) RETURNING id`;
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = 'spaces.space', resource_id = ${testShortId()} WHERE id = ${chatId}::uuid`;
    await sql`UPDATE chat.messages SET thread_id = ${thread!.id}::uuid WHERE id = ANY(${toPgUuidArray(messageIds)}::uuid[])`;
    await sql`INSERT INTO chat.thread_follows (principal_type, principal_id, conversation_id, thread_id)
      VALUES ('user', ${recipientId}::uuid, ${chatId}::uuid, ${thread!.id}::uuid)`;
    return thread!.id;
  };
  test("system followers receive F3 pushes; Chat filters candidates before the owner query", async () => {
    const { author, recipient, chat } = await setup();
    const outsider = await person("Outside reader");
    const message = await post(author, chat.shortId);
    const threadId = await asSystem(chat.id, author.id, [message.uuid], recipient.id);
    // A follow selects the personal notification reason; it never authorizes content itself.
    configureSystem();
    reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (appId, capabilityId, input, caller) => {
      expect(appId).toBe("spaces");
      expect(capabilityId).toBe("item.readable");
      expect(input.userIds).not.toContain(outsider.id);
      expect(caller.workload).toEqual({ appId: "chat" });
      return { ok: true, data: { data: { readable: input.userIds } } };
    });
    expect(await readableSystemRecipients(chat.id, threadId, [recipient.id, outsider.id])).toEqual(new Set([recipient.id]));
    await deliverMessage(message.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data.reason).toBe("follow");
  });
  test("readable system mentions count in the badge and push; a fresh revocation suppresses the next push", async () => {
    const { author, recipient, chat } = await setup();
    const first = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    const second = await post(author, chat.shortId, "Hello Lea again", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    await asSystem(chat.id, author.id, [first.uuid, second.uuid], recipient.id);
    configureSystem();
    let readable = true;
    reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => ({
      ok: true,
      data: { data: { readable: readable ? input.userIds : [] } },
    }));
    expect(await badgeCount(recipient.context)).toBe(2);
    expect(reader.mock.calls).toHaveLength(1); // Two messages on one element share one owner decision.
    await deliverMessage(first.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe("mention");
    await deliverMessage(second.uuid);
    readable = false;
    // Interactive counts may retain a decision for at most 60 seconds; final sends never use it.
    expect(await badgeCount(recipient.context)).toBe(2);
    for (const key of await redis.keys(`chat:system-reader:v1:${recipient.id}:*`)) {
      expect(await redis.ttl(key)).toBeLessThanOrEqual(60);
      await redis.send("PEXPIRE", [key, "0"]);
    }
    expect(await badgeCount(recipient.context)).toBe(0);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
  });
  for (const revoked of ["chosen", "latest"] as const) {
    test(`system coalescing rechecks the ${revoked} element before exposing an older personal message`, async () => {
      const { author, recipient, chat } = await setup();
      const mention = await post(author, chat.shortId, "Hello Lea", {
        mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
      });
      const latest = await post(author, chat.shortId, "Newer ordinary message");
      const chosenThread = await asSystem(chat.id, author.id, [mention.uuid], recipient.id);
      const [chosen] = await sql<{ resource_id: string }[]>`SELECT resource_id FROM chat.threads WHERE id = ${chosenThread}::uuid`;
      const latestElement = testShortId();
      const [thread] = await sql<
        { id: string }[]
      >`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id)
        VALUES (${testShortId()}, ${chat.id}::uuid, 'Other item', 'user', ${author.id}::uuid, 'spaces.item', ${latestElement}) RETURNING id`;
      await sql`UPDATE chat.messages SET thread_id = ${thread!.id}::uuid WHERE id = ${latest.uuid}::uuid`;
      await sql`UPDATE chat.participants SET notify = 'all' WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${recipient.id}::uuid`;
      configureSystem();
      let revokedElement: string | undefined;
      reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => ({
        ok: true,
        data: { data: { readable: input.id === revokedElement ? [] : input.userIds } },
      }));
      await deliverMessage(mention.uuid);
      await deliverMessage(latest.uuid);
      const [pending] = await sql<
        { message_id: string; personal_message_id: string }[]
      >`SELECT message_id, personal_message_id FROM chat.notification_pending WHERE conversation_id = ${chat.id}::uuid AND user_id = ${recipient.id}::uuid`;
      expect(pending).toMatchObject({ message_id: latest.uuid, personal_message_id: mention.uuid });
      revokedElement = revoked === "chosen" ? chosen!.resource_id : latestElement;
      await due(chat.id);
      await sendPush(recipient.id, chat.id);
      expect(sent).toHaveLength(0);
    });
  }
  test("system bundles expose no aggregate count from an earlier revoked element", async () => {
    const { author, recipient, chat } = await setup();
    const earlier = await post(author, chat.shortId, "Earlier private discussion");
    const chosen = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    const latest = await post(author, chat.shortId, "Latest readable discussion");
    const earlierThread = await asSystem(chat.id, author.id, [earlier.uuid], recipient.id);
    await asSystem(chat.id, author.id, [chosen.uuid, latest.uuid], recipient.id);
    const [earlierResource] = await sql<{ resource_id: string }[]>`SELECT resource_id FROM chat.threads WHERE id = ${earlierThread}::uuid`;
    configureSystem();
    let revokedElement: string | undefined;
    reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => ({
      ok: true,
      data: { data: { readable: input.id === revokedElement ? [] : input.userIds } },
    }));
    await deliverMessage(earlier.uuid);
    await deliverMessage(chosen.uuid);
    await deliverMessage(latest.uuid);
    revokedElement = earlierResource!.resource_id;
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ text: "Latest readable discussion", further: 0 });
  });
  test("system replies push when readable, and missing configuration is visible and closed", async () => {
    const { author, recipient, chat } = await setup();
    const original = await post(recipient, chat.shortId, "Question");
    const reply = await post(author, chat.shortId, "Answer", { replyTo: original.id });
    const threadId = await asSystem(chat.id, author.id, [original.uuid, reply.uuid], recipient.id);
    configureSystem();
    reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => ({
      ok: true,
      data: { data: { readable: input.userIds } },
    }));
    await deliverMessage(reply.uuid);
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data.reason).toBe("reply");
    Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", { value: undefined, configurable: true });
    const calls = reader.mock.calls.length;
    expect((await systemNotificationHealth()).status).toBe("unavailable");
    expect(await readableSystemRecipients(chat.id, threadId, [recipient.id])).toEqual(new Set());
    expect(reader.mock.calls).toHaveLength(calls);
  });
  test("system reader input binds delivery, counts and final sends to the conversation container", async () => {
    const { author, recipient, chat } = await setup();
    const first = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    const second = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    const threadId = await asSystem(chat.id, author.id, [first.uuid, second.uuid], recipient.id);
    const [conversation] = await sql<{ resource_id: string }[]>`SELECT resource_id FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    const original = conversation!.resource_id;
    let currentContainer = original;
    configureSystem();
    reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => {
      expect(input.container).toEqual({ type: "spaces.space", id: original });
      return { ok: true, data: { data: { readable: input.container.id === currentContainer ? input.userIds : [] } } };
    });
    await deliverMessage(first.uuid);
    currentContainer = testShortId();
    await deliverMessage(second.uuid);
    expect(await forYouUnread(recipient.context)).toBe(0);
    expect(await conversations.list(recipient.context)).toMatchObject({ ok: true, data: { forYouUnread: 0 } });
    await due(chat.id);
    await sendPush(recipient.id, chat.id);
    expect(sent).toHaveLength(0);
    expect(await readableSystemRecipients(chat.id, threadId, [recipient.id])).toEqual(new Set());
  });
  for (const status of [401, 429, 503, 500] as const) {
    test(`reader failure ${status} leaves counts usable, records health, and retries delivery`, async () => {
      const { author, recipient, chat } = await setup();
      const message = await post(author, chat.shortId, "Hello Lea", {
        mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
      });
      const threadId = await asSystem(chat.id, author.id, [message.uuid], recipient.id);
      configureSystem();
      reader = spyOn(systemNotificationDependencies, "invoke").mockResolvedValue({
        ok: false,
        error: { code: "APP_UNAVAILABLE", message: "fixture", status },
      });
      expect(await badgeCount(recipient.context)).toBe(0);
      expect(await forYouUnread(recipient.context)).toBe(0);
      expect(await conversations.list(recipient.context)).toMatchObject({ ok: true, data: { forYouUnread: 0 } });
      expect(await systemNotificationHealth()).toMatchObject({ status: "failing", reason: `spaces: APP_UNAVAILABLE (${status})` });
      expect((await systemNotificationHealth()).checkedAt).not.toBeNull();
      await expect(deliverMessage(message.uuid)).rejects.toThrow("reader check unavailable");
      expect(await sql`SELECT 1 FROM chat.messages WHERE id = ${message.uuid}::uuid AND notification_done`).toHaveLength(0);
      reader.mockImplementation(async (_app, _query, input) => ({ ok: true, data: { data: { readable: input.userIds } } }));
      expect(await readableSystemRecipients(chat.id, threadId, [recipient.id])).toEqual(new Set([recipient.id]));
      expect((await systemNotificationHealth()).status).toBe("ok");
    });
  }
  test("interactive misses are bounded per person while another person's delivery remains fresh", async () => {
    const { author, recipient, chat } = await setup();
    const other = await person("Another recipient");
    const message = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    const threadId = await asSystem(chat.id, author.id, [message.uuid], recipient.id);
    await sql`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
      VALUES ('user', ${other.id}::uuid, ${chat.id}::uuid, 'ondemand', 0)`;
    await sql`INSERT INTO chat.thread_follows (principal_type, principal_id, conversation_id, thread_id)
      VALUES ('user', ${other.id}::uuid, ${chat.id}::uuid, ${threadId}::uuid)`;
    const extraThreads = Array.from({ length: INTERACTIVE_READER_PERSON_LIMIT }, () => ({
      id: crypto.randomUUID(),
      short_id: testShortId(),
      conversation_id: chat.id,
      name: "Another element",
      created_by_type: "user",
      created_by_id: author.id,
      resource_type: "spaces.item",
      resource_id: testShortId(),
    }));
    await sql`INSERT INTO chat.threads ${sql(extraThreads)}`;
    const extraMessages = extraThreads.map((thread, index) => ({
      id: crypto.randomUUID(),
      short_id: testShortId(10),
      conversation_id: chat.id,
      seq: message.seq + index + 1,
      rev: message.seq + index + 1,
      kind: "text",
      author_type: "user",
      author_id: author.id,
      author_name: "Nora",
      client_id: `flood-${index}`,
      body_md: "Hello Lea",
      thread_id: thread.id,
    }));
    await sql`INSERT INTO chat.messages ${sql(extraMessages)}`;
    await sql`INSERT INTO chat.message_mentions (message_id, principal_type, principal_id, start_offset, end_offset, created_at)
      SELECT id, 'user', ${recipient.id}::uuid, 6, 9, created_at FROM chat.messages
      WHERE id = ANY(${toPgUuidArray(extraMessages.map((row) => row.id))}::uuid[])`;
    configureSystem();
    reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => ({
      ok: true,
      data: { data: { readable: input.userIds.filter((id) => id === other.id) } },
    }));
    const instant = new Date("2026-10-29T02:00:00Z");
    setSystemTime(instant);
    const window = Math.floor(instant.getTime() / 60_000);
    const rateKeys = [window - 1, window].flatMap((part) => [
      `cloud:ratelimit:chat:reader-person:${recipient.id}:${part}`,
      `cloud:ratelimit:chat:reader-interactive:chat:${part}`,
    ]);
    try {
      for (let request = 0; request < 12; request++) expect(await badgeCount(recipient.context)).toBe(0);
      expect(reader.mock.calls).toHaveLength(INTERACTIVE_READER_PERSON_LIMIT);
      const interactive = await redis.get(rateKeys[3]!);
      // Only admitted person checks spend the shared interactive budget; denied traffic never reaches Core.
      expect(Number(interactive ?? 0)).toBeLessThanOrEqual(INTERACTIVE_READER_PERSON_LIMIT);
      await deliverMessage(message.uuid);
      await due(chat.id);
      await sendPush(other.id, chat.id);
      expect(sent).toHaveLength(1);
      expect(reader.mock.calls.slice(INTERACTIVE_READER_PERSON_LIMIT).some((call) => call[2].userIds.includes(other.id))).toBe(true);
    } finally {
      await redis.del(...rateKeys);
    }
  });
  for (const scope of ["person", "app", "replaced"] as const) {
    test(`interactive ${scope} admission rejection releases only its own reservation`, async () => {
      const { author, recipient, chat } = await setup();
      const message = await post(author, chat.shortId);
      const threadId = await asSystem(chat.id, author.id, [message.uuid], recipient.id);
      const [ref] = await sql<{ container_id: string; resource_id: string }[]>`
        SELECT c.resource_id AS container_id, t.resource_id FROM chat.conversations c
        JOIN chat.threads t ON t.conversation_id = c.id WHERE t.id = ${threadId}::uuid`;
      const key = `chat:system-reader:v1:${recipient.id}:spaces.space:${ref!.container_id}:spaces.item:${ref!.resource_id}`;
      configureSystem();
      reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => ({
        ok: true,
        data: { data: { readable: input.userIds } },
      }));
      const instant = new Date("2026-10-29T03:00:00Z");
      setSystemTime(instant);
      const window = Math.floor(instant.getTime() / 60_000);
      const personKey = `cloud:ratelimit:chat:reader-person:${recipient.id}:${window}`;
      const appKey = `cloud:ratelimit:chat:reader-interactive:chat:${window}`;
      const keys = [personKey, appKey, `cloud:ratelimit:chat:reader-interactive:chat:${window - 1}`];
      const replacement = crypto.randomUUID();
      const originalSend = redis.send.bind(redis);
      // Replace the reservation between admission and cleanup to exercise compare-and-delete.
      const intercept =
        scope === "replaced"
          ? spyOn(redis, "send").mockImplementation(async (command, args) => {
              if (command === "EVAL" && args.includes(personKey)) await redis.set(key, replacement, "EX", 60);
              return originalSend(command, args);
            })
          : undefined;
      try {
        await redis.del(...keys);
        await redis.set(
          scope === "app" ? appKey : personKey,
          String(scope === "app" ? INTERACTIVE_READER_APP_LIMIT : INTERACTIVE_READER_PERSON_LIMIT),
          "EX",
          120,
        );
        expect(await readableSystemRecipients(chat.id, threadId, [recipient.id], sql, "interactive")).toEqual(new Set());
        expect(reader.mock.calls).toHaveLength(0);
        expect(await redis.get(key)).toBe(scope === "replaced" ? replacement : null);
        intercept?.mockRestore();
        await redis.del(...keys);
        if (scope !== "replaced") {
          expect(await readableSystemRecipients(chat.id, threadId, [recipient.id], sql, "interactive")).toEqual(new Set([recipient.id]));
          expect(reader.mock.calls).toHaveLength(1);
          expect(await redis.get(key)).toBe("1");
        }
      } finally {
        intercept?.mockRestore();
        await redis.del(...keys);
      }
    });
  }
  for (const delay of ["timeout", "expired"] as const) {
    test(`delayed push lock ${delay} restarts owner preparation before enqueue`, async () => {
      const { author, recipient, chat } = await setup();
      const message = await post(author, chat.shortId);
      await asSystem(chat.id, author.id, [message.uuid], recipient.id);
      configureSystem();
      reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => ({
        ok: true,
        data: { data: { readable: input.userIds } },
      }));
      await deliverMessage(message.uuid);
      await due(chat.id);
      // Warm only the badge cache so each send's final owner check is observable separately.
      await badgeCount(recipient.context);
      await sql`INSERT INTO chat.notification_push_state (user_id, conversation_id)
        VALUES (${recipient.id}::uuid, ${chat.id}::uuid) ON CONFLICT DO NOTHING`;
      const release = Promise.withResolvers<void>();
      const locked = Promise.withResolvers<number>();
      const blocker = sql.begin(async (tx) => {
        await tx`SELECT 1 FROM chat.notification_push_state WHERE user_id = ${recipient.id}::uuid
          AND conversation_id = ${chat.id}::uuid FOR UPDATE`;
        const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        locked.resolve(row!.pid);
        await release.promise;
      });
      // A broken timeout must still fail and release the fixture lock before the test ends.
      const safetyRelease = setTimeout(() => release.resolve(), 2_000);
      let attempt: Promise<number | null> | undefined;
      let monotonicNow = 0;
      const clock = spyOn(performance, "now").mockImplementation(() => monotonicNow);
      try {
        const blockerPid = await locked.promise;
        reader.mockClear();
        attempt = sendPush(recipient.id, chat.id);
        // Wait for the actual row lock, never infer ordering from an arbitrary sleep.
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          const [row] = await sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))) AS waiting`;
          waiting = row!.waiting;
          if (!waiting) await Bun.sleep(5);
        }
        expect(waiting).toBe(true);
        expect(reader.mock.calls).toHaveLength(1);
        if (delay === "expired") {
          monotonicNow = 3_000;
          release.resolve();
          await blocker;
        }
        expect(await attempt).toBe(0);
        expect(sent).toHaveLength(0);
        expect(
          await sql`SELECT 1 FROM chat.notification_pending WHERE user_id = ${recipient.id}::uuid
          AND conversation_id = ${chat.id}::uuid`,
        ).toHaveLength(1);
        release.resolve();
        await blocker;
        reader.mockImplementation(async () => ({ ok: true, data: { data: { readable: [] } } }));
        expect(await sendPush(recipient.id, chat.id)).toBeNull();
        expect(reader.mock.calls).toHaveLength(2);
        expect(sent).toHaveLength(0);
      } finally {
        clearTimeout(safetyRelease);
        release.resolve();
        try {
          await blocker;
          await attempt;
        } finally {
          clock.mockRestore();
        }
      }
    });
  }
  test("For you listing asks interactive owners without holding a read transaction", async () => {
    const { author, recipient, chat } = await setup();
    const message = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    await asSystem(chat.id, author.id, [message.uuid], recipient.id);
    const [conversation] = await sql<{ resource_id: string }[]>`SELECT resource_id FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    const interactive = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (_app, query, input) => {
      const [held] = await sql<{ held: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'
          AND query ~ 'chat\.(messages|threads|conversations)') AS held`;
      expect(held!.held).toBe(false);
      return {
        data:
          query === "space.read"
            ? { id: input.id, name: "Original space", permission: "read" }
            : { id: input.id, title: "Original item", kind: "task", spaceId: conversation!.resource_id },
        links: [{ rel: "open", href: "/app/spaces" }],
      };
    });
    try {
      const page = await forYou.list(recipient.context);
      expect(page).toMatchObject({ ok: true, data: { items: [{ message: { preview: "Hello Lea" } }] } });
      expect(interactive.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      interactive.mockRestore();
    }
  });
  test("owner checks release transactions and row locks, and local changes invalidate prepared sends", async () => {
    const { author, recipient, chat } = await setup();
    const message = await post(author, chat.shortId, "Hello Lea", {
      mentions: [{ principal: { type: "user", id: recipient.id }, start: 6, end: 9 }],
    });
    await asSystem(chat.id, author.id, [message.uuid], recipient.id);
    configureSystem();
    let mute = false;
    reader = spyOn(systemNotificationDependencies, "invoke").mockImplementation(async (_app, _query, input) => {
      const [held] = await sql<{ held: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'
          AND query ~ 'chat\.(messages|threads|conversations|notification_push_state)') AS held`;
      expect(held!.held).toBe(false);
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM chat.messages WHERE id = ${message.uuid}::uuid FOR UPDATE NOWAIT`;
        await tx`SELECT user_id FROM chat.notification_push_state WHERE user_id = ${recipient.id}::uuid AND conversation_id = ${chat.id}::uuid FOR UPDATE NOWAIT`;
      });
      if (mute)
        await sql`UPDATE chat.participants SET notify = 'none' WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${recipient.id}::uuid`;
      return { ok: true, data: { data: { readable: input.userIds } } };
    });
    expect(await conversations.list(recipient.context)).toMatchObject({ data: { forYouUnread: 1 } });
    const calls = reader.mock.calls.length;
    expect(await sql.begin((db) => forYouUnread(recipient.context, db))).toBe(1);
    expect(reader.mock.calls).toHaveLength(calls);
    await deliverMessage(message.uuid);
    await due(chat.id);
    mute = true;
    expect(await sendPush(recipient.id, chat.id)).toBe(0);
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
      await post(author, chat.shortId, "First worker message");
      await post(author, chat.shortId, "Second worker message");
      await notificationOutbox.reconcile();
      const deadline = Date.now() + 10_000;
      while (!sent.length && Date.now() < deadline) await Bun.sleep(50);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.data).toMatchObject({ chat: chat.shortId, further: 1 });
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
