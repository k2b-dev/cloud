import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { type AiStoredMessage, aiConversations } from "@k2b/cloud/ai";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import { useTestAppRegistry } from "../../../scripts/fixtures/app-registry";
import { compileCapabilities, invokeCompiledCapability } from "../../../scripts/fixtures/code-platform";
import { suiteFor, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { createAiNotificationService } from "./ai-notifications";
import { aiCapabilities } from "./capabilities";
import { app } from "./config";

const owner = "4de00000-0000-4000-8000-000000000001";
const other = "4de00000-0000-4000-8000-000000000002";
const versionId = "4de00000-0000-4000-8000-000000000003";
const runId = "4de00000-0000-4000-8000-000000000004";
const codeId = "c_deliver4de";
const user: User = {
  id: owner,
  uid: "code-delivery-owner",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Owner",
  displayName: "Code Owner",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const compiled = compileCapabilities("core", aiCapabilities);
const action = compiled.actions.get("ai.chat.deliver")!;
let chat: Awaited<ReturnType<typeof aiConversations.createConversation>>;
let foreign: typeof chat;
const context = (workloadRun = runId): CapabilityExecutionContext => ({
  actor: {
    kind: "user",
    user,
    delegation: {
      kind: "invocation",
      credentialKind: "mandate",
      callingAppId: "core",
      invocationId: "delivery-test",
      workloadType: "code.version",
      workloadId: versionId,
      workloadRun,
    },
  },
  accessSubject: { type: "user", userId: owner },
  user,
  locale: "en",
  origin: "http",
  requestId: "delivery-test",
  idempotencyKey: "summary",
  signal: new AbortController().signal,
});
const invoke = (text: string, chatId = chat.shortId, ctx = context()) =>
  invokeCompiledCapability({
    compiled,
    kind: "action",
    localId: "ai.chat.deliver",
    target: { type: "core.ai.chat", id: chatId },
    input: { text },
    expectedSchemaHash: action.manifest.schemaHash,
    context: ctx,
  });

suiteFor("database", "valkey")("personal Code chat delivery capability", () => {
  useTestAppRegistry(["core", "assistant"]);
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  beforeAll(async () => {
    database = await useMigratedDatabase("code_chat_delivery");
    await registerNotificationDefinitions("core", app.notifications);
    for (const id of [owner, other]) await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
    chat = await aiConversations.createConversation({ ownerUserId: owner });
    foreign = await aiConversations.createConversation({ ownerUserId: other });
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Morning report')`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      VALUES(${versionId}::uuid,${codeId},1,'{}','fixture',${"a".repeat(64)},${"b".repeat(64)},0,7)`;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${runId}::uuid,${codeId},${versionId}::uuid,'schedule','morning','running',32768,10)`;
  }, 30_000);
  afterAll(async () => {
    await database?.drop();
  });

  test("owner delivery is unattended, marks the chat unread, and idempotent retries append once", async () => {
    const results = await Promise.all([invoke("Your morning report."), invoke("Your morning report.")]);
    expect(results[0]).toMatchObject({ ok: true, data: { data: { status: "delivered", targetChatId: chat.shortId } } });
    expect(results[1]).toEqual(results[0]);
    const messages = await aiConversations.listMessagesPage({ conversationId: chat.id, limit: 20 });
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({
      message: { role: "assistant", content: [{ type: "text", text: "Your morning report." }] },
      meta: { codeDelivery: { codeId, runId, effectKey: "summary" } },
    } satisfies Partial<AiStoredMessage>);
    expect(await aiConversations.getConversation({ conversationId: chat.id, ownerUserId: owner })).toMatchObject({
      unreadCompletion: true,
    });
    const [turns] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id=${chat.id}::uuid`;
    expect(turns?.count).toBe(0);
    expect(await invoke("Changed result.")).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  test("a new run can deliver under the same effect key", async () => {
    const nextRun = "4de00000-0000-4000-8000-000000000005";
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${nextRun}::uuid,${codeId},${versionId}::uuid,'schedule','morning','running',32768,10)`;
    expect(await invoke("Next run's report.", chat.shortId, context(nextRun))).toMatchObject({ ok: true });
    const [receipts] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM code.chat_deliveries WHERE key='summary'
      AND run_id IN (${runId}::uuid,${nextRun}::uuid)`;
    expect(receipts?.count).toBe(2);
  });

  test("another person's chat, another Code owner and archived chats are refused", async () => {
    expect(await invoke("Other chat.", foreign.shortId)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const otherUser = { ...user, id: other };
    expect(
      await invoke("Wrong owner.", foreign.shortId, {
        ...context(),
        user: otherUser,
        actor: { ...context().actor, kind: "user", user: otherUser },
        accessSubject: { type: "user", userId: other },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await sql`UPDATE ai.conversations SET archived_at=now() WHERE id=${chat.id}::uuid`;
    try {
      expect(await invoke("Archived.")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    } finally {
      await sql`UPDATE ai.conversations SET archived_at=NULL WHERE id=${chat.id}::uuid`;
    }
  });

  test("the capability enforces the message budget and rejects a non-Code origin", async () => {
    expect(await invoke("x".repeat(10_001))).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await invoke("No delegation.", chat.shortId, { ...context(), actor: { kind: "user", user } })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await invoke("x".repeat(10_000), chat.shortId, { ...context(), idempotencyKey: "boundary" })).toMatchObject({ ok: true });
  });

  test("notification recovery retries each committed delivery without duplicates", async () => {
    const delivered = await invoke("Notification recovery.", chat.shortId, { ...context(), idempotencyKey: "notify" });
    expect(delivered.ok).toBeTrue();
    const service = createAiNotificationService(app.notifications);
    await service.recover();
    await service.recover();
    const [events] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM notifications.events event
      JOIN code.chat_deliveries delivery ON event.idempotency_key='code-message:' || delivery.message_id::text
      WHERE delivery.run_id=${runId}::uuid AND delivery.key='notify' AND event.definition_id=${app.notifications.turnCompleted.id}`;
    expect(events?.count).toBe(1);
  });
});
