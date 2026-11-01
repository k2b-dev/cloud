import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { type AiRuntimeTool, aiConversations, prepareAiTools } from "@k2b/cloud/ai";
import * as catalog from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { type CodeCheckRequest, type CodeCheckResult, codeSdkHash } from "@k2b/cloud/code";
import type { User } from "@k2b/cloud/contracts";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { memoryStore, nessi, type Provider, type TextBlock, type ToolCallBlock } from "@k2b/nessi";
import { z } from "zod";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateSettings } from "../migrate/core/settings";
import { type CodeContext, CodeDataError } from "./access";
import { codeAuthoringServices } from "./authoring";
import { CodeAuthoringConflictSchema, CodeAuthoringErrorSchema, codeAuthoringContracts } from "./authoring-contracts";
import { createCodeAuthoringChatTools } from "./chat-tools";
import * as hosts from "./runner-jobs";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { codeBundleHash, codeSourceHash } from "./store";
import { CodeVersionError } from "./versions";

const id = "11111111-1111-4111-8111-111111111111";
const fixed = new Date("2026-10-31T12:00:00.000Z");
const user: User = {
  id,
  uid: "authoring",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Author",
  displayName: "Code Author",
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
const context: CodeContext = {
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id }, credentialKind: "session", scopes: [] },
  locale: "de",
};
function checked(request: CodeCheckRequest): CodeCheckResult {
  const bundle = "export const monday = async () => {};";
  return {
    ok: true,
    diagnostics: [],
    bundle,
    permissions: [],
    manifest: {
      version: 1,
      permissions: [],
      ai: false,
      entrypoints: [{ kind: "schedule", entrypoint: "monday", cron: "0 8 * * 1", file: "code.ts", line: 1 }],
      hashes: { source: codeSourceHash(request.files, request.entry), sdk: codeSdkHash(request.sdk), bundle: codeBundleHash(bundle) },
    },
  };
}
databaseSuite()("Code authoring CLI/chat seam", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let capabilities: ReturnType<typeof spyOn<typeof catalog, "listCapabilityCatalog">>;
  let runner: ReturnType<typeof spyOn<typeof hosts, "createRunnerCodeCheckHost">>;
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("core_code_authoring");
    await migrateAuth();
    await migrateAppApproval();
    await migrateSettings();
    await migrateAudit();
    await migrateCode();
    await migratePolicy();
    await migrateApprovals();
    await migrateVersions();
    await migrateActivation();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,'authoring','local','user',true)`;
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!definition) throw new Error(`Unexpected setting ${key}`);
      return definition.default;
    });
    capabilities = spyOn(catalog, "listCapabilityCatalog").mockResolvedValue({
      ok: true,
      data: { protocolVersion: 2, apps: [], page: { hasMore: false } },
    });
    runner = spyOn(hosts, "createRunnerCodeCheckHost").mockReturnValue({ check: async (request) => checked(request) });
  });
  afterAll(async () => {
    settings?.mockRestore();
    capabilities?.mockRestore();
    runner?.mockRestore();
    await database?.drop();
    setSystemTime();
  });
  test("concurrent pushes share C8's atomic base guard and complete conflict diff", async () => {
    const initialized = await codeAuthoringServices.init({ title: "Weekly report" }, context);
    expect(initialized.files["code.ts"]).toContain('{ name: "monday" }');
    const common = { codeId: initialized.config.codeId, entry: "code.ts", baseVersionId: null };
    const outcomes = await Promise.allSettled([
      codeAuthoringServices.push({ ...common, files: { "code.ts": "first" } }, context),
      codeAuthoringServices.push({ ...common, files: { "code.ts": "second" } }, context),
    ]);
    const success = outcomes.find((result) => result.status === "fulfilled");
    const failure = outcomes.find((result) => result.status === "rejected");
    expect(success?.status).toBe("fulfilled");
    expect(failure?.status).toBe("rejected");
    if (success?.status !== "fulfilled" || failure?.status !== "rejected") throw new Error("Expected one saved version and one conflict");
    expect(failure.reason).toBeInstanceOf(CodeVersionError);
    expect(failure.reason.code).toBe("code_version_conflict");
    const conflict = CodeAuthoringConflictSchema.parse(failure.reason.details);
    expect(conflict.latestVersionId).toBe(success.value.submission.version.id);
    expect(conflict.files[0]?.path).toBe("code.ts");
    expect(conflict.files[0]?.lines.some((line) => line.kind === "add")).toBe(true);
    const pulled = await codeAuthoringServices.pull({ codeId: common.codeId }, context);
    expect(codeAuthoringContracts.pull.data.parse(pulled).config.baseVersionId).toBe(success.value.submission.version.id);
    expect(["first", "second"]).toContain(pulled.files["code.ts"]!);
  });
  // Runner transport is deterministic here; C13b/C16/C17 cover isolation and execution.
  test("scripted agent builds a Space task schedule, checks permissions, tests and submits without activation", async () => {
    const chat = spyOn(aiConversations, "getConversation").mockResolvedValue({
      id,
      shortId: "chat_fixture",
      title: "Build a schedule",
      titleSource: "user",
      description: "",
      descriptionSource: "default",
      keywords: [],
      pinnedAt: null,
      archivedAt: null,
      done: false,
      isDone: false,
      lastUsedAt: fixed.toISOString(),
      runStatus: "running",
      runError: null,
      unreadCompletion: false,
      projectId: null,
      draft: { content: [], revision: 0, updatedAt: null },
      createdByUserId: id,
      createdAt: fixed.toISOString(),
      updatedAt: fixed.toISOString(),
    });
    // Legacy interactive turns omit kind; they must remain supported.
    const turn = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
      input: "Build a schedule",
      actor: context.authority.actor,
    });
    const manifest = compileCapabilityManifest("spaces", {
      protocolVersion: 2,
      types: { space: { title: "Space", description: "A fictional Space." } },
      actions: {
        "task.create": {
          title: "Create task",
          description: "Create a fictional task.",
          target: "space",
          openWorld: false,
          destructive: false,
          idempotency: "required",
          input: z.object({ title: z.string().describe("Task title.") }).strict(),
          data: z.object({ id: z.string() }).strict(),
          run: () => {
            throw new Error("Real actions must never run in authoring tests");
          },
        },
      },
    });
    const display = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: {
        appId: "spaces",
        appName: "Spaces",
        appIcon: "ti ti-square",
        appDescription: "Fictional Spaces",
        manifest,
      },
    });
    capabilities.mockResolvedValue({
      ok: true,
      data: {
        protocolVersion: 2,
        apps: [{ appId: "spaces", appName: "Spaces", appIcon: "ti ti-square", appDescription: "Fictional Spaces", manifest }],
        page: { hasMore: false },
      },
    });
    const permission = { operation: "spaces.task.create", target: { type: "spaces.space", id: "sp_fixture" }, file: "code.ts", line: 3 };
    runner.mockReturnValue({
      check: async (request) => {
        const result = checked(request);
        if (!result.ok) return result;
        return { ...result, permissions: [{ ...permission, status: "new" }], manifest: { ...result.manifest, permissions: [permission] } };
      },
    });
    const execution = spyOn(hosts, "createRunnerCodeTestingHost").mockImplementation(async () => ({
      ...hosts.createRunnerCodeCheckHost(context),
      limits: { requestBytes: 2_097_152, outputBytes: 65_536, cases: 10, runs: 10, calls: 10, wallClockMs: 10_000 },
      execute: async (request) => {
        expect(request.cases[0]?.fixture.mocks[0]?.operation).toBe("spaces.task.create");
        expect(request.cases[0]?.fixture.now).toBe(fixed.getTime());
        expect(request.sdk.manifest.operations.some((row) => row.capability === "spaces.task.create")).toBe(true);
        return { version: 1, mode: request.mode, ok: true, error: null, diagnostics: [], cases: [] };
      },
    }));
    const source =
      'import {app, spaces} from "@sdk";\napp.schedule("0 8 * * 1", async () => {\n  await spaces.space("sp_fixture").task.create({title: "Weekly review", idempotencyKey: "review:2030-01-07"});\n}, {name: "monday"});\nexport default app;\n';
    const fixture = {
      version: 1,
      name: "weekly task",
      now: fixed.getTime(),
      seed: 42,
      mocks: [{ operation: "spaces.task.create", target: permission.target, replies: [{ ok: true, data: { id: "task_fixture" } }] }],
      runs: [{ entrypoint: "monday", expect: { ok: true } }],
    };
    let project: z.infer<typeof codeAuthoringContracts.pull.data> | undefined;
    let versionId: string | undefined;
    const seen: string[] = [];
    let step = 0;
    const answer = (): TextBlock | ToolCallBlock => {
      const names = ["code_init", "code_write", "code_check", "code_test", "code_simulate", "code_submit", "code_diff", "code_pull"];
      const name = names[step++];
      if (!name) return { type: "text", text: "Version submitted. Activate it yourself after review." };
      const common = project ? { codeId: project.config.codeId, entry: project.config.entry, files: project.files } : {};
      const args =
        name === "code_init"
          ? { title: "Weekly review" }
          : name === "code_write"
            ? { project, path: "code.ts", content: source }
            : name === "code_test"
              ? { ...common, tests: { "test/monday.json": JSON.stringify(fixture) } }
              : name === "code_simulate"
                ? { ...common, fixture }
                : name === "code_submit"
                  ? { ...common, baseVersionId: project?.config.baseVersionId }
                  : name === "code_diff"
                    ? { codeId: project?.config.codeId, versionId }
                    : name === "code_pull"
                      ? { codeId: project?.config.codeId }
                      : common;
      return { type: "tool_call", id: `call-${step}`, name, args };
    };
    const provider: Provider = {
      name: "scripted",
      family: "openai-compatible",
      model: "scripted",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async complete() {
        throw new Error("Unexpected completion");
      },
      async *stream() {
        const block = answer();
        yield block.type === "text"
          ? { type: "block_start", blockId: "b", index: 0, kind: "text" }
          : { type: "block_start", blockId: "b", index: 0, kind: "tool_call", callId: block.id, name: block.name };
        yield { type: "block_end", blockId: "b", index: 0, block };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: block.type === "text" ? "stop" : "tool_use" };
      },
    };
    try {
      const tools = prepareAiTools({
        tools: createCodeAuthoringChatTools(),
        actor: context.authority.actor,
        conversationId: id,
        turnId: id,
      }).tools;
      for await (const event of nessi({
        provider,
        systemPrompt: "Build and submit Code; activation is a human step.",
        input: "Build a weekly task schedule",
        tools,
        store: memoryStore(),
        maxTurns: 10,
      })) {
        if (event.type === "tool_execution_end") {
          expect(event.isError).toBeFalsy();
          seen.push(event.name);
          if (["code_init", "code_write", "code_pull"].includes(event.name)) project = codeAuthoringContracts.pull.data.parse(event.result);
          if (event.name === "code_check")
            expect(codeAuthoringContracts.check.data.parse(event.result).permissions).toEqual([
              { ...permission, status: "new", title: null, typeTitle: "Space", own: false, needsTargetAdmin: false },
            ]);
          if (event.name === "code_test" || event.name === "code_simulate")
            expect(codeAuthoringContracts.test.data.parse(event.result).ok).toBe(true);
          if (event.name === "code_submit") versionId = codeAuthoringContracts.submit.data.parse(event.result).submission.version.id;
          if (event.name === "code_diff") expect(codeAuthoringContracts.diff.data.safeParse(event.result).success).toBe(true);
        }
        if (event.type === "loop_end") expect(event.reason).toBe("stop");
      }
      expect(seen).toEqual([
        "code_init",
        "code_write",
        "code_check",
        "code_test",
        "code_simulate",
        "code_submit",
        "code_diff",
        "code_pull",
      ]);
      if (!project || !versionId) throw new Error("Agent did not submit a version");
      expect(project.config.baseVersionId).toBe(versionId);
      expect(project?.files["code.ts"]).toBe(source);
      expect(await sql`SELECT id FROM code.activations WHERE code_id=${project.config.codeId}`).toHaveLength(0);
      const runtimeTools: AiRuntimeTool[] = createCodeAuthoringChatTools();
      const invoke = async (name: string, input: unknown, signal = new AbortController().signal) => {
        const tool = runtimeTools.find((item) => item.def.name === name);
        if (!tool || !("location" in tool) || tool.location !== "server") throw new Error("Expected server tool");
        return tool.run(tool.def.inputSchema.parse(input), {
          actor: context.authority.actor,
          conversationId: id,
          turnId: id,
          signal,
          requestApproval: async () => {
            throw new Error("Authoring must never request activation approval");
          },
          requestClientTool: async () => {
            throw new Error("Authoring is server owned");
          },
        });
      };
      const aborted = AbortSignal.abort(new DOMException("Cancelled", "AbortError"));
      let cancelled: unknown;
      try {
        await invoke("code_pull", { codeId: project.config.codeId }, aborted);
      } catch (error) {
        cancelled = error;
      }
      expect(cancelled).toBe(aborted.reason);
      const stale = CodeAuthoringErrorSchema.parse(
        await invoke("code_submit", {
          codeId: project.config.codeId,
          files: project.files,
          entry: "code.ts",
          baseVersionId: null,
        }),
      );
      expect(stale.error.code).toBe("code_version_conflict");
      expect(CodeAuthoringConflictSchema.parse(stale.error.details).latestVersionId).toBe(versionId);
      turn.mockResolvedValue({ input: "background", mandate: { id, revision: 1 } });
      expect(CodeAuthoringErrorSchema.parse(await invoke("code_pull", { codeId: project.config.codeId })).error.code).toBe("FORBIDDEN");
      turn.mockResolvedValue({ input: "interactive", actor: context.authority.actor });
      // An administrator can read another person's Code but is not its editor.
      const otherId = "33333333-3333-4333-8333-333333333333";
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${otherId}::uuid,'chat-other','local','user',false)`;
      const otherContext: CodeContext = {
        ...context,
        authority: {
          ...context.authority,
          actor: { kind: "user", user: { ...user, id: otherId, uid: "chat-other", roles: [] } },
          accessSubject: { type: "user", userId: otherId },
        },
      };
      const other = await codeAuthoringServices.init({ title: "Other person's Code" }, otherContext);
      expect((await codeAuthoringServices.pull({ codeId: other.config.codeId }, context)).config.codeId).toBe(other.config.codeId);
      for (const name of ["code_read", "code_pull", "code_sdk"])
        expect(CodeAuthoringErrorSchema.parse(await invoke(name, { codeId: other.config.codeId })).error.code).toBe("NOT_FOUND");
      await sql`UPDATE code.codes SET owner_kind='resource',owner_user_id=NULL,owner_type='spaces.space',owner_id='sp_other' WHERE id=${other.config.codeId}`;
      for (const name of ["code_read", "code_pull", "code_sdk"])
        expect(CodeAuthoringErrorSchema.parse(await invoke(name, { codeId: other.config.codeId })).error.code).toBe("NOT_FOUND");
    } finally {
      chat.mockRestore();
      turn.mockRestore();
      display.mockRestore();
      execution.mockRestore();
      capabilities.mockResolvedValue({ ok: true, data: { protocolVersion: 2, apps: [], page: { hasMore: false } } });
      runner.mockReturnValue({ check: async (request) => checked(request) });
    }
  });
  test("phone, read-only and machine credentials cannot activate through the shared service", async () => {
    const input = { codeId: "c_1234", versionId: id, activationId: id };
    const phone: CodeContext = { ...context, authority: { ...context.authority, actor: { kind: "user", user, sessionKind: "app" } } };
    await expect(codeAuthoringServices.activate(input, phone)).rejects.toThrow("phone");
    await expect(
      codeAuthoringServices.activate(input, { ...context, authority: { ...context.authority, credentialKind: "oauth", scopes: ["read"] } }),
    ).rejects.toThrow("Credential");
    await expect(
      codeAuthoringServices.activate(input, {
        ...context,
        authority: { ...context.authority, credentialKind: "api_key", scopes: ["write"] },
      }),
    ).rejects.toThrow("browser");
  });
  test("personal service permission guidance and JSON stay stable across checks", async () => {
    const manifest = compileCapabilityManifest("example", {
      protocolVersion: 2,
      queries: {
        status: {
          title: "Status",
          description: "Read current status.",
          openWorld: false,
          input: z.object({}).strict(),
          data: z.object({}).strict(),
          run: () => ({ ok: true as const, data: { data: {} } }),
        },
      },
    });
    const presentation = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "example", appName: "Example", appIcon: "ti ti-code", appDescription: "Fixture", manifest },
    });
    runner.mockReturnValue({
      check: async (request) => {
        const result = checked(request);
        if (!result.ok) return result;
        const permission = { operation: "example.status", target: null, file: "code.ts", line: 1 };
        return { ...result, permissions: [{ ...permission, status: "new" }], manifest: { ...result.manifest, permissions: [permission] } };
      },
    });
    try {
      const initialized = await codeAuthoringServices.init({ title: "Deterministic check" }, context);
      const input = { codeId: initialized.config.codeId, entry: "code.ts", files: initialized.files };
      const first = codeAuthoringContracts.check.data.parse(await codeAuthoringServices.check(input, context));
      const second = codeAuthoringContracts.check.data.parse(await codeAuthoringServices.check(input, context));
      expect(first.result.ok).toBe(true);
      expect(first.permissions).toEqual([
        {
          operation: "example.status",
          target: null,
          file: "code.ts",
          line: 1,
          status: "new",
          title: null,
          typeTitle: null,
          own: false,
          needsTargetAdmin: false,
        },
      ]);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally {
      presentation.mockRestore();
      runner.mockReturnValue({ check: async (request) => checked(request) });
    }
  });
  test("an ordinary person with a valid browser credential cannot activate another person's Code", async () => {
    const initialized = await codeAuthoringServices.init({ title: "Owner only" }, context);
    const otherId = "22222222-2222-4222-8222-222222222222";
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${otherId}::uuid,'other-author','local','user',false)`;
    const other: CodeContext = {
      ...context,
      authority: {
        actor: { kind: "user", user: { ...user, id: otherId, uid: "other-author", roles: [] } },
        accessSubject: { type: "user", userId: otherId },
        credentialKind: "session",
        scopes: [],
        credentialProof: { kind: "session", userId: otherId, sid: otherId, authEpoch: 0, expiresAt: "2026-11-01T12:00:00.000Z" },
      },
    };
    const activation = codeAuthoringServices.activate({ codeId: initialized.config.codeId, versionId: id, activationId: otherId }, other);
    await expect(activation).rejects.toBeInstanceOf(CodeDataError);
    await expect(activation).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await sql`SELECT id FROM code.activations WHERE code_id=${initialized.config.codeId}`).toHaveLength(0);
  });
  test("workspace status compares local edits with its immutable base and latest approval", async () => {
    const initialized = await codeAuthoringServices.init({ title: "Status fixture" }, context);
    const files = { "code.ts": "status source" };
    const saved = await codeAuthoringServices.push(
      { codeId: initialized.config.codeId, entry: "code.ts", files, baseVersionId: null },
      context,
    );
    const config = { ...initialized.config, baseVersionId: saved.submission.version.id };
    const first = codeAuthoringContracts.status.data.parse(await codeAuthoringServices.status({ config, files }, context));
    expect(first.items[0]).toMatchObject({ baseCurrent: true, modified: false, latest: { status: saved.submission.status } });
    expect((await codeAuthoringServices.status({ config, files: { "code.ts": "local edit" } }, context)).items[0]?.modified).toBe(true);
    await codeAuthoringServices.push(
      { codeId: config.codeId, entry: "code.ts", files: { "code.ts": "new server version" }, baseVersionId: config.baseVersionId },
      context,
    );
    const stale = await codeAuthoringServices.status({ config, files }, context);
    expect(stale.items[0]).toMatchObject({ baseCurrent: false, modified: false });
  });
  test("pullAll is Cloud-admin-only and contains resource Code, never personal or app Code", async () => {
    const nonAdmin = { ...context, authority: { ...context.authority, actor: { kind: "user" as const, user: { ...user, roles: [] } } } };
    await expect(codeAuthoringServices.pullAll({}, nonAdmin)).rejects.toThrow("Cloud administration");
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind,created_by) VALUES('authoring-resource','code',${id}::uuid) RETURNING id`;
    const [appAccount] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind,created_by) VALUES('authoring-app','code',${id}::uuid) RETURNING id`;
    if (!account || !appAccount) throw new Error("Missing test accounts");
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,title,service_account_id,created_by)
      VALUES('c_allresource','resource','example.box','box_1234','Resource',${account.id}::uuid,${id}::uuid)`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_app_id,title,service_account_id,created_by)
      VALUES('c_allapp','app','example','App',${appAccount.id}::uuid,${id}::uuid)`;
    const reader = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({
      ok: false,
      error: { code: "NOT_FOUND", message: "not installed", status: 404 },
    });
    try {
      const items: CodeAuthoringData<"pullAll">["items"] = [];
      let cursor: string | undefined;
      do {
        const page = codeAuthoringContracts.pullAll.data.parse(await codeAuthoringServices.pullAll({ cursor }, context));
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(items.map((item) => item.config.codeId)).toEqual(["c_allresource"]);
      expect(items[0]?.config.owner.kind).toBe("resource");
    } finally {
      reader.mockRestore();
    }
  });
  test("policy preview and update reject stale revisions through the shared authoring service", async () => {
    const { policy } = await codeAuthoringServices.policyRead({}, context);
    const definition = codePolicyPreset("admin");
    const preview = await codeAuthoringServices.policyPreview({ revision: policy.revision, definition, limit: 20 }, context);
    expect(preview.revision).toBe(policy.revision);
    const updated = await codeAuthoringServices.policyUpdate({ revision: policy.revision, definition }, context);
    expect(updated.policy.revision).toBe(policy.revision + 1);
    await expect(codeAuthoringServices.policyUpdate({ revision: policy.revision, definition }, context)).rejects.toThrow("changed");
    await expect(codeAuthoringServices.policyPreview({ revision: policy.revision, definition, limit: 20 }, context)).rejects.toThrow(
      "changed",
    );
    expect((await codeAuthoringServices.policyRead({}, context)).policy.revision).toBe(updated.policy.revision);
  });
});
