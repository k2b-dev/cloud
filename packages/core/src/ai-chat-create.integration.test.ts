import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations, aiProjects, createAiProvider } from "@k2b/cloud/ai";
import * as runtime from "@k2b/cloud/ai/runtime";
import { dispatchCapability } from "@k2b/cloud/api";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { nestedInvocationLeases, signInvocationToken } from "@k2b/cloud/services/identity";
import { decodeJwt, generateKeyPair } from "jose";
import {
  aiModelFixture,
  aiModelSettings,
  aiSettingsFixture,
  compileCapabilities,
  drainQueuedMessages,
  enrichDirtyAiConversations,
  invokeCompiledCapability,
  reviewCompiledCapability,
  serializeCapabilityProviderResult,
} from "../../../scripts/fixtures/code-platform";
import { suiteFor, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { aiChatCreateAction } from "./ai-chat-create";
import { aiChatSendAction } from "./ai-chat-send";
import { aiCapabilities } from "./capabilities";
import { CodeIdSchema } from "./code/contracts";

const owner = "5b000000-0000-4000-8000-000000000001";
const other = "5b000000-0000-4000-8000-000000000002";
const versionId = "5b000000-0000-4000-8000-000000000003";
const codeId = CodeIdSchema.parse("c_chatcreate5b");
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
let runId: string;
const compiled = compileCapabilities("core", aiCapabilities);
const action = compiled.actions.get("ai.chat.create")!;
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

const invoke = (context = ctx(), title = "Weekly briefing") =>
  invokeCompiledCapability({
    compiled,
    kind: "action",
    localId: "ai.chat.create",
    input: { title },
    expectedSchemaHash: action.manifest.schemaHash,
    context,
  });
const person = (): CapabilityExecutionContext => ({ ...ctx(), actor: { kind: "user", user } });
const created = async (context: CapabilityExecutionContext) => {
  const response = await invoke(context);
  if (!response.ok) throw new Error(response.error.message);
  return aiChatCreateAction.data.parse(response.data.data);
};

suiteFor(
  "database",
  "valkey",
  "nats",
)("authorized idempotent chat creation", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  beforeAll(async () => {
    database = await useMigratedDatabase("code_chat_create");
    await sql`INSERT INTO auth.users(id,uid,provider,profile)
      VALUES(${owner}::uuid,${owner},'local','user'),(${other}::uuid,${other},'local','user')`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Create fixture')`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      VALUES(${versionId}::uuid,${codeId},1,'{}','fixture',${"a".repeat(64)},${"b".repeat(64)},0,7)`;
    await sql`UPDATE code.codes SET state='active',active_version_id=${versionId}::uuid WHERE id=${codeId}`;
    const [run] = await sql<{ id: string }[]>`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${codeId},${versionId}::uuid,'schedule','fixture','running',32768,10) RETURNING id`;
    runId = run!.id;
  });
  afterEach(() => mock.restore());
  afterAll(async () => {
    await database?.drop();
  });

  test("a person creates once across concurrent requests; changed input conflicts", async () => {
    const context = { ...person(), idempotencyKey: "concurrent-creation" };
    const [first, second] = await Promise.all([created(context), created(context)]);
    expect(second).toEqual(first);
    const chat = await aiConversations.getConversationByShortId({ shortId: first.chat.id, ownerUserId: owner });
    expect(chat).toMatchObject({
      title: "Weekly briefing",
      titleSource: "user",
      createdByUserId: owner,
      projectId: null,
      draft: { content: [] },
    });
    expect(await aiConversations.getLatestTurn({ conversationId: chat!.id })).toBeNull();
    const [receipt] = await sql<
      { input_hash: string }[]
    >`SELECT input_hash FROM ai.conversation_creations WHERE conversation_id=${chat!.id}::uuid`;
    // The pre-fix receipt hash: title ownership metadata must not change replay identity.
    expect(receipt?.input_hash).toBe("c3f8aafc6f92475f570b52fa7625097f1a7add35541b1ba0ec0681ee66c6b377");
    expect(await invoke(context, "Different title")).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  });
  test("create then send and background enrichment preserve the chosen title", async () => {
    const context = { ...person(), idempotencyKey: "preserve-title" };
    const first = await created(context);
    const chat = await aiConversations.getConversationByShortId({ shortId: first.chat.id, ownerUserId: owner });
    if (!chat) throw new Error("Missing created chat");
    const profile = aiModelFixture({ id: "fixture" });
    spyOn(aiModelSettings, "readAiSettingsState").mockResolvedValue(aiSettingsFixture({ profiles: [profile] }));
    spyOn(runtime, "wakeAiMessageQueue").mockImplementation(() => {});
    spyOn(runtime, "prepareAiChatTurn").mockImplementation(async (input) => ({
      conversationId: input.conversationId,
      modelId: "fixture",
      userMessage: input.userMessage,
      truncateFromSeq: input.truncateFromSeq,
      expectedDraftRevision: input.expectedDraftRevision,
      expectedProjectId: input.expectedProjectId,
      resources: input.resources,
      retrySourceTurnId: input.retrySourceTurnId,
      runConfig: {
        kind: "chat",
        chatId: input.chatId,
        input: input.input,
        actor: input.actor,
        turnTrigger: input.turnTrigger,
        send: input.send,
        writerOrigin: input.writerOrigin,
        assistantChat: true,
      },
    }));
    const sent = await aiChatSendAction.run(
      { text: "A completely different topic" },
      {
        ...context,
        idempotencyKey: "preserve-title:first-message",
        target: first.chat,
      },
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error.message);
    await drainQueuedMessages(async () => {}, chat.id);
    expect(await aiConversations.listMessages({ conversationId: chat.id })).toHaveLength(1);
    expect(await aiConversations.getConversation({ conversationId: chat.id, ownerUserId: owner })).toMatchObject({
      title: "Weekly briefing",
      titleSource: "user",
    });
    await sql`UPDATE ai.turns SET status='completed',completed_at='2026-11-15T12:00:00Z' WHERE conversation_id=${chat.id}::uuid`;
    const enriched = await enrichDirtyAiConversations({
      conversationId: chat.id,
      deps: {
        resolveModel: async () => ({ model: { id: profile.id }, profile, provider: createAiProvider(profile) }),
        readAdditionalInstructions: async () => "",
        structured: async (input) => ({
          output: input.output.parse({
            summary: "Different subject.",
            keywords: ["different"],
            title: "Replacement title",
            topicChanged: true,
          }),
          model: { id: profile.id },
          structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
        }),
      },
    });
    expect(enriched).toMatchObject({ enriched: 1, titlesUpdated: 0, failed: 0 });
    expect(await aiConversations.getConversation({ conversationId: chat.id, ownerUserId: owner })).toMatchObject({
      title: "Weekly briefing",
      titleSource: "user",
      description: "Different subject.",
    });
    expect(await created(context)).toEqual(first);
  });
  test("personal Codes and the person share the creation key across separate running executions", async () => {
    const context = { ...ctx(), idempotencyKey: "code-creation" };
    const first = await created(context);
    const [run] = await sql<{ id: string }[]>`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${codeId},${versionId}::uuid,'schedule','fixture','running',32768,10) RETURNING id`;
    if (context.actor.kind !== "user" || !context.actor.delegation) throw new Error("Missing Code fixture");
    const second = await created({
      ...context,
      actor: { ...context.actor, delegation: { ...context.actor.delegation, workloadRun: run!.id } },
    });
    expect(second).toEqual(first);
    const secondCodeId = CodeIdSchema.parse("c_chatother5b");
    const secondVersionId = "5b000000-0000-4000-8000-000000000004";
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${secondCodeId},'person',${owner}::uuid,'Second create fixture')`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      SELECT ${secondVersionId}::uuid,${secondCodeId},1,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes
      FROM code.versions WHERE id=${versionId}::uuid`;
    await sql`UPDATE code.codes SET state='active',active_version_id=${secondVersionId}::uuid WHERE id=${secondCodeId}`;
    const [otherRun] = await sql<
      { id: string }[]
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${secondCodeId},${secondVersionId}::uuid,'schedule','fixture','running',32768,10) RETURNING id`;
    expect(
      await created({
        ...context,
        actor: { ...context.actor, delegation: { ...context.actor.delegation, workloadId: secondVersionId, workloadRun: otherRun!.id } },
      }),
    ).toEqual(first);
    expect(await created({ ...person(), idempotencyKey: context.idempotencyKey })).toEqual(first);
  });
  test("the same creation key belongs to each person independently", async () => {
    const first = await created({ ...person(), idempotencyKey: "per-person" });
    const otherUser = { ...user, id: other };
    const actor = { kind: "user" as const, user: otherUser };
    const accessSubject = { type: "user" as const, userId: other };
    const second = await created({
      ...person(),
      idempotencyKey: "per-person",
      user: otherUser,
      actor,
      accessSubject,
      authority: { actor, accessSubject, credentialKind: "session", scopes: [] },
    });
    expect(second.chat.id).not.toBe(first.chat.id);
  });
  test.each(["archived", "deleted"])("a %s creation is never replaced on replay", async (state) => {
    const context = { ...person(), idempotencyKey: `unavailable-${state}` };
    const first = await created(context);
    const chat = await aiConversations.getConversationByShortId({ shortId: first.chat.id, ownerUserId: owner });
    const [receipt] = await sql<{ request_id: string }[]>`SELECT request_id FROM ai.conversation_creations
      WHERE owner_user_id=${owner}::uuid AND conversation_id=${chat!.id}::uuid`;
    expect(receipt).toBeDefined();
    if (state === "archived") await sql`UPDATE ai.conversations SET archived_at='2026-11-15T12:00:00Z' WHERE short_id=${first.chat.id}`;
    else await sql`DELETE FROM ai.conversations WHERE short_id=${first.chat.id}`;
    expect(await invoke(context)).toMatchObject({ ok: false, error: { code: "chat_unavailable" } });
    const [kept] = await sql<{ conversation_id: string | null }[]>`SELECT conversation_id FROM ai.conversation_creations
      WHERE owner_user_id=${owner}::uuid AND request_id=${receipt!.request_id}::uuid`;
    expect(kept).toEqual({ conversation_id: state === "deleted" ? null : chat!.id });
  });
  test("a person-triggered Gustav invocation can create; chains and restricted source turns are refused", async () => {
    const source = await aiConversations.createConversation({ ownerUserId: owner });
    const submitted = await aiConversations.submitChatTurn({
      conversationId: source.id,
      modelId: "fixture",
      userMessage: { role: "user", content: [{ type: "text", text: "Create a chat" }] },
      runConfig: { kind: "chat", input: "Create a chat", turnTrigger: { kind: "person", id: owner }, actor: { kind: "user", user } },
    });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${submitted.turn.id}::uuid`;
    spyOn(nestedInvocationLeases, "read").mockResolvedValue({
      appId: "core",
      origin: "assistant",
      deadline: 9999999999999,
      assistantTurn: { conversationId: source.id, turnId: submitted.turn.id },
    });
    const context: CapabilityExecutionContext = {
      ...person(),
      origin: "assistant",
      actor: {
        kind: "user",
        user,
        delegation: { kind: "invocation", credentialKind: "session", callingAppId: "core", invocationId: "creation-source" },
      },
    };
    expect(await invoke({ ...context, idempotencyKey: "gustav-creation" })).toMatchObject({ ok: true });
    for (const trigger of [{ kind: "automation", id: codeId }, { kind: "chat", id: source.shortId }, null]) {
      await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{turnTrigger}',${JSON.stringify(trigger)}::text::jsonb) WHERE id=${submitted.turn.id}::uuid`;
      expect(await invoke(context)).toMatchObject({ ok: false, error: { code: "chat_chain_forbidden" } });
    }
    await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{turnTrigger}',${JSON.stringify({ kind: "person", id: owner })}::text::jsonb) WHERE id=${submitted.turn.id}::uuid`;
    await sql`UPDATE ai.conversations SET allowed_tools=ARRAY[]::text[] WHERE id=${source.id}::uuid`;
    expect(await invoke(context)).toMatchObject({ ok: false, error: { code: "source_restricted" } });
    await sql`UPDATE ai.conversations SET allowed_tools=NULL WHERE id=${source.id}::uuid`;
    await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{sourceRestricted}','true'::jsonb) WHERE id=${submitted.turn.id}::uuid`;
    expect(await invoke(context)).toMatchObject({ ok: false, error: { code: "source_restricted" } });
  });
  test("a Gustav turn reviews and creates a chat through the real dispatch and its nested-invocation lease", async () => {
    const source = await aiConversations.createConversation({ ownerUserId: owner });
    const submitted = await aiConversations.submitChatTurn({
      conversationId: source.id,
      modelId: "fixture",
      userMessage: { role: "user", content: [{ type: "text", text: "Open a new chat" }] },
      runConfig: { kind: "chat", input: "Open a new chat", turnTrigger: { kind: "person", id: owner }, actor: { kind: "user", user } },
    });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${submitted.turn.id}::uuid`;
    const { privateKey } = await generateKeyPair("RS256");
    const turn = { conversationId: source.id, turnId: submitted.turn.id };
    const input = { title: "Gustav briefing" };
    const reviews: string[] = [];
    // What the AI executor dispatches for the turn's review and run: the owner's session authority, no reusable proof.
    const dispatch = (review: boolean, assistantTurn?: typeof turn) =>
      dispatchCapability({
        request: new Request("http://cloud.internal/api/ai/capability", {
          method: "POST",
          headers: review ? {} : { "idempotency-key": "gustav-real-dispatch" },
        }),
        kind: "actions",
        review,
        origin: "assistant",
        ...(assistantTurn ? { assistantTurn } : {}),
        appId: "core",
        capabilityId: "ai.chat.create",
        input,
        authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: owner }, credentialKind: "session", scopes: [] },
        dependencies: {
          getCapability: async () => ({
            appId: "core",
            appName: "Core",
            appIcon: "ti ti-cloud",
            appDescription: "",
            endpoint: "http://core.test/api/_internal/capabilities/v1",
            manifest: compiled.manifest,
          }),
          signInvocation: signInvocationToken,
          withActiveSigner: async (_purpose, use) =>
            use(
              { kid: "gustav", key: privateKey, issuer: "https://cloud.test", signUntil: new Date(Date.now() + 60_000), groupsAdmin: [] },
              sql,
            ),
          // Core receives the signed invocation; its delegation names the token, and the action reads the stored lease.
          fetch: async (url, init) => {
            const token = new Request(url, init).headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
            const context: CapabilityExecutionContext = {
              ...person(),
              origin: "assistant",
              idempotencyKey: review ? undefined : "gustav-real-dispatch",
              actor: {
                kind: "user",
                user,
                delegation: {
                  kind: "invocation",
                  credentialKind: "session",
                  callingAppId: "core",
                  invocationId: String(decodeJwt(token).jti),
                },
              },
            };
            const result = review
              ? await reviewCompiledCapability({
                  compiled,
                  localId: "ai.chat.create",
                  input,
                  expectedSchemaHash: action.manifest.schemaHash,
                  context,
                })
              : await invoke(context, input.title);
            if (review) reviews.push(result.ok ? "ok" : result.error.code);
            const serialized = serializeCapabilityProviderResult(result, { review, nonIdempotentAction: false });
            return new Response(serialized.body, { status: serialized.status, headers: { "content-type": "application/json" } });
          },
        },
      });
    // Without its turn the call has no source the target can check: refused, never a chat.
    const unbound = await dispatch(true);
    expect({ status: unbound.status, code: ((await unbound.json()) as { code?: string }).code }).toEqual({
      status: 409,
      code: "source_unavailable",
    });
    await dispatch(true, turn);
    // Core decides on the source: refused without the turn, allowed with it. The transport check of the review
    // view needs the registered presentation and is covered by the capability suites.
    expect(reviews).toEqual(["source_unavailable", "ok"]);
    const response = await dispatch(false, turn);
    const body = (await response.json()) as { data?: { chat?: { id?: string } }; code?: string };
    expect({ status: response.status, code: body.code }).toEqual({ status: 200, code: undefined });
    const chat = await aiConversations.getConversationByShortId({ shortId: body.data!.chat!.id!, ownerUserId: owner });
    expect(chat).toMatchObject({ title: "Gustav briefing", createdByUserId: owner });
  });
  test("Project creation checks current owner grants and keeps the selected Project", async () => {
    const context = { ...person(), idempotencyKey: "project-chat" };
    const project = await aiProjects.create({ subject: context, name: "Briefing project" });
    const input = { title: "Project briefing", project: { type: "core.ai.project" as const, id: project.shortId } };
    const response = await aiChatCreateAction.run(input, context);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const chat = await aiConversations.getConversationByShortId({ shortId: response.data.data.chat.id, ownerUserId: owner });
    expect(chat?.projectId).toBe(project.id);
    await sql`DELETE FROM ai.project_access WHERE project_id=${project.id}::uuid`;
    expect(await aiChatCreateAction.run(input, context)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("app sessions and service-account subjects cannot create personal chats", async () => {
    expect(await invoke({ ...person(), actor: { kind: "user", user, sessionKind: "app" } })).toMatchObject({
      ok: false,
      error: { code: "source_restricted" },
    });
    expect(
      await invoke({
        ...person(),
        user: null,
        authority: undefined,
        actor: {
          kind: "service_account",
          scopes: [],
          delegatedUser: null,
          serviceAccount: {
            id: other,
            name: "Mailbox Code",
            kind: "code",
            status: "active",
            delegatedUserId: null,
            appId: null,
            resourceType: null,
            resourceId: null,
            createdBy: null,
            createdAt: "2026-11-15T12:00:00Z",
          },
        },
        accessSubject: { type: "service_account", serviceAccountId: other },
      }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
