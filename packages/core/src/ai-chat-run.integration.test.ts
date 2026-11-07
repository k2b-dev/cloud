import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { AiQuotaError, aiConversations, createAiProvider } from "@k2b/cloud/ai";
import * as runtime from "@k2b/cloud/ai/runtime";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import { z } from "zod";
import { useTestAppRegistry } from "../../../scripts/fixtures/app-registry";
import {
  AiTurnExecutor,
  aiAssignmentFixture,
  aiModelFixture,
  aiSettingsFixture,
  compileCapabilities,
  invokeCompiledCapability,
} from "../../../scripts/fixtures/code-platform";
import { suiteFor, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { aiChatRunAction } from "./ai-chat-run";
import { aiCapabilities } from "./capabilities";
import { codeSettings } from "./code/settings";

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
const action = compiled.actions.get("ai.chat.run")!;
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
    localId: "ai.chat.run",
    target: { type: "core.ai.chat", id: chatId },
    input: { prompt, context: "Fictional source" },
    expectedSchemaHash: action.manifest.schemaHash,
    context,
  });
const read = (id: string, context = ctx()) =>
  invokeCompiledCapability({
    compiled,
    kind: "query",
    localId: "ai.chat.run.read",
    target: { type: "core.ai.chat", id: chat.shortId },
    input: { id },
    expectedSchemaHash: compiled.queries.get("ai.chat.run.read")!.manifest.schemaHash,
    context,
  });
const dataSchema = aiChatRunAction.data;
const start = async (context = ctx()) => {
  const response = await invoke(chat.shortId, context);
  expect(response.ok).toBeTrue();
  if (!response.ok) throw new Error(response.error.message);
  return dataSchema.parse(response.data.data);
};

suiteFor(
  "database",
  "valkey",
  "nats",
)("personal Code starts Gustav turns", () => {
  useTestAppRegistry(["core", "assistant"]);
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  beforeAll(async () => {
    database = await useMigratedDatabase("code_chat_run");
    for (const id of [owner, other]) await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Morning review')`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      VALUES(${versionId}::uuid,${codeId},1,'{}','fixture',${"a".repeat(64)},${"b".repeat(64)},0,7)`;
  }, 30_000);
  afterAll(async () => {
    await database?.drop();
  });
  afterEach(() => mock.restore());

  const setup = async () => {
    runId = `4f000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${runId}::uuid,${codeId},${versionId}::uuid,'schedule','morning','running',32768,10)`;
    chat = await aiConversations.createConversation({ ownerUserId: owner });
    foreign = await aiConversations.createConversation({ ownerUserId: other });
    await sql`DELETE FROM code.ai_daily_budget`;
    spyOn(codeSettings, "get").mockResolvedValue(1);
    spyOn(coreSettings, "get").mockResolvedValue("UTC");
    const prepareTurn: typeof runtime.prepareAiChatTurn = async (input) => ({
      conversationId: input.conversationId,
      modelId: "fixture",
      userMessage: input.userMessage,
      truncateFromSeq: undefined,
      expectedDraftRevision: undefined,
      expectedProjectId: undefined,
      resources: undefined,
      retrySourceTurnId: undefined,
      runConfig: {
        kind: "chat",
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
    const enqueue = spyOn(runtime, "enqueueExistingAiTurn").mockResolvedValue(undefined);
    return { prepare, enqueue, prepareTurn };
  };

  test("owner starts one turn; retry creates no duplicate and preserves Code origin in the chat and run", async () => {
    const { prepare } = await setup();
    const results = await Promise.all([invoke(), invoke()]);
    expect(results[0]).toMatchObject({
      ok: true,
      data: {
        data: {
          status: "queued",
          chatId: chat.shortId,
          origin: { codeId, title: "Morning review", runId, label: "Started by Code Morning review", requestId: "chat-run-test" },
        },
      },
    });
    expect(results[1]).toEqual(results[0]);
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
    });
    expect(config && "mandate" in config ? config.mandate : undefined).toBeUndefined();
    expect(config && "background" in config ? config.background : undefined).toBeUndefined();
    // An existing receipt remains readable even if model resolution or quota now refuses new work.
    prepare.mockRejectedValue(new AiQuotaError("quota_exhausted", "Empty"));
    expect(await invoke()).toEqual(results[0]);
    expect(await invoke(chat.shortId, ctx(), "Changed instructions")).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    const [debit] = await sql<{ cost: string }[]>`SELECT ai_reference_cost::text AS cost FROM code.runs WHERE id=${runId}::uuid`;
    expect(Number(debit?.cost)).toBe(1);
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
        accessSubject: { type: "user", userId: other },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await aiConversations.listMessages({ conversationId: chat.id })).toHaveLength(0);
  });

  test("resource-owned and non-Code callers are refused before preparation", async () => {
    const { prepare } = await setup();
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(kind,name,status) VALUES('code','code:spaces.space:4f','active') RETURNING id`;
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
    expect(await invoke(chat.shortId, { ...context, actor: { kind: "user", user } })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  test("owner quota and existing Code daily budgets refuse with stable budget codes", async () => {
    const { prepare } = await setup();
    prepare.mockRejectedValueOnce(new AiQuotaError("quota_exhausted", "The allowance is exhausted"));
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "quota_exhausted" } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
    const [day] = await sql<{ day: string }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`;
    await sql`INSERT INTO code.ai_daily_budget(day,scope_kind,scope_key,reference_cost)
      VALUES(${day!.day}::date,'owner',json_build_array('person',${owner}::uuid)::text,1)`;
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "code_ai_owner_daily_budget_limit" } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat.id })).toBeNull();
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

  test.each(["pending", "failed"] as const)("a %s queued message refuses admission without spending or discarding it", async (status) => {
    await setup();
    const id = "4f000000-0000-4000-8000-000000000009";
    await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status)
      VALUES(${id}::uuid,${chat.id}::uuid,'{}','[]',${status})`;
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "chat_busy", status: 409 } });
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
    expect(pending.origin.label).toBe("Gestartet von Code Morning review");
    const turn = await aiConversations.getTurnByShortId({ conversationId: chat.id, shortId: pending.id });
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
      expect(await invoke()).toMatchObject({ ok: true, data: { data: { id: pending.id, status: "waiting_for_approval" } } });
      expect(await read(pending.id)).toMatchObject({ ok: true, data: { data: { status: "waiting_for_approval" } } });
      expect(await aiConversations.listPendingTurnActions({ conversationId: chat.id, turnId: turn!.id })).toMatchObject([
        { type: "approval_request" },
      ]);
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id=${chat.id}::uuid`;
      expect(count?.count).toBe(1);
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("a failed enqueue retains one recoverable turn and a busy chat preserves the draft", async () => {
    const { enqueue } = await setup();
    enqueue.mockRejectedValue(new Error("Queue unavailable"));
    await start();
    const nextKey = { ...ctx("another") };
    expect(await invoke(chat.shortId, nextKey)).toMatchObject({ ok: false, error: { code: "chat_busy" } });
    expect(await aiConversations.listMessages({ conversationId: chat.id })).toHaveLength(1);
  });
});
