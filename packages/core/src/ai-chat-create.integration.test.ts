import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations, aiProjects } from "@k2b/cloud/ai";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { nestedInvocationLeases } from "@k2b/cloud/services/identity";
import { compileCapabilities, invokeCompiledCapability } from "../../../scripts/fixtures/code-platform";
import { suiteFor, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { aiChatCreateAction } from "./ai-chat-create";
import { aiCapabilities } from "./capabilities";

const owner = "5b000000-0000-4000-8000-000000000001";
const other = "5b000000-0000-4000-8000-000000000002";
const versionId = "5b000000-0000-4000-8000-000000000003";
const codeId = "c_chatcreate5b";
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
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,${owner},'local','user')`;
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
    const chat = await aiConversations.getConversationByShortId({ chatId: first.chat.id, ownerUserId: owner });
    expect(chat).toMatchObject({ title: "Weekly briefing", createdByUserId: owner, projectId: null, draft: { content: [] } });
    expect(await aiConversations.getLatestTurn({ conversationId: chat!.id })).toBeNull();
    expect(await invoke(context, "Different title")).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
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
    const secondCodeId = "c_chatcreateother5b";
    const secondVersionId = "5b000000-0000-4000-8000-000000000004";
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${secondCodeId},'person',${owner}::uuid,'Second create fixture')`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes)
      SELECT ${secondVersionId}::uuid,${secondCodeId},1,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes
      FROM code.versions WHERE id=${versionId}::uuid`;
    await sql`UPDATE code.codes SET state='active',active_version_id=${secondVersionId}::uuid WHERE id=${secondCodeId}`;
    const [otherRun] = await sql<{ id: string }[]>`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${secondCodeId},${secondVersionId}::uuid,'schedule','fixture','running',32768,10) RETURNING id`;
    expect(
      await created({
        ...context,
        actor: { ...context.actor, delegation: { ...context.actor.delegation, workloadId: secondVersionId, workloadRun: otherRun!.id } },
      }),
    ).toEqual(first);
    expect(await created({ ...person(), idempotencyKey: context.idempotencyKey })).toEqual(first);
  });
  test.each(["archived", "deleted"])("a %s creation is never replaced on replay", async (state) => {
    const context = { ...person(), idempotencyKey: `unavailable-${state}` };
    const first = await created(context);
    if (state === "archived") await sql`UPDATE ai.conversations SET archived_at='2026-11-15T12:00:00Z' WHERE short_id=${first.chat.id}`;
    else await sql`DELETE FROM ai.conversations WHERE short_id=${first.chat.id}`;
    expect(await invoke(context)).toMatchObject({ ok: false, error: { code: "chat_unavailable" } });
    const [receipt] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM ai.conversation_creations WHERE owner_user_id=${owner}::uuid`;
    expect(receipt!.count).toBeGreaterThan(0);
  });
  test("Gustav shares Code's creation key; chains and restricted source turns are refused", async () => {
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
    const fromCode = await created({ ...ctx(), idempotencyKey: "gustav-code-shared" });
    expect(await created({ ...context, idempotencyKey: "gustav-code-shared" })).toEqual(fromCode);
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
  test("Project creation checks current owner grants and keeps the selected Project", async () => {
    const context = { ...person(), idempotencyKey: "project-chat" };
    const project = await aiProjects.create({ subject: context, name: "Briefing project" });
    const input = { title: "Project briefing", project: { type: "core.ai.project" as const, id: project.shortId } };
    const response = await aiChatCreateAction.run(input, context);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const chat = await aiConversations.getConversationByShortId({ chatId: response.data.data.chat.id, ownerUserId: owner });
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
