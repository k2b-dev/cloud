import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as publicAi from "@k2b/cloud/ai";
import { AiQuotaError, aiConversations, createAiProvider } from "@k2b/cloud/ai";
import * as runtime from "@k2b/cloud/ai/runtime";
import { AiQueuedChatStartError } from "@k2b/cloud/ai/runtime";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import { nestedInvocationLeases } from "@k2b/cloud/services/identity";
import { signInvocationToken, verifyInvocationToken } from "@k2b/cloud/services/identity/invocation-token";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { useTestAppRegistry } from "../../../scripts/fixtures/app-registry";
import {
  AiTurnExecutor,
  aiAssignmentFixture,
  aiModelCatalog,
  aiModelFixture,
  aiModelSettings,
  aiQuotas,
  aiSettingsFixture,
  beginAiCall,
  codeCapabilityOperation,
  compileCapabilities,
  createCodeCapabilityRoutes,
  drainQueuedMessages,
  editQueuedMessage,
  finishAiCall,
  invokeCompiledCapability,
  listQueuedMessages,
  updateQueuedMessage,
} from "../../../scripts/fixtures/code-platform";
import { meterSql } from "../../../scripts/fixtures/sql-meter";
import { suiteFor, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { validateQueuedChatStart } from "./ai-chat-queue";
import { aiChatSendAction, lockOwnerCodeChats } from "./ai-chat-send";
import { aiCapabilities } from "./capabilities";
import { reserveCodeAiBudget, settleCodeAiBudget } from "./code/ai-budget";
import { reserveCodeChatTurnBudget } from "./code/chat-turn-budget";
import { codeSettings } from "./code/settings";
import { migrate as migrateCode } from "./migrate/core/code";

const owner = "4f000000-0000-4000-8000-000000000001";
const other = "4f000000-0000-4000-8000-000000000002";
const versionId = "4f000000-0000-4000-8000-000000000003";
const codeId = "c_chatrun4f";
const user: User = {
  id: owner,
  uid: "code-chat-run-owner",
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
const action = compiled.actions.get("ai.chat.send")!;
let chat: Awaited<ReturnType<typeof aiConversations.createConversation>>;
let foreign: typeof chat;
let ordinal = 10;
let runId: string;
const ctx = (key = "morning"): CapabilityExecutionContext => ({
  actor: {
    kind: "user",
    user,
    delegation: {
      kind: "invocation",
      credentialKind: "mandate",
      callingAppId: "core",
      invocationId: "chat-run-test",
      workloadType: "code.version",
      workloadId: versionId,
      workloadRun: runId,
    },
  },
  accessSubject: { type: "user", userId: owner },
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: owner }, credentialKind: "session", scopes: [] },
  user,
  locale: "en",
  origin: "http",
  requestId: "chat-run-test",
  idempotencyKey: key,
  signal: new AbortController().signal,
});
const invoke = (chatId = chat.shortId, context = ctx(), prompt = "Review the morning work.") =>
  invokeCompiledCapability({
    compiled,
    kind: "action",
    localId: "ai.chat.send",
    target: { type: "core.ai.chat", id: chatId },
    input: { text: prompt, context: "Fictional source" },
    expectedSchemaHash: action.manifest.schemaHash,
    context,
  });
const read = (id: string, context = ctx()) =>
  invokeCompiledCapability({
    compiled,
    kind: "query",
    localId: "ai.chat.read",
    input: { id: chat.shortId, message: id },
    expectedSchemaHash: compiled.queries.get("ai.chat.read")!.manifest.schemaHash,
    context: { ...context, idempotencyKey: undefined },
  });
const dataSchema = aiChatSendAction.data;
const start = async (context = ctx()) => {
  const response = await invoke(chat.shortId, context);
  expect(response.ok).toBeTrue();
  if (!response.ok) throw new Error(response.error.message);
  const data = dataSchema.parse(response.data.data);
  await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
  return data;
};

// Historical calls predate worker reservations. Exercise their real quota admission
// and settlement, then attach the attribution that was already stored before upgrade.
const beginLegacyCodeCall = async (profile: Parameters<typeof beginAiCall>[0], turnId: string, input: number, output: number) => {
  const call = await beginAiCall(profile, { kind: "chat", task: "chat", subject: { type: "user", userId: owner } }, input, output);
  await sql`UPDATE ai.inference_calls SET turn_id=${turnId}::uuid,code_id=${codeId} WHERE id=${call.id}::uuid`;
  return call;
};

suiteFor(
  "database",
  "valkey",
  "nats",
)("authorized sources send to Gustav", () => {
  useTestAppRegistry(["core", "assistant"]);
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  beforeAll(async () => {
    database = await useMigratedDatabase("code_chat_run");
    for (const id of [owner, other]) await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Morning review')`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      VALUES(${versionId}::uuid,${codeId},1,'{}','fixture',${"a".repeat(64)},${"b".repeat(64)},0,7)`;
    await sql`UPDATE code.codes SET state='active', active_version_id=${versionId}::uuid WHERE id=${codeId}`;
  }, 30_000);
  afterAll(async () => {
    await database?.drop();
  });
  afterEach(() => {
    mock.restore();
  });

  const setup = async () => {
    await sql`UPDATE code.codes SET state='active',active_version_id=${versionId}::uuid WHERE id=${codeId}`;
    // Business keys span runs and callers within an account; each case owns a fresh key space.
    await sql`DELETE FROM ai.queued_messages`;
    await sql`DELETE FROM ai.chat_send_receipts`;
    // One open Code turn across chats is the rule under test; earlier cases leave none behind.
    await sql`UPDATE ai.turns SET status='aborted',completed_at=clock_timestamp()
      WHERE status IN ('queued','running','waiting_for_action') AND run_config ? 'codeOrigin'`;
    runId = `4f000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${runId}::uuid,${codeId},${versionId}::uuid,'schedule','morning','running',32768,10)`;
    chat = await aiConversations.createConversation({ ownerUserId: owner });
    foreign = await aiConversations.createConversation({ ownerUserId: other });
    await sql`DELETE FROM code.ai_daily_budget`;
    await sql`DELETE FROM ai.inference_calls WHERE user_id=${owner}::uuid`;
    await sql`UPDATE ai.cost_config SET enabled=false,rules='[]',background=NULL WHERE singleton`;
    spyOn(codeSettings, "get").mockResolvedValue(1);
    spyOn(coreSettings, "get").mockResolvedValue("UTC");
    const prepareTurn: typeof runtime.prepareAiChatTurn = async (input) => ({
      conversationId: input.conversationId,
      modelId: "fixture",
      userMessage: input.userMessage,
      truncateFromSeq: undefined,
      expectedDraftRevision: undefined,
      expectedProjectId: input.expectedProjectId,
      resources: undefined,
      retrySourceTurnId: undefined,
      runConfig: {
        kind: "chat",
        writerOrigin: input.writerOrigin,
        turnTrigger: input.turnTrigger,
        send: input.send,
        codeOrigin: input.codeOrigin,
        assistantChat: true,
        input: input.input,
        actor: input.actor,
        locale: input.locale,
        toolSource: input.toolSource,
        toolApprovalContext: input.toolApprovalContext,
        systemPrompt: input.systemPrompt,
      },
    });
    const prepare = spyOn(runtime, "prepareAiChatTurn").mockImplementation(prepareTurn);
    const readSettings = spyOn(aiModelSettings, "readAiSettingsState").mockResolvedValue(
      aiSettingsFixture({ profiles: [aiModelFixture({ id: "fixture" })] }),
    );
    const selectModel = spyOn(publicAi, "selectAssistantAiModel").mockResolvedValue({ id: "fixture" });
    const enqueue = spyOn(runtime, "wakeAiMessageQueue").mockImplementation(() => {});
    return { prepare, enqueue, prepareTurn, readSettings, selectModel };
  };

  const personContext = (): CapabilityExecutionContext => ({ ...ctx(), actor: { kind: "user", user } });
  test("a person sends directly with full session authority", async () => {
    await setup();
    const sent = await start(personContext());
    expect(sent.origin).toEqual({ kind: "person", id: owner });
    const [entry] = await sql<{ author_user_id: string | null }[]>`SELECT author_user_id FROM ai.queued_messages WHERE id=${sent.id}::uuid`;
    expect(entry?.author_user_id).toBe(owner);
  });
  test("an edit without a signed-in session starts the current message with its source restriction", async () => {
    await setup();
    const accepted = await invoke(chat.shortId, personContext());
    if (!accepted.ok) throw new Error(accepted.error.message);
    const sent = dataSchema.parse(accepted.data.data);
    expect(await editQueuedMessage(chat.id, sent.id, "Edited from the terminal", { signedInSession: false })).toBeTrue();
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    expect(turn).not.toBeNull();
    expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: turn!.id })).toMatchObject({
      sourceRestricted: true,
      send: { id: sent.id },
    });
    expect((await aiConversations.listMessages({ conversationId: chat.id }))[0]?.message).toMatchObject({
      content: [{ type: "text", text: "Edited from the terminal" }],
    });
  });
  test.each(["Gustav", "code_run"])("%s keeps the verified source turn through its invocation lease", async (sourceKind) => {
    await setup();
    const source = await aiConversations.createConversation({ ownerUserId: owner });
    const submitted = await aiConversations.submitChatTurn({
      conversationId: source.id,
      modelId: "fixture",
      userMessage: { role: "user", content: [{ type: "text", text: "Delegate" }] },
      runConfig: {
        kind: "chat",
        input: "Delegate",
        writerOrigin: { kind: "person", id: owner },
        turnTrigger: { kind: "person", id: owner },
        actor: { kind: "user", user },
      },
    });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${submitted.turn.id}::uuid`;
    spyOn(nestedInvocationLeases, "read").mockResolvedValue({
      appId: "core",
      origin: "assistant",
      deadline: 9999999999999,
      assistantTurn: { conversationId: source.id, turnId: submitted.turn.id },
    });
    const context: CapabilityExecutionContext = {
      ...personContext(),
      origin: "assistant",
      actor: {
        kind: "user",
        user,
        delegation: { kind: "invocation", credentialKind: "session", callingAppId: "core", invocationId: "source" },
      },
    };
    let result: unknown;
    if (sourceKind === "code_run") {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const signer = { kid: "4f000000-0000-4000-8000-000000000099", key: pair.privateKey, signUntil: new Date(Date.now() + 3_600_000) };
      const issuer = "https://cloud.test";
      const key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: signer.kid, alg: "RS256", use: "sig" }] });
      const signed = await signInvocationToken({
        targetAppId: "core",
        callingAppId: "assistant",
        operation: codeCapabilityOperation(source.id, submitted.turn.id),
        schemaHash: null,
        authority: {
          sub: owner,
          principal_type: "user",
          access_subject_type: "user",
          access_subject_id: owner,
          credential_kind: "session",
          scopes: [],
        },
        signer,
        issuer,
      });
      const callback = createCodeCapabilityRoutes({
        invocation: {
          getApp: async () => ({ id: "core" }),
          verify: (value, expected, options) => verifyInvocationToken(value, expected, { ...options, issuer, key }),
          resolve: async (claims) => ({
            actor: {
              kind: "user",
              user,
              delegation: { kind: "invocation", callingAppId: "assistant", credentialKind: "session", invocationId: claims.jti },
            },
            accessSubject: { type: "user", userId: owner },
            credentialKind: "invocation",
            scopes: [],
          }),
        },
        dispatch: async (input) => {
          expect(input.assistantTurn).toEqual({ conversationId: source.id, turnId: submitted.turn.id });
          expect(input.origin).toBe("assistant");
          expect(input.authority?.scopes).toEqual([]);
          expect(input.target).toEqual({ type: "core.ai.chat", id: chat.shortId });
          return Response.json(await invoke(chat.shortId, context));
        },
      });
      const app = new Hono().route("/code", callback);
      const response = await app.request(`/code/${source.id}/${submitted.turn.id}/capabilities/v1/actions/core/ai.chat.send`, {
        method: "POST",
        headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json", "idempotency-key": "code-run-send" },
        body: JSON.stringify({
          target: { type: "core.ai.chat", id: chat.shortId },
          input: { text: "Delegate" },
        }),
      });
      expect(response.status).toBe(200);
      result = await response.json();
    } else result = await invoke(chat.shortId, context);
    expect(result).toMatchObject({
      ok: true,
      data: { data: { origin: { kind: "chat", id: source.shortId, turnId: submitted.turn.shortId } } },
    });
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    const forwardedTurn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    expect(forwardedTurn).not.toBeNull();
    expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: forwardedTurn!.id })).toMatchObject({
      turnTrigger: { kind: "chat", id: source.shortId },
      writerOrigin: { kind: "chat", id: source.shortId, turnId: submitted.turn.shortId },
    });
    await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${forwardedTurn!.id}::uuid`;
    const pendingSource = await invoke(chat.shortId, { ...context, idempotencyKey: "revalidate-source" });
    if (!pendingSource.ok) throw new Error(pendingSource.error.message);
    const pendingSourceId = dataSchema.parse(pendingSource.data.data).id;
    for (const kind of ["automation", "chat"] as const) {
      await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{turnTrigger}',${JSON.stringify(
        kind === "chat" ? { kind, id: source.shortId } : { kind, id: codeId },
      )}::text::jsonb) WHERE id=${submitted.turn.id}::uuid`;
      expect(await invoke(chat.shortId, { ...context, idempotencyKey: kind })).toMatchObject({
        ok: false,
        error: { code: "chat_chain_forbidden" },
      });
    }
    await sql`UPDATE ai.turns SET run_config=run_config-'turnTrigger' WHERE id=${submitted.turn.id}::uuid`;
    expect(await invoke(chat.shortId, context)).toMatchObject({ ok: false, error: { code: "chat_chain_forbidden" } });
    await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{turnTrigger}',${JSON.stringify({ kind: "person", id: owner })}::text::jsonb) WHERE id=${submitted.turn.id}::uuid`;
    await sql`UPDATE ai.conversations SET allowed_tools=ARRAY[]::text[] WHERE id=${source.id}::uuid`;
    expect(await invoke(chat.shortId, context)).toMatchObject({ ok: false, error: { code: "source_restricted" } });
    await sql`UPDATE ai.conversations SET allowed_tools=NULL WHERE id=${source.id}::uuid`;
    await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{sourceRestricted}','true'::jsonb) WHERE id=${submitted.turn.id}::uuid`;
    expect(await invoke(chat.shortId, context)).toMatchObject({ ok: false, error: { code: "source_restricted" } });
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await read(pendingSourceId)).toMatchObject({
      ok: true,
      data: { data: { message: { status: "failed", reason: "source_restricted" } } },
    });
  });
  test("App sessions, scoped authority and service accounts cannot start a personal turn", async () => {
    const { prepare } = await setup();
    const person = personContext();
    expect(await invoke(chat.shortId, { ...person, actor: { kind: "user", user, sessionKind: "app" } })).toMatchObject({
      ok: false,
      error: { code: "source_restricted" },
    });
    expect(await invoke(chat.shortId, { ...person, authority: { ...person.authority!, scopes: ["read"] } })).toMatchObject({
      ok: false,
      error: { code: "source_restricted" },
    });
    expect(
      await invoke(chat.shortId, { ...person, user: null, accessSubject: { type: "service_account", serviceAccountId: other } }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(prepare).not.toHaveBeenCalled();
  });
  test("retry cannot replace the immutable initiator, send ID, or source restriction", async () => {
    await setup();
    const sent = await start();
    const original = await aiConversations.getLatestTurn({ conversationId: chat.id });
    if (!original) throw new Error("Missing original turn");
    await sql`UPDATE ai.turns SET status='completed', run_config=jsonb_set(run_config,'{sourceRestricted}','true'::jsonb) WHERE id=${original.id}::uuid`;
    const retry = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelId: "fixture",
      retrySourceTurnId: original.id,
      userMessage: { role: "user", content: [{ type: "text", text: "Try again" }] },
      runConfig: {
        kind: "chat",
        input: "Try again",
        actor: { kind: "user", user },
        writerOrigin: { kind: "person", id: owner },
        turnTrigger: { kind: "person", id: owner },
      },
    });
    expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: retry.turn.id })).toMatchObject({
      writerOrigin: sent.origin,
      turnTrigger: { kind: "automation", id: codeId },
      send: { id: sent.id },
      sourceRestricted: true,
    });
    expect(await read(sent.id)).toMatchObject({ ok: true, data: { data: { message: { id: sent.id, origin: sent.origin } } } });
    // The person's retry runs on their own allowance: no Code budget attribution carries over.
    const retried = await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: retry.turn.id });
    expect(retried && retried.kind !== "compact" ? retried.codeOrigin : "compact").toBeUndefined();
    // Editing the text before retrying makes the person its writer; initiator and receipt stay.
    await sql`UPDATE ai.turns SET status='completed' WHERE id=${retry.turn.id}::uuid`;
    const edited = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelId: "fixture",
      retrySourceTurnId: retry.turn.id,
      retryEdited: true,
      userMessage: { role: "user", content: [{ type: "text", text: "Edited" }] },
      runConfig: { kind: "chat", input: "Edited", actor: { kind: "user", user } },
    });
    expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: edited.turn.id })).toMatchObject({
      writerOrigin: { kind: "person", id: owner },
      turnTrigger: { kind: "automation", id: codeId },
      send: { id: sent.id },
    });
  });

  test("cutover fails pending legacy messages visibly and removes delivery storage without losing text", async () => {
    await setup();
    await start();
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    if (!turn) throw new Error("Missing fixture turn");
    const target = await aiConversations.createConversation({ ownerUserId: owner });
    const legacy = async (shortId: string, key: string) =>
      sql`INSERT INTO ai.inter_chat_messages(short_id,source_conversation_id,source_turn_id,source_call_id,target_conversation_id,actor_user_id,text,idempotency_key)
        VALUES(${shortId},${chat.id}::uuid,${turn.id}::uuid,${key},${target.id}::uuid,${owner}::uuid,'Already accepted',${key})`;
    const statuses = async () =>
      sql<{ key: string; status: string; reason: string | null }[]>`SELECT idempotency_key AS key,status,error AS reason
        FROM ai.inter_chat_messages WHERE idempotency_key LIKE 'legacy-%' ORDER BY idempotency_key`;
    // Upgrading straight from main: no feat/code delivery tables, a pending message from ai.chat.message.
    await legacy("OldMain", "legacy-main");
    await migrateCode();
    expect(await statuses()).toEqual([{ key: "legacy-main", status: "failed", reason: expect.stringContaining("Send it again") }]);
    // Upgrading from an earlier integration build that still has its delivery tables.
    await sql`CREATE TABLE code.chat_deliveries(id uuid)`;
    await sql`CREATE TABLE code.chat_runs(id uuid)`;
    await sql`UPDATE ai.messages SET meta=meta || '{"codeDelivery":{"runId":"legacy"}}'::jsonb WHERE loop_id=${turn.id}`;
    await legacy("OldCut", "legacy-cutover");
    await migrateCode();
    await migrateCode();
    expect((await statuses()).map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(
      await sql<
        { delivery: string | null; runs: string | null }[]
      >`SELECT to_regclass('code.chat_deliveries')::text AS delivery,to_regclass('code.chat_runs')::text AS runs`,
    ).toEqual([{ delivery: null, runs: null }]);
    const [message] = await sql<
      { content: unknown; legacy: boolean }[]
    >`SELECT message->'content' AS content,meta ? 'codeDelivery' AS legacy FROM ai.messages WHERE loop_id=${turn.id}`;
    expect(message?.legacy).toBeFalse();
    expect(message?.content).toEqual([
      { type: "text", text: 'Review the morning work.\n\nSource context (untrusted data):\n"Fictional source"' },
    ]);
  });

  test("owner starts one turn; retry creates no duplicate and preserves Code origin in the chat and run", async () => {
    const { prepare } = await setup();
    const results = await Promise.all([invoke(), invoke()]);
    expect(results[0]).toMatchObject({
      ok: true,
      data: {
        data: {
          status: "queued",
          chatId: chat.shortId,
          origin: { kind: "automation", id: codeId, runId },
        },
      },
    });
    expect(results[1]).toEqual(results[0]);
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    const messages = await aiConversations.listMessages({ conversationId: chat.id });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.meta?.codeOrigin).toMatchObject({ codeId, runId, label: "Started by Code Morning review" });
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    expect(turn?.codeOrigin).toEqual(messages[0]?.meta?.codeOrigin);
    const config = await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: turn!.id });
    expect(config).toMatchObject({
      assistantChat: true,
      actor: { kind: "user", user: { id: owner } },
      toolSource: { kind: "default", appTools: true },
      toolApprovalContext: { actorUserId: owner },
      turnTrigger: { kind: "automation", id: codeId },
    });
    expect(config && "mandate" in config ? config.mandate : undefined).toBeUndefined();
    expect(config && "background" in config ? config.background : undefined).toBeUndefined();
    // An existing receipt remains readable even if model resolution or quota now refuses new work.
    prepare.mockRejectedValue(new AiQuotaError("quota_exhausted", "Empty"));
    expect(await invoke()).toEqual(results[0]);
    expect(await invoke(chat.shortId, ctx(), "Changed instructions")).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    const otherChat = await aiConversations.createConversation({ ownerUserId: owner });
    expect(await invoke(otherChat.shortId)).toMatchObject({
      ok: true,
      data: { data: { id: dataSchema.parse(results[0]!.ok ? results[0]!.data.data : null).id, chatId: chat.shortId } },
    });
    const [debit] = await sql<{ cost: string }[]>`SELECT ai_reference_cost::text AS cost FROM code.runs WHERE id=${runId}::uuid`;
    expect(Number(debit?.cost)).toBe(0);
  });

  test("an accepted key survives a new Code run while another account has an independent key scope", async () => {
    await setup();
    const first = await start();
    await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp() WHERE id=${runId}::uuid`;
    runId = `4f000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${runId}::uuid,${codeId},${versionId}::uuid,'schedule','morning','running',32768,10)`;
    expect(await invoke()).toMatchObject({ ok: true, data: { data: { id: first.id, origin: first.origin } } });
    const otherUser = { ...user, id: other };
    const context: CapabilityExecutionContext = {
      ...personContext(),
      user: otherUser,
      actor: { kind: "user", user: otherUser },
      accessSubject: { type: "user", userId: other },
      authority: {
        actor: { kind: "user", user: otherUser },
        accessSubject: { type: "user", userId: other },
        credentialKind: "session",
        scopes: [],
      },
    };
    const response = await invoke(foreign.shortId, context);
    if (!response.ok) throw new Error(response.error.message);
    const second = dataSchema.parse(response.data.data);
    expect(second.id).not.toBe(first.id);
    expect(second.origin).toEqual({ kind: "person", id: other });
  });

  test("queue admission retains its receipt and trigger after promotion and maps removed turns and terminal automation quota", async () => {
    await setup();
    const sent = await start();
    const [entry] = await sql<
      { submission: unknown; author_user_id: string | null }[]
    >`SELECT submission,author_user_id FROM ai.queued_messages WHERE id=${sent.id}::uuid`;
    expect(entry?.author_user_id).toBeNull();
    expect(entry?.submission).toEqual({
      runConfig: {
        send: expect.objectContaining({ id: sent.id, accountId: owner, keyHash: expect.any(String), requestHash: expect.any(String) }),
        turnTrigger: { kind: "automation", id: codeId },
      },
    });
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    await sql`DELETE FROM ai.turns WHERE id=${turn!.id}::uuid`;
    expect(await read(sent.id)).toMatchObject({ ok: true, data: { data: { message: { status: "cancelled" } } } });
    const response = await invoke(chat.shortId, ctx("quota-wait"));
    if (!response.ok) throw new Error(response.error.message);
    const queued = dataSchema.parse(response.data.data);
    await sql`UPDATE ai.queued_messages SET status='failed',error='quota_exhausted' WHERE id=${queued.id}::uuid`;
    expect(await read(queued.id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed", reason: "quota_exhausted" } } } });
    await sql`UPDATE ai.queued_messages SET error='dispatch_failed' WHERE id=${queued.id}::uuid`;
    expect(await read(queued.id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed" } } } });
  });

  test("stranger Code and a reader of shared personal Code cannot start an owner's turn", async () => {
    await setup();
    expect(await invoke(foreign.shortId)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const otherUser = { ...user, id: other };
    const context = ctx();
    expect(
      await invoke(chat.shortId, {
        ...context,
        actor: { ...context.actor, kind: "user", user: otherUser },
        user: otherUser,
        authority: {
          actor: { kind: "user", user: otherUser },
          accessSubject: { type: "user", userId: other },
          credentialKind: "session",
          scopes: [],
        },
        accessSubject: { type: "user", userId: other },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    // A real reader grant does not change either ownership check.
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${other}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${codeId},${access!.id}::uuid)`;
    expect(
      await invoke(chat.shortId, {
        ...context,
        actor: { ...context.actor, kind: "user", user: otherUser },
        user: otherUser,
        authority: {
          actor: { kind: "user", user: otherUser },
          accessSubject: { type: "user", userId: other },
          credentialKind: "session",
          scopes: [],
        },
        accessSubject: { type: "user", userId: other },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await aiConversations.listMessages({ conversationId: chat.id })).toHaveLength(0);
  });

  test("resource-owned Code and restricted callers are refused before preparation", async () => {
    const { prepare } = await setup();
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(kind,name,status) VALUES('code','code:spaces.space:4f','active') RETURNING id`;
    const machine: CapabilityExecutionContext = {
      ...ctx(),
      user: null,
      accessSubject: { type: "service_account", serviceAccountId: account!.id },
      actor: {
        kind: "service_account",
        delegatedUser: null,
        scopes: ["read", "write"],
        serviceAccount: {
          id: account!.id,
          name: "Mailbox Code",
          kind: "code",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: owner,
          createdAt: "2026-11-15T00:00:00Z",
        },
      },
    };
    expect(await invoke(chat.shortId, machine)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const resourceId = "c_resource4f",
      resourceVersion = "4f000000-0000-4000-8000-000000000004",
      resourceRun = "4f000000-0000-4000-8000-000000000005";
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,title,service_account_id) VALUES(${resourceId},'resource','spaces.space','4f','Space Code',${account!.id}::uuid)`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      VALUES(${resourceVersion}::uuid,${resourceId},1,'{}','fixture',${"a".repeat(64)},${"b".repeat(64)},0,7)`;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${resourceRun}::uuid,${resourceId},${resourceVersion}::uuid,'schedule','morning','running',32768,10)`;
    const context = ctx();
    expect(
      await invoke(chat.shortId, {
        ...context,
        actor: {
          ...context.actor,
          kind: "user",
          user,
          delegation: { ...context.actor.delegation!, workloadId: resourceVersion, workloadRun: resourceRun },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await invoke(chat.shortId, { ...context, actor: { kind: "user", user }, authority: undefined })).toMatchObject({
      ok: false,
      error: { code: "source_restricted" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  test("owner interactive quota refuses with its stable budget code before a turn starts", async () => {
    const { prepare } = await setup();
    prepare.mockRejectedValueOnce(new AiQuotaError("quota_exhausted", "The allowance is exhausted"));
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "quota_exhausted" } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
  });

  test("three cheap legacy turns fit the daily USD budget and leave generate/decide allowance available", async () => {
    const { prepare, prepareTurn } = await setup();
    const profile = aiModelFixture({
      id: "fixture",
      pricing: { inputPerMillion: 1, outputPerMillion: 1 },
      contextWindow: 128000,
      maxOutputTokens: 1000,
    });
    const state = aiSettingsFixture({ profiles: [profile] });
    spyOn(aiModelSettings, "readAiSettingsState").mockResolvedValue(state);
    const subject = { type: "user" as const, userId: owner };
    // Same daily USD rule and real ledger as interactive owner turns, with no model network call.
    const rules = [
      { scope: "*", hours: 24, anchor: "1970-01-01T00:00:00Z", grants: [{ principal: { type: "user", userId: owner }, limit: 0.07 }] },
    ];
    await sql`UPDATE ai.cost_config SET enabled=true,rules=${JSON.stringify(rules)}::text::jsonb WHERE singleton`;
    prepare.mockImplementation(async (input) => {
      await aiQuotas.assertAllowed(subject, profile.id, state);
      return prepareTurn(input);
    });
    const charge = async (turnId: string, input = 10_000, output = 10_000) => {
      const call = await beginLegacyCodeCall(profile, turnId, input, output);
      await finishAiCall(call.id, { input, output }, "ok");
    };
    for (let i = 0; i < 3; i++) {
      await start(ctx(`cheap-${i}`));
      const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
      await charge(turn!.id);
      await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${turn!.id}::uuid`;
    }
    const [usage] = await sql<{ cost: string; attributed: number }[]>`
      SELECT sum(cost)::text AS cost,count(*) FILTER(WHERE code_id=${codeId})::int AS attributed
      FROM ai.inference_calls WHERE user_id=${owner}::uuid`;
    expect(Number(usage?.cost)).toBe(0.06);
    expect(usage?.attributed).toBe(3);
    const [run] = await sql<{ cost: string }[]>`SELECT ai_reference_cost::text AS cost FROM code.runs WHERE id=${runId}::uuid`;
    expect(Number(run?.cost)).toBe(0);
    // Exercise the bridge reservation and the compiled generation capability as separate seams.
    // The attempt allowance stays intact; only the actual 0.06 daily cost reduces its headroom.
    const claims = { runId, codeId, generation: 0 };
    const reserved = await sql.begin((db) => reserveCodeAiBudget(claims, 1, 1, db, { code: 1, owner: 1, timeZone: "UTC" }));
    expect(reserved.ok).toBeTrue();
    if (!reserved.ok) throw new Error(reserved.code);
    expect(Number(reserved.reserved)).toBeCloseTo(0.94, 12);
    spyOn(publicAi, "runAiStructured").mockResolvedValue({
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
      output: { text: "Available" },
      model: { id: "fixture" },
      usage: { input: 5_000, output: 5_000, total: 10_000 },
    });
    const generated = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "ai.generate",
      expectedSchemaHash: compiled.queries.get("ai.generate")!.manifest.schemaHash,
      input: { task: "budget-regression", prompt: "Write a brief summary", input: {}, output: { type: "text", maxChars: 100 } },
      context: { ...ctx(), idempotencyKey: undefined },
    });
    expect(generated).toMatchObject({ ok: true, data: { data: { output: "Available" } } });
    await sql.begin((db) => settleCodeAiBudget(claims, 1, "0.01", db));
    // Spend the remaining owner allowance through an ordinary interactive call.
    const final = await beginAiCall(profile, { kind: "chat", task: "chat", subject }, 5_000, 5_000);
    await finishAiCall(final.id, { input: 5_000, output: 5_000 }, "ok");
    expect(await invoke(chat.shortId, ctx("exhausted"))).toMatchObject({ ok: false, error: { code: "quota_exhausted" } });
    expect(await sql`SELECT * FROM ai.queued_messages WHERE origin->>'runId'=${runId}`).toHaveLength(3);
  });

  test.each(["code", "owner"] as const)("legacy turn cost counts toward the existing %s daily Code USD budget", async (scope) => {
    await setup();
    await start();
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    const profile = aiModelFixture({
      id: "fixture",
      pricing: { inputPerMillion: 0.5, outputPerMillion: 0.5 },
      contextWindow: 128000,
      maxOutputTokens: 1000,
    });
    const call = await beginLegacyCodeCall(profile, turn!.id, 200_000, 200_000);
    await finishAiCall(call.id, { input: 200_000, output: 200_000 }, "ok");
    await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${turn!.id}::uuid`;
    spyOn(codeSettings, "get").mockImplementation(async (key) =>
      key === (scope === "code" ? "core.code.ai_daily_budget_usd" : "core.code.ai_owner_daily_budget_usd") ? 0.2 : 1,
    );
    // Removing the chat history cannot erase the cost attribution captured on the call.
    await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
    chat = await aiConversations.createConversation({ ownerUserId: owner });
    expect(await invoke(chat.shortId, ctx("daily-limit"))).toMatchObject({
      ok: false,
      error: { code: scope === "code" ? "code_ai_daily_budget_limit" : "code_ai_owner_daily_budget_limit", status: 409 },
    });
    const [run] = await sql<{ cost: string }[]>`SELECT ai_reference_cost::text AS cost FROM code.runs WHERE id=${runId}::uuid`;
    expect(Number(run?.cost)).toBe(0);
  });

  test("unknown legacy turn usage blocks another turn without adding a text-AI-only budget refusal", async () => {
    await setup();
    await start();
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    const profile = aiModelFixture({
      id: "fixture",
      pricing: { inputPerMillion: 1, outputPerMillion: 1 },
      contextWindow: 128000,
      maxOutputTokens: 1000,
    });
    const call = await beginLegacyCodeCall(profile, turn!.id, 1, 1);
    await finishAiCall(call.id, undefined, "ok");
    await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${turn!.id}::uuid`;
    expect(await invoke(chat.shortId, ctx("unknown"))).toMatchObject({ ok: false, error: { code: "code_ai_owner_daily_budget_limit" } });
    // Normal owner quotas remain authoritative for text AI; Code does not add an unrelated unknown-usage ban.
    const claims = { runId, codeId, generation: 0 };
    expect(await sql.begin((db) => reserveCodeAiBudget(claims, 1, 1, db, { code: 1, owner: 1, timeZone: "UTC" }))).toEqual({
      ok: true,
      reserved: "1.000000000000",
    });
    await sql.begin((db) => settleCodeAiBudget(claims, 1, "0", db));
  });

  test("a live legacy owner inference reservation counts until it settles to actual usage", async () => {
    await setup();
    await start();
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    const profile = aiModelFixture({
      id: "fixture",
      pricing: { inputPerMillion: 0.5, outputPerMillion: 0.5 },
      contextWindow: 128000,
      maxOutputTokens: 1000,
    });
    spyOn(aiModelSettings, "readAiSettingsState").mockResolvedValue(aiSettingsFixture({ profiles: [profile] }));
    const rules = [
      { scope: "*", hours: 24, anchor: "1970-01-01T00:00:00Z", grants: [{ principal: { type: "user", userId: owner }, limit: 1 }] },
    ];
    await sql`UPDATE ai.cost_config SET enabled=true,rules=${JSON.stringify(rules)}::text::jsonb WHERE singleton`;
    const call = await beginLegacyCodeCall(profile, turn!.id, 200_000, 200_000);
    chat = await aiConversations.createConversation({ ownerUserId: owner });
    spyOn(codeSettings, "get").mockResolvedValue(0.2);
    // The earlier turn's state no longer holds the owner; its live call still reserves.
    await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${turn!.id}::uuid`;
    try {
      expect(await invoke(chat.shortId, ctx("reserved"))).toMatchObject({ ok: false, error: { code: "code_ai_owner_daily_budget_limit" } });
    } finally {
      await finishAiCall(call.id, { input: 10_000, output: 10_000 }, "ok");
    }
    // Settlement retains the actual 0.01, releasing the other 0.19.
    expect(await invoke(chat.shortId, ctx("settled"))).toMatchObject({ ok: true });
  });

  test("existing text AI daily spend still refuses a new turn", async () => {
    await setup();
    const [period] = await sql<{ day: string }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`;
    await sql`INSERT INTO code.ai_daily_budget(day,scope_kind,scope_key,reference_cost)
      VALUES(${period!.day}::date,'owner',json_build_array('person',${owner}::uuid)::text,1)`;
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "code_ai_owner_daily_budget_limit" } });
  });

  test.each(["ai_disabled", "ai_no_model", "model_policy_mismatch"] as const)("%s is an explicit pre-turn refusal", async (code) => {
    const { prepare } = await setup();
    prepare.mockRejectedValueOnce(
      Object.assign(new Error("Model admission refused"), { aiError: { code, message: "Model admission refused" } }),
    );
    expect(await invoke()).toMatchObject({ ok: false, error: { code, status: code === "model_policy_mismatch" ? 403 : 409 } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
  });

  test("a Project change during preparation refuses the stale snapshot before admission", async () => {
    const { prepare, prepareTurn } = await setup();
    const projectId = "4f000000-0000-4000-8000-000000000008";
    await sql`INSERT INTO ai.projects(id,short_id,name) VALUES(${projectId}::uuid,'Proj4f','Changed Project')`;
    prepare.mockImplementationOnce(async (input) => {
      const prepared = await prepareTurn(input);
      await sql`UPDATE ai.conversations SET project_id=${projectId}::uuid WHERE id=${chat.id}::uuid`;
      return prepared;
    });
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "chat_changed", status: 409 } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
    const [run] = await sql<{ cost: string }[]>`SELECT ai_reference_cost::text AS cost FROM code.runs WHERE id=${runId}::uuid`;
    expect(Number(run?.cost)).toBe(0);
  });

  test.each(["pending", "failed"] as const)("a %s queued message stays ahead of the accepted send", async (status) => {
    await setup();
    const id = "4f000000-0000-4000-8000-000000000009";
    await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status)
      VALUES(${id}::uuid,${chat.id}::uuid,'{}','[]',${status})`;
    expect(await invoke()).toMatchObject({ ok: true, data: { data: { status: "queued" } } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
    const [run] = await sql<{ cost: string }[]>`SELECT ai_reference_cost::text AS cost FROM code.runs WHERE id=${runId}::uuid`;
    expect(Number(run?.cost)).toBe(0);
    const [queued] = await sql`DELETE FROM ai.queued_messages WHERE id=${id}::uuid RETURNING status`;
    expect(queued?.status).toBe(status);
  });

  test("approval-needed tool waits in chat; Code gets waiting state and retry never starts a second turn", async () => {
    await setup();
    const [modelAccess] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${owner}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO ai.model_access_resources(model_id) VALUES('chat') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO ai.model_access(model_id,access_id) VALUES('chat',${modelAccess!.id}::uuid)`;
    const pending = await start({ ...ctx(), locale: "de" });
    expect(pending.origin).toMatchObject({ kind: "automation", id: codeId });
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          [
            {
              choices: [
                {
                  delta: {
                    role: "assistant",
                    tool_calls: [{ index: 0, id: "approval-4f", type: "function", function: { name: "approval_probe", arguments: "{}" } }],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const profile = aiModelFixture({
        id: "fixture",
        provider: "openai-compatible",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        model: "fixture",
        maxToolRounds: 3,
      });
      const executed = mock(async () => ({}));
      const executor = new AiTurnExecutor({
        leaseOwner: "4f-executor",
        heartbeatMs: 5000,
        enqueueContinuation: async () => {},
        // This seam isolates owner tool approval; actual Core admission is covered by chat-turn-budget.integration.test.ts.
        beforeChatTurn: async ({ turnId, profile }) => {
          await sql.begin((db) =>
            reserveCodeChatTurnBudget({ turnId, profile, codeId, ownerUserId: owner }, db, { code: 1, owner: 1, timeZone: "UTC" }),
          );
        },
        validateTurn: async () => ({
          settings: aiSettingsFixture({ profiles: [profile], assignments: [aiAssignmentFixture("balanced", profile.id)] }),
          resolved: { model: { id: profile.id }, profile, provider: createAiProvider(profile, "test") },
        }),
        tools: [
          {
            location: "server",
            def: {
              name: "approval_probe",
              description: "Requires owner approval",
              inputSchema: z.strictObject({}),
              outputSchema: z.strictObject({}),
              approval: "always",
            },
            run: executed,
          },
        ],
      });
      const claim = await aiConversations.claimTurn({
        conversationId: chat.id,
        turnId: turn!.id,
        leaseOwner: "4f-executor",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 30_000,
      });
      expect(claim).not.toBeNull();
      await executor.run({ conversationId: chat.id, turnId: turn!.id, claim: claim!, signal: new AbortController().signal });
      expect(executed).not.toHaveBeenCalled();
      expect(await invoke()).toMatchObject({ ok: true, data: { data: { id: pending.id, status: "waiting" } } });
      expect(await read(pending.id)).toMatchObject({ ok: true, data: { data: { message: { status: "waiting" } } } });
      expect(await aiConversations.listPendingTurnActions({ conversationId: chat.id, turnId: turn!.id })).toMatchObject([
        { type: "approval_request" },
      ]);
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id=${chat.id}::uuid`;
      expect(count?.count).toBe(1);
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("queued code sends count against the daily budget", async () => {
    await setup();
    const results = [];
    for (let i = 0; i < 32; i++) results.push(await invoke(chat.shortId, ctx(`burst-${i}`)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === "chat_busy")).toHaveLength(31);
    // The same Code cannot spread across chats either.
    const chats = await Promise.all(Array.from({ length: 40 }, () => aiConversations.createConversation({ ownerUserId: owner })));
    const spread = [];
    for (const [i, other] of chats.entries()) spread.push(await invoke(other.shortId, ctx(`spread-${i}`)));
    expect(spread.filter((result) => result.ok)).toHaveLength(0);
    const [queued] = await sql<{ id: string }[]>`SELECT id FROM ai.queued_messages WHERE conversation_id=${chat.id}::uuid`;
    // The day is spent while the message waits: it must not start a turn, and its refusal is final.
    await sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,kind,task,provider_model,code_id,pricing,cost,finished_at,lease_expires_at)
      VALUES(${crypto.randomUUID()}::uuid,${owner}::uuid,'fixture','chat','chat','fixture',${codeId},
        '{"inputPerMillion":1,"outputPerMillion":1}',1,clock_timestamp(),clock_timestamp())`;
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
    expect(await read(queued!.id)).toMatchObject({
      ok: true,
      data: { data: { message: { status: "failed", reason: "code_ai_owner_daily_budget_limit" } } },
    });
    // The refused entry holds back neither the person nor the next schedule.
    expect((await invoke(chat.shortId, personContext(), "My own question")).ok).toBeTrue();
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    const passed = await aiConversations.getLatestTurn({ conversationId: chat.id });
    expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: passed!.id })).toMatchObject({
      writerOrigin: { kind: "person", id: owner },
    });
    await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${passed!.id}::uuid`;
    await sql`DELETE FROM ai.inference_calls WHERE code_id=${codeId}`;
    expect(await invoke(chat.shortId, ctx("next-day"))).toMatchObject({ ok: true, data: { data: { status: "queued" } } });
    // Without a host check, a Code-started message waits instead of starting unchecked.
    await drainQueuedMessages(async () => {}, chat.id);
    expect((await aiConversations.getLatestTurn({ conversationId: chat.id }))?.id).toBe(passed!.id);
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect((await aiConversations.getLatestTurn({ conversationId: chat.id }))?.id).not.toBe(passed!.id);
  });
  test("a paused Code's queued message is withdrawn with its reason and blocks nothing", async () => {
    await setup();
    const sent = await invoke();
    if (!sent.ok) throw new Error(sent.error.message);
    const id = dataSchema.parse(sent.data.data).id;
    await sql`UPDATE code.codes SET state='paused' WHERE id=${codeId}`;
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
    expect(await read(id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed", reason: "code_inactive" } } } });
    // The person's keys share one space with their Codes, so the person picks a fresh key.
    expect((await invoke(chat.shortId, { ...personContext(), idempotencyKey: "still-mine" }, "Still mine")).ok).toBeTrue();
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).not.toBeNull();
  });
  /** Another enabled Code of the same person, with a running run, as a caller context. */
  const otherCode = async (n: number) => {
    const id = `c_owner${n}`;
    const version = `4f000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;
    const run = crypto.randomUUID();
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${id},'person',${owner}::uuid,${`Fictional ${n}`})
      ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      VALUES(${version}::uuid,${id},1,'{}','fixture',${"c".repeat(64)},${"d".repeat(64)},0,7) ON CONFLICT (id) DO NOTHING`;
    await sql`UPDATE code.codes SET state='active', active_version_id=${version}::uuid WHERE id=${id}`;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${run}::uuid,${id},${version}::uuid,'schedule','morning','running',32768,10)`;
    return (key: string): CapabilityExecutionContext => {
      const base = ctx(key);
      const delegation = base.actor.kind === "user" ? base.actor.delegation : undefined;
      if (!delegation) throw new Error("Missing fixture delegation");
      return { ...base, actor: { kind: "user", user, delegation: { ...delegation, workloadId: version, workloadRun: run } } };
    };
  };
  test("one open Code message per person: twenty Codes admit one, and parallel sends never deadlock", async () => {
    await setup();
    const callers = [];
    for (let n = 0; n < 20; n++) callers.push(await otherCode(n));
    const results = [];
    for (const [n, caller] of callers.entries()) results.push(await invoke(chat.shortId, caller(`owner-${n}`)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === "chat_busy")).toHaveLength(19);
    // Two sends of one Code into two chats at once take the locks in one order.
    await setup();
    const second = await aiConversations.createConversation({ ownerUserId: owner });
    const parallel = await Promise.all([invoke(chat.shortId, ctx("parallel-a")), invoke(second.shortId, ctx("parallel-b"))]);
    expect(parallel.filter((result) => result.ok)).toHaveLength(1);
    expect(parallel.find((result) => !result.ok)).toMatchObject({ ok: false, error: { code: "chat_busy" } });
  });
  test("a Code message that cannot start fails with its reason and holds nothing back", async () => {
    await setup();
    const sent = await invoke();
    if (!sent.ok) throw new Error(sent.error.message);
    const id = dataSchema.parse(sent.data.data).id;
    // The chat changes its Project while the Code message waits: the start fails for good.
    const projectId = "4f000000-0000-4000-8000-0000000004a1";
    await sql`INSERT INTO ai.projects(id,short_id,name) VALUES(${projectId}::uuid,'Proj4g','Moved Project') ON CONFLICT (id) DO NOTHING`;
    await sql`UPDATE ai.conversations SET project_id=${projectId}::uuid WHERE id=${chat.id}::uuid`;
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await read(id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed", reason: "chat_changed" } } } });
    // Refused, it no longer holds the person's other chats.
    const elsewhere = await aiConversations.createConversation({ ownerUserId: owner });
    expect((await invoke(elsewhere.shortId, ctx("after-move"))).ok).toBeTrue();
    // A Code message whose run is gone is withdrawn with its own reason.
    await setup();
    const gone = await invoke();
    if (!gone.ok) throw new Error(gone.error.message);
    await sql`DELETE FROM code.runs WHERE id=${runId}::uuid`;
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await read(dataSchema.parse(gone.data.data).id)).toMatchObject({
      ok: true,
      data: { data: { message: { status: "failed", reason: "code_run_gone" } } },
    });
  });
  test("a refused Code message lets the person finish and archive the chat", async () => {
    await setup();
    const sent = await invoke();
    if (!sent.ok) throw new Error(sent.error.message);
    await sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,kind,task,provider_model,code_id,pricing,cost,finished_at,lease_expires_at)
      VALUES(${crypto.randomUUID()}::uuid,${owner}::uuid,'fixture','chat','chat','fixture',${codeId},
        '{"inputPerMillion":1,"outputPerMillion":1}',1,clock_timestamp(),clock_timestamp())`;
    try {
      await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
      expect(await read(dataSchema.parse(sent.data.data).id)).toMatchObject({
        ok: true,
        data: { data: { message: { status: "failed" } } },
      });
      expect(await aiConversations.setConversationDone({ conversationId: chat.id, ownerUserId: owner, done: true })).toMatchObject({
        ok: true,
      });
      expect(await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: owner })).toBeTrue();
    } finally {
      await sql`DELETE FROM ai.inference_calls WHERE code_id=${codeId}`;
    }
  });
  test("a refused Code message never holds the person after archiving and restoring its chat", async () => {
    await setup();
    const first = await invoke();
    if (!first.ok) throw new Error(first.error.message);
    const m1 = dataSchema.parse(first.data.data).id;
    await sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,kind,task,provider_model,code_id,pricing,cost,finished_at,lease_expires_at)
      VALUES(${crypto.randomUUID()}::uuid,${owner}::uuid,'fixture','chat','chat','fixture',${codeId},
        '{"inputPerMillion":1,"outputPerMillion":1}',1,clock_timestamp(),clock_timestamp())`;
    try {
      await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
      expect(await read(m1)).toMatchObject({ ok: true, data: { data: { message: { status: "failed" } } } });
      // A refused automation entry leaves the chat's queue.
      expect(await listQueuedMessages(chat.id)).toEqual([]);
      expect(await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: owner })).toBeTrue();
    } finally {
      await sql`DELETE FROM ai.inference_calls WHERE code_id=${codeId}`;
    }
    const other = await aiConversations.createConversation({ ownerUserId: owner });
    expect((await invoke(other.shortId, ctx("after-archive"))).ok).toBeTrue();
    await aiConversations.restoreConversation({ conversationId: chat.id, ownerUserId: owner });
    await drainQueuedMessages(async () => {}, other.id, validateQueuedChatStart);
    expect(await aiConversations.getLatestTurn({ conversationId: other.id })).not.toBeNull();
  });
  test("a queued turn never starts in an archived chat", async () => {
    await setup();
    await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: owner });
    await expect(
      aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "fixture",
        queuedMessageId: crypto.randomUUID(),
        userMessage: { role: "user", content: [{ type: "text", text: "Late" }] },
        runConfig: { kind: "chat", input: "Late", actor: { kind: "user", user } },
      }),
    ).rejects.toThrow("archived");
  });
  test("a fixed key queues a new message once the person's 24-hour key window has passed", async () => {
    await setup();
    const first = await invoke(chat.shortId, ctx("daily-briefing"));
    if (!first.ok) throw new Error(first.error.message);
    const old = dataSchema.parse(first.data.data).id;
    // Yesterday's message ended; the same key on the next day is a new occurrence.
    await sql`UPDATE ai.queued_messages SET status='cancelled',created_at=clock_timestamp()-interval '25 hours' WHERE id=${old}::uuid`;
    // Receipts are immutable; only the fixture ages this one.
    await sql`ALTER TABLE ai.chat_send_receipts DISABLE TRIGGER chat_send_receipt_immutable`;
    await sql`UPDATE ai.chat_send_receipts SET created_at=clock_timestamp()-interval '25 hours' WHERE id=${old}::uuid`;
    await sql`ALTER TABLE ai.chat_send_receipts ENABLE TRIGGER chat_send_receipt_immutable`;
    const next = await invoke(chat.shortId, ctx("daily-briefing"), "Today's briefing.");
    expect(next.ok).toBeTrue();
    if (!next.ok) return;
    expect(dataSchema.parse(next.data.data).id).not.toBe(old);
    expect(await read(old)).toMatchObject({ ok: true, data: { data: { message: { id: old, status: "cancelled" } } } });
  });
  test("an expired Code message leaves the queue even behind a blocked person message, and a retry cannot revive it", async () => {
    await setup();
    // A person's message ahead of it failed for good and holds the chat's order.
    const blocker = crypto.randomUUID();
    await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status,error)
      VALUES(${blocker}::uuid,${chat.id}::uuid,'{"runConfig":{"kind":"chat"}}','[]','failed','dispatch_failed')`;
    const sent = await invoke();
    if (!sent.ok) throw new Error(sent.error.message);
    const id = dataSchema.parse(sent.data.data).id;
    // Still pending, never refused, but accepted on an earlier budget day.
    await sql`UPDATE ai.queued_messages SET created_at=clock_timestamp()-interval '2 days' WHERE id=${id}::uuid`;
    expect(await updateQueuedMessage(chat.id, id, "retry")).toBeFalse();
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await read(id)).toMatchObject({
      ok: true,
      data: { data: { message: { status: "failed", reason: "code_budget_day_ended" } } },
    });
    // The person's other Codes are free again.
    const other = await aiConversations.createConversation({ ownerUserId: owner });
    expect((await invoke(other.shortId, ctx("after-expiry"))).ok).toBeTrue();
    await sql`DELETE FROM ai.queued_messages WHERE id=${blocker}::uuid`;
  });
  test("one drain retires any number of expired Code messages in one statement", async () => {
    await setup();
    const sent = await invoke();
    if (!sent.ok) throw new Error(sent.error.message);
    const template = dataSchema.parse(sent.data.data).id;
    const second = await aiConversations.createConversation({ ownerUserId: owner });
    // Each chat is held by a failed person message ahead; its Code messages were accepted on an earlier budget day.
    const fill = async (conversationId: string, count: number) => {
      await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status,error)
        VALUES(${crypto.randomUUID()}::uuid,${conversationId}::uuid,'{"runConfig":{"kind":"chat"}}','[]','failed','dispatch_failed')`;
      await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status,created_at)
        SELECT gen_random_uuid(),${conversationId}::uuid,q.submission #- '{runConfig,send,keyHash}',q.content,'pending',clock_timestamp()-interval '2 days'
        FROM ai.queued_messages q CROSS JOIN generate_series(1,${count}) WHERE q.id=${template}::uuid`;
    };
    await fill(chat.id, 1);
    await fill(second.id, 6);
    // Beside them: a message whose budget day never ends, with a fine Code and run, walks every branch and
    // stays whatever the day, and a malformed run id retires its message without failing the statement.
    const [current, malformed] = [crypto.randomUUID(), crypto.randomUUID()];
    await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status,created_at)
      SELECT ${current}::uuid,${second.id}::uuid,q.submission #- '{runConfig,send,keyHash}',q.content,'pending','infinity'::timestamptz
      FROM ai.queued_messages q WHERE q.id=${template}::uuid`;
    await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status)
      SELECT ${malformed}::uuid,${second.id}::uuid,jsonb_set(q.submission #- '{runConfig,send,keyHash}','{runConfig,codeOrigin,runId}','"run-7"'),q.content,'pending'
      FROM ai.queued_messages q WHERE q.id=${template}::uuid`;
    await sql`DELETE FROM ai.queued_messages WHERE id=${template}::uuid`;
    const meter = await meterSql();
    try {
      const one = await meter.during(() => drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart));
      const six = await meter.during(() => drainQueuedMessages(async () => {}, second.id, validateQueuedChatStart));
      console.log("SQL BUDGET queue drain with expired Code messages", one.length, six.length, six);
      // In a held chat, nothing is promoted: the retirement itself and the head query, nothing per entry.
      expect(one).toHaveLength(2);
      expect(six).toHaveLength(2);
      expect(six[0]).toStartWith("WITH expired AS");
    } finally {
      await meter.close();
    }
    const left = await sql<{ id: string; status: string; error: string | null; send: boolean }[]>`
      SELECT id,status,error,submission->'runConfig' ? 'send' AS send FROM ai.queued_messages
      WHERE conversation_id IN (${chat.id}::uuid,${second.id}::uuid) AND error IS DISTINCT FROM 'dispatch_failed'`;
    const expired = left.filter((entry) => entry.id !== current && entry.id !== malformed);
    expect(expired).toHaveLength(7);
    expect(expired.every((entry) => entry.status === "failed" && entry.error === "code_budget_day_ended" && entry.send)).toBeTrue();
    expect(left.find((entry) => entry.id === current)).toMatchObject({ status: "pending", error: null });
    expect(left.find((entry) => entry.id === malformed)).toMatchObject({ status: "failed", error: "code_run_gone" });
  });
  test("a chat turn cannot send into its own chat, and an unreadable lease asks to retry", async () => {
    await setup();
    const source = await aiConversations.createConversation({ ownerUserId: owner });
    const submitted = await aiConversations.submitChatTurn({
      conversationId: source.id,
      modelId: "fixture",
      userMessage: { role: "user", content: [{ type: "text", text: "Delegate" }] },
      runConfig: {
        kind: "chat",
        input: "Delegate",
        writerOrigin: { kind: "person", id: owner },
        turnTrigger: { kind: "person", id: owner },
        actor: { kind: "user", user },
      },
    });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${submitted.turn.id}::uuid`;
    const lease = spyOn(nestedInvocationLeases, "read").mockResolvedValue({
      appId: "core",
      origin: "assistant",
      deadline: 9999999999999,
      assistantTurn: { conversationId: source.id, turnId: submitted.turn.id },
    });
    const context: CapabilityExecutionContext = {
      ...personContext(),
      origin: "assistant",
      actor: {
        kind: "user",
        user,
        delegation: { kind: "invocation", credentialKind: "session", callingAppId: "core", invocationId: "source" },
      },
    };
    expect(await invoke(source.shortId, context)).toMatchObject({ ok: false, error: { status: 400 } });
    lease.mockResolvedValue(null);
    expect(await invoke(chat.shortId, context)).toMatchObject({ ok: false, error: { code: "source_unavailable", status: 409 } });
    expect(
      await sql<{ id: string }[]>`SELECT id FROM ai.queued_messages WHERE conversation_id IN (${source.id}::uuid,${chat.id}::uuid)`,
    ).toHaveLength(0);
  });
  test("an unavailable wake-up leaves durable queued work and the draft untouched", async () => {
    await setup();
    await sql`UPDATE ai.conversations SET draft_content='[{"type":"text","text":"Unsent draft"}]'::jsonb WHERE id=${chat.id}::uuid`;
    const sent = await invoke();
    expect(sent).toMatchObject({ ok: true, data: { data: { status: "queued" } } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
    const current = await aiConversations.getConversation({ conversationId: chat.id });
    expect(current?.draft.content).toEqual([{ type: "text", text: "Unsent draft" }]);
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await aiConversations.listMessages({ conversationId: chat.id })).toHaveLength(1);
  });
  test("one pending entry per source; cancellation frees its slot and replay ignores a changed target", async () => {
    await setup();
    const first = await invoke();
    if (!first.ok) throw new Error(first.error.message);
    const sent = dataSchema.parse(first.data.data);
    expect(await invoke(chat.shortId, ctx("another-key"))).toMatchObject({ ok: false, error: { code: "chat_busy" } });
    expect(await updateQueuedMessage(chat.id, sent.id, "cancel")).toBeTrue();
    expect(await invoke(chat.shortId, ctx("another-key"))).toMatchObject({ ok: true });
    const changed = await aiConversations.createConversation({ ownerUserId: owner });
    expect(await invoke(changed.shortId)).toMatchObject({
      ok: true,
      data: { data: { id: sent.id, chatId: chat.shortId, status: "cancelled" } },
    });
    await expect(sql`UPDATE ai.chat_send_receipts SET chat_id=${changed.shortId} WHERE id=${sent.id}::uuid`.execute()).rejects.toThrow(
      "immutable",
    );
    await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
    expect(await invoke(changed.shortId)).toMatchObject({
      ok: true,
      data: { data: { id: sent.id, chatId: chat.shortId, status: "cancelled" } },
    });
    // Unattended calls are reviewed with the run's current authority first; paused Code reaches no receipt.
    await sql`UPDATE code.codes SET state='paused' WHERE id=${codeId}`;
    expect(await invoke(changed.shortId)).toMatchObject({ ok: false, error: { status: 404 } });
    expect(
      await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.queued_messages WHERE conversation_id=${changed.id}::uuid`,
    ).toEqual([{ count: 0 }]);
  });

  test("disabled Code is withdrawn permanently, frees FIFO, and does not revive when enabled", async () => {
    await setup();
    const response = await invoke();
    if (!response.ok) throw new Error(response.error.message);
    const sent = dataSchema.parse(response.data.data);
    const person = await invoke(chat.shortId, { ...personContext(), idempotencyKey: "person-after-code" }, "Person follows.");
    expect(person.ok).toBeTrue();
    await sql`UPDATE code.codes SET state='paused' WHERE id=${codeId}`;
    const jobs: unknown[] = [];
    await drainQueuedMessages(
      async (job) => {
        jobs.push(job);
      },
      chat.id,
      validateQueuedChatStart,
    );
    expect(jobs).toHaveLength(1);
    expect(await read(sent.id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed", reason: "code_inactive" } } } });
    const turn = await aiConversations.getLatestTurn({ conversationId: chat.id });
    expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: turn!.id })).toMatchObject({
      writerOrigin: { kind: "person" },
    });
    await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${turn!.id}::uuid`;
    await sql`UPDATE code.codes SET state='active' WHERE id=${codeId}`;
    await drainQueuedMessages(
      async (job) => {
        jobs.push(job);
      },
      chat.id,
      validateQueuedChatStart,
    );
    expect(jobs).toHaveLength(1);
    expect(await updateQueuedMessage(chat.id, sent.id, "retry")).toBeFalse();
  });

  test("quota refusal at queue start is terminal and permits the next source", async () => {
    await setup();
    const response = await invoke();
    if (!response.ok) throw new Error(response.error.message);
    const sent = dataSchema.parse(response.data.data);
    const assertQuota = spyOn(aiQuotas, "assertAllowed").mockRejectedValueOnce(new AiQuotaError("quota_exhausted", "Empty"));
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(assertQuota).toHaveBeenCalled();
    expect(await read(sent.id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed", reason: "quota_exhausted" } } } });
    expect(await invoke(chat.shortId, ctx("next-schedule"))).toMatchObject({ ok: true, data: { data: { status: "queued" } } });
    expect(await invoke()).toMatchObject({ ok: true, data: { data: { id: sent.id, status: "failed" } } });
  });
  test.each(["code_ai_daily_budget_limit", "model_policy_mismatch"])(
    "final %s survives day end and archiving without retaining input",
    async (reason) => {
      await setup();
      const accepted = await invoke();
      if (!accepted.ok) throw new Error(accepted.error.message);
      const id = dataSchema.parse(accepted.data.data).id;
      await drainQueuedMessages(
        async () => {},
        chat.id,
        async () => {
          throw new AiQueuedChatStartError(reason);
        },
      );
      const final = async (legacy = false) => {
        const [row] = await sql`SELECT status,error,content,submission FROM ai.queued_messages WHERE id=${id}::uuid`;
        expect(row).toMatchObject({
          status: "failed",
          error: reason,
          content: [],
          submission: { runConfig: { send: { id }, turnTrigger: { kind: "automation" } } },
        });
        expect(Object.keys(row!.submission.runConfig).sort()).toEqual(
          legacy ? ["codeOrigin", "send", "turnTrigger"] : ["send", "turnTrigger"],
        );
      };
      await final();
      // Older failed rows retain Code attribution. Day-end and archive must preserve these too.
      await sql`UPDATE ai.queued_messages SET submission=jsonb_set(submission,'{runConfig,codeOrigin}',
        (${JSON.stringify({ codeId, runId })}::text)::jsonb) WHERE id=${id}::uuid`;
      await sql`UPDATE ai.queued_messages SET created_at=clock_timestamp()-interval '2 days' WHERE id=${id}::uuid`;
      await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
      await final(true);
      expect(await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: owner })).toBeTrue();
      await final(true);
      expect(await read(id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed", reason } } } });
    },
  );

  test("queue start takes the owner lock before the Code row during overlapping send admission", async () => {
    await setup();
    expect((await invoke()).ok).toBeTrue();
    type Outcome = { ok: true } | { ok: false; error: unknown };
    let drain: Promise<Outcome> | undefined;
    try {
      await sql.begin(async (send) => {
        await send`SET LOCAL lock_timeout='3s'`;
        await lockOwnerCodeChats(owner, send);
        const [session] = await send<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        drain = drainQueuedMessages(
          async () => {},
          chat.id,
          async (...args) => {
            await args[1]`SET LOCAL lock_timeout='3s'`;
            return validateQueuedChatStart(...args);
          },
        ).then(
          (): Outcome => ({ ok: true }),
          (error: unknown): Outcome => ({ ok: false, error }),
        );
        for (let waited = 0; ; waited++) {
          const [blocked] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE ${session!.pid}::int=ANY(pg_blocking_pids(pid))`;
          if (blocked?.count) break;
          if (waited > 200) throw new Error("The dispatcher never waited for the owner lock");
          await Bun.sleep(10);
        }
        // The old start held a Code SHARE lock while waiting for the owner: this UPDATE deadlocked.
        await send`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
      });
    } finally {
      await drain;
    }
    expect(await drain).toEqual({ ok: true });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).not.toBeNull();
  });

  test("queue start never waits for a reviewer holding Code before taking the chat", async () => {
    await setup();
    const accepted = await invoke();
    if (!accepted.ok) throw new Error(accepted.error.message);
    const id = dataSchema.parse(accepted.data.data).id;
    await sql.begin(async (review) => {
      await review`SET LOCAL lock_timeout='3s'`;
      await review`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
      // NOWAIT rolls back the attempt and releases its chat lock before the reviewer needs it.
      let refusal: unknown;
      await drainQueuedMessages(
        async () => {},
        chat.id,
        async (...args) => {
          await args[1]`SET LOCAL lock_timeout='3s'`;
          try {
            return await validateQueuedChatStart(...args);
          } catch (error) {
            refusal = error;
            throw error;
          }
        },
      );
      expect(refusal).toBeInstanceOf(Error);
      if (!(refusal instanceof Error)) throw new Error("The Code lock was not refused");
      expect(refusal.message).toContain("could not obtain lock");
      await review`SELECT id FROM ai.conversations WHERE id=${chat.id}::uuid FOR UPDATE`;
    });
    expect(Array.from(await sql`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`)).toMatchObject([
      { status: "pending", error: null },
    ]);
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).not.toBeNull();
  });

  test("send refuses a reviewer's Code lock promptly and accepts a retry with the same key", async () => {
    await setup();
    type Outcome = { result: Awaited<ReturnType<typeof invoke>> } | { error: unknown };
    let outcome: Outcome | undefined;
    let whileLocked: Outcome | undefined;
    let sending: Promise<void> | undefined;
    const context = ctx("reviewer-contention");
    try {
      await sql.begin(async (review) => {
        await review`SET LOCAL lock_timeout='3s'`;
        await review`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
        const [session] = await review<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        sending = invoke(chat.shortId, context).then(
          (result) => {
            outcome = { result };
          },
          (error: unknown) => {
            outcome = { error };
          },
        );
        for (let waited = 0; !outcome; waited++) {
          const [blocked] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE ${session!.pid}::int=ANY(pg_blocking_pids(pid))`;
          if (blocked?.count) break;
          if (waited > 200) throw new Error("Send neither refused nor waited for the reviewer's Code lock");
          await Bun.sleep(10);
        }
        whileLocked = outcome;
        // A refusal has rolled back its Chat lock, so the reviewer can safely take it next.
        if (whileLocked) await review`SELECT id FROM ai.conversations WHERE id=${chat.id}::uuid FOR UPDATE`;
      });
    } finally {
      await sending;
    }
    expect(whileLocked).toMatchObject({ result: { ok: false, error: { code: "chat_busy", status: 409 } } });
    expect(await sql`SELECT id FROM ai.chat_send_receipts WHERE conversation_id=${chat.id}::uuid`).toHaveLength(0);
    const accepted = await invoke(chat.shortId, context);
    expect(accepted.ok).toBeTrue();
    if (!accepted.ok) throw new Error(accepted.error.message);
    const id = dataSchema.parse(accepted.data.data).id;
    const replayed = await invoke(chat.shortId, context);
    expect(replayed).toMatchObject({ ok: true, data: { data: { id } } });
    expect(await sql`SELECT id FROM ai.chat_send_receipts WHERE conversation_id=${chat.id}::uuid`).toHaveLength(1);
  });

  test("unknown Code start errors stop retrying at the existing budget-day expiry", async () => {
    await setup();
    const accepted = await invoke();
    if (!accepted.ok) throw new Error(accepted.error.message);
    const id = dataSchema.parse(accepted.data.data).id;
    await drainQueuedMessages(
      async () => {},
      chat.id,
      async () => {
        throw new TypeError("Transient provider setup");
      },
    );
    expect(await read(id)).toMatchObject({ ok: true, data: { data: { message: { status: "queued", reason: "dispatch_failed" } } } });
    await sql`UPDATE ai.queued_messages SET created_at=clock_timestamp()-interval '2 days' WHERE id=${id}::uuid`;
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await read(id)).toMatchObject({ ok: true, data: { data: { message: { status: "failed", reason: "code_budget_day_ended" } } } });
  });

  test("composer settings and catalog prefetch do not hold the chat lock", async () => {
    const { readSettings } = await setup();
    expect((await invoke(chat.shortId, personContext())).ok).toBeTrue();
    readSettings.mockImplementation(async (db) => {
      expect(db).toBeUndefined();
      await sql.begin(async (probe) => {
        await probe`SET LOCAL lock_timeout='3s'`;
        await probe`SELECT id FROM ai.conversations WHERE id=${chat.id}::uuid FOR UPDATE`;
      });
      return aiSettingsFixture({ profiles: [aiModelFixture({ id: "fixture" })] });
    });
    const jobs: string[] = [];
    await drainQueuedMessages(
      async (job) => {
        jobs.push(job.turnId);
      },
      chat.id,
      validateQueuedChatStart,
    );
    expect(jobs).toHaveLength(1);
  });

  test("dequeue uses one real catalog snapshot and current model grants under its transaction", async () => {
    const { readSettings, selectModel } = await setup();
    await aiModelCatalog.createProvider({ id: "queue-provider", type: "ollama", label: "Queue fixture", dataBoundary: "private" }, owner);
    await aiModelCatalog.createModels(
      "queue-provider",
      [{ id: "fixture", label: "Queue fixture", providerModel: "fixture", capabilities: ["tools"] }],
      owner,
    );
    const accepted = await invoke();
    expect(accepted.ok).toBeTrue();
    readSettings.mockRestore();
    selectModel.mockRestore();
    const meter = await meterSql();
    const jobs: string[] = [];
    try {
      const statements = await meter.during(() =>
        drainQueuedMessages(
          async (job) => {
            jobs.push(job.turnId);
          },
          chat.id,
          validateQueuedChatStart,
        ),
      );
      expect(jobs).toHaveLength(1);
      // The native catalog is read once per start and shared with access selection and quotas.
      for (const table of ["providers", "models", "model_variants", "model_assignments"])
        expect(statements.filter((text) => text.includes(`FROM ai.${table} `))).toHaveLength(1);
      expect(statements.filter((text) => /^BEGIN\b/i.test(text))).toHaveLength(1);
    } finally {
      await meter.close();
    }
    await sql`UPDATE ai.turns SET status='completed',completed_at=clock_timestamp() WHERE id=${jobs[0]}::uuid`;
    const pending = await invoke(chat.shortId, ctx("revoked-model"));
    if (!pending.ok) throw new Error(pending.error.message);
    await sql`DELETE FROM auth.access WHERE id IN(SELECT access_id FROM ai.model_access WHERE model_id='fixture')`;
    await drainQueuedMessages(async () => {}, chat.id, validateQueuedChatStart);
    expect(await read(dataSchema.parse(pending.data.data).id)).toMatchObject({
      ok: true,
      data: { data: { message: { status: "failed", reason: "model_policy_mismatch" } } },
    });
  });
});
