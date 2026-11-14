import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { type AiRuntimeTool, aiConversations, prepareAiTools } from "@k2b/cloud/ai";
import * as catalog from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CODE_CHECK_LIMITS, type CodeCheckRequest, type CodeCheckResult, codeSdkHash } from "@k2b/cloud/code";
import type { User } from "@k2b/cloud/contracts";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { memoryStore, nessi, type Provider, type TextBlock, type ToolCallBlock } from "@k2b/nessi";
import { z } from "zod";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiDecisionQuery } from "../ai-decision-capability";
import { aiGenerationQuery } from "../ai-generation-capability";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migrateChatDrafts } from "../migrate/core/code-chat-drafts";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateSecrets } from "../migrate/core/code-secrets";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateSettings } from "../migrate/core/settings";
import * as access from "./access";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { previewCodeActivation } from "./activation";
import { codeAuthoringServices } from "./authoring";
import { createCodeCheckRequest } from "./authoring-check";
import {
  CodeAuthoringConflictSchema,
  type CodeAuthoringData,
  CodeAuthoringErrorSchema,
  CodeChatCheckDataSchema,
  CodeChatDraftSummarySchema,
  codeAuthoringContracts,
} from "./authoring-contracts";
import { CODE_CHAT_DRAFT_LIFETIME_MS, expireCodeChatDrafts } from "./chat-drafts";
import { createCodeAuthoringChatTools } from "./chat-tools";
import * as origins from "./origins";
import { codePolicyPreset } from "./policy-contracts";
import { startCodeRunRetention } from "./retention";
import * as hosts from "./runner-jobs";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { codeBundleHash, codeSourceHash } from "./store";
import * as versionState from "./versions";
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
    await migrateChatDrafts();
    await migrateChatDrafts(); // The migration is safe to repeat.
    await migratePolicy();
    await migrateApprovals();
    await migrateVersions();
    await migrateSecrets();
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
  test("members still create and submit Code while a guest cannot author existing personal Code", async () => {
    const guest: CodeContext = {
      ...context,
      authority: { ...context.authority, actor: { kind: "user", user: { ...user, profile: "guest" } } },
    };
    await expect(codeAuthoringServices.init({ title: "Guest fixture" }, guest)).rejects.toMatchObject({
      code: "code_guests_cannot_author",
    });
    const project = await codeAuthoringServices.init({ title: "Member authoring fixture" }, context);
    const input = { codeId: project.config.codeId, files: project.files, entry: project.config.entry, baseVersionId: null };
    await expect(codeAuthoringServices.submit(input, guest)).rejects.toMatchObject({ code: "code_guests_cannot_author" });
    const saved = await codeAuthoringServices.submit(input, context);
    expect(saved.submission.version.codeId).toBe(project.config.codeId);
    expect(saved.nextStep).toEqual({ next: "switch_on", who: "personal_owner" });
  });
  test("a saved submission asks to check live status when the follow-up readiness read fails", async () => {
    const project = await codeAuthoringServices.init({ title: "Readiness unavailable" }, context);
    const readiness = spyOn(versionState, "codeVersionReadiness").mockRejectedValueOnce(new Error("Fixture read unavailable"));
    try {
      const saved = await codeAuthoringServices.submit(
        { codeId: project.config.codeId, files: project.files, entry: project.config.entry, baseVersionId: null },
        context,
      );
      expect(saved.nextStep).toEqual({ next: "check_status", who: "code_editor" });
      const [stored] = await sql`SELECT id FROM code.versions WHERE id=${saved.submission.version.id}::uuid`;
      expect(stored.id).toBe(saved.submission.version.id);
    } finally {
      readiness.mockRestore();
    }
  });
  async function withDraftChat(
    run: (invoke: (name: string, input: unknown, conversationId?: string) => Promise<unknown>) => Promise<void>,
    author: CodeContext = context,
  ) {
    const chat = spyOn(aiConversations, "getConversation").mockResolvedValue({
      id,
      shortId: "draft_fixture",
      title: "Draft authoring",
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
      createdByUserId: codePerson(author).id,
      createdAt: fixed.toISOString(),
      updatedAt: fixed.toISOString(),
    });
    const turn = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
      input: "Edit Code",
      actor: author.authority.actor,
    });
    const tools: AiRuntimeTool[] = createCodeAuthoringChatTools();
    try {
      await run(async (name, input, conversationId = id) => {
        const tool = tools.find((item) => item.def.name === name);
        if (!tool || !("location" in tool) || tool.location !== "server") throw new Error("Expected server tool");
        return tool.run(tool.def.inputSchema.parse(input), {
          actor: author.authority.actor,
          conversationId,
          turnId: id,
          signal: new AbortController().signal,
          requestApproval: async () => {
            throw new Error("No approvals during authoring");
          },
          requestClientTool: async () => {
            throw new Error("Server-owned authoring");
          },
        });
      });
    } finally {
      chat.mockRestore();
      turn.mockRestore();
      setSystemTime(fixed);
    }
  }
  test("a member's chat submit follows the card's administrator approval before owner switch-on", async () => {
    const memberId = "33240000-0000-4000-8000-000000000001";
    const member: CodeContext = {
      ...context,
      authority: {
        ...context.authority,
        actor: { kind: "user", user: { ...user, id: memberId, roles: ["user"] } },
        accessSubject: { type: "user", userId: memberId },
      },
    };
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${memberId}::uuid,'submit_member','local','user',false)`;
    const { policy } = await codeAuthoringServices.policyRead({}, context);
    const updated = await codeAuthoringServices.policyUpdate({ revision: policy.revision, definition: codePolicyPreset("admin") }, context);
    runner.mockReturnValue({
      check: async (request) => {
        const result = checked(request);
        return result.ok ? { ...result, manifest: { ...result.manifest, internet: ["https://example.com"] } } : result;
      },
    });
    try {
      await withDraftChat(async (invoke) => {
        const project = codeAuthoringContracts.init.data.parse(await invoke("code_init", { title: "Member approval" }));
        const submitted = codeAuthoringContracts.submit.data.parse(await invoke("code_submit", { codeId: project.config.codeId }));
        expect(submitted.submission.status).toBe("pending");
        expect(submitted.nextStep).toEqual({ next: "admin_approval", who: "cloud_admin" });
        const card = await previewCodeActivation({ codeId: project.config.codeId, versionId: submitted.submission.version.id }, member);
        expect(card.readiness).toEqual({ state: "approval_pending" });
      }, member);
    } finally {
      runner.mockReturnValue({ check: async (request) => checked(request) });
      await codeAuthoringServices.policyUpdate({ revision: updated.policy.revision, definition: policy.definition }, context);
    }
  });

  test("chat checks, tests, simulations and submit share exactly the server-held files and fixtures", async () => {
    await withDraftChat(async (invoke) => {
      const execution = spyOn(hosts, "createRunnerCodeTestingHost").mockImplementation(async () => ({
        check: async (request) => checked(request),
        limits: { requestBytes: CODE_CHECK_LIMITS.requestBytes, outputBytes: 65_536, cases: 10, runs: 10, calls: 10, wallClockMs: 10_000 },
        execute: async (request) => {
          expect(request.cases[0]?.fixture.now).toBe(fixed.getTime());
          return {
            version: 1,
            mode: request.mode,
            ok: true,
            error: null,
            diagnostics: [],
            cases: request.cases.map((item) => ({ name: item.fixture.name, file: item.file, ok: true, runs: [] })),
          };
        },
      }));
      try {
        const initialized = codeAuthoringContracts.init.data.parse(await invoke("code_init", { title: "Shared draft" }));
        const { codeId } = initialized.config;
        const source = "export const monday = async () => {}; // edited";
        const firstWrite = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "code.ts", content: source }));
        expect(firstWrite.draft.files).toEqual([{ path: "code.ts", bytes: Buffer.byteLength(source) }]);
        expect(firstWrite.draft.expiresAt).toBe(new Date(fixed.getTime() + CODE_CHAT_DRAFT_LIFETIME_MS).toISOString());
        const hash1 = CodeChatCheckDataSchema.parse(await invoke("code_check", { codeId })).manifest?.hashes.source;
        await invoke("code_write", { codeId, path: "lib.ts", content: "export const value = 42;" });
        const fixture = { version: 1, name: "Monday", now: fixed.getTime(), seed: 42, mocks: [], runs: [{ entrypoint: "monday" }] };
        const fixtureText = JSON.stringify(fixture);
        const summary = CodeChatDraftSummarySchema.parse(
          await invoke("code_write", { codeId, path: "test/monday.json", content: fixtureText }),
        );
        expect(summary.draft.files.map((item) => item.path)).toEqual(["code.ts", "lib.ts"]);
        expect(summary.draft.tests).toEqual([{ path: "test/monday.json", bytes: Buffer.byteLength(fixtureText) }]);
        const hash2 = CodeChatCheckDataSchema.parse(await invoke("code_check", { codeId })).manifest?.hashes.source;
        expect(hash2).toBeTruthy();
        expect(hash2).not.toBe(hash1);
        expect(codeAuthoringContracts.test.data.parse(await invoke("code_test", { codeId })).cases).toHaveLength(1);
        expect(codeAuthoringContracts.simulate.data.parse(await invoke("code_simulate", { codeId, fixture })).ok).toBe(true);
        const submitted = codeAuthoringContracts.submit.data.parse(await invoke("code_submit", { codeId }));
        const [version] = await sql<
          { source_hash: string; source_files: Record<string, string> }[]
        >`SELECT source_hash,source_files FROM code.versions WHERE id=${submitted.submission.version.id}::uuid`;
        expect(version?.source_hash).toBe(hash2);
        expect(version?.source_files).toEqual({ "code.ts": source, "lib.ts": "export const value = 42;" });
        const [draft] = await sql<
          { base_version_id: string; tests: Record<string, string> }[]
        >`SELECT base_version_id,tests FROM code.chat_drafts WHERE code_id=${codeId} AND conversation_id=${id}::uuid`;
        expect(draft?.base_version_id).toBe(submitted.submission.version.id);
        expect(draft?.tests).toEqual({ "test/monday.json": fixtureText });
        const [evidence] = await sql<
          { evidence: unknown }[]
        >`SELECT evidence FROM code.version_submissions WHERE version_id=${submitted.submission.version.id}::uuid`;
        expect(evidence?.evidence).toMatchObject({ tests: { state: "passed", total: 1 } });

        // Pull/read deliberately discards unsaved edits and fixtures, and resets the base to the latest saved version.
        await invoke("code_write", { codeId, path: "unsaved.ts", content: "unsaved" });
        await invoke("code_read", { codeId });
        const reset = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "missing.ts", delete: true }));
        expect(reset.draft.files.map((item) => item.path)).toEqual(["code.ts", "lib.ts"]);
        expect(reset.draft.tests).toEqual([]);
        expect(reset.draft.baseVersionId).toBe(submitted.submission.version.id);
      } finally {
        execution.mockRestore();
      }
    });
  });

  test("parallel chat writes preserve both files; rename, delete and aliases update the same isolated draft", async () => {
    await withDraftChat(async (invoke) => {
      const project = codeAuthoringContracts.init.data.parse(await invoke("code_init", { title: "Parallel draft" }));
      const { codeId } = project.config;
      const writes = await Promise.all([
        invoke("code_write", { codeId, path: "a.ts", content: "a" }),
        invoke("code_write", { codeId, path: "b.ts", content: "b" }),
      ]);
      for (const result of writes) expect(CodeChatDraftSummarySchema.safeParse(result).success).toBe(true);
      const renamed = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "code.ts", renameTo: "main.ts" }));
      expect(renamed.draft.files.map((item) => item.path)).toEqual(["a.ts", "b.ts", "main.ts"]);
      expect(renamed.draft.entry).toBe("main.ts");
      // A rename never overwrites another draft file.
      expect(CodeAuthoringErrorSchema.parse(await invoke("code_write", { codeId, path: "a.ts", renameTo: "main.ts" })).error.code).toBe(
        "CONFLICT",
      );
      // Omitted entry must preserve main.ts, not the shared contract's code.ts default.
      expect(CodeChatCheckDataSchema.parse(await invoke("code_check", { codeId })).manifest?.entry).toBe("main.ts");
      await invoke("code_write", { codeId, path: "b.ts", delete: true });
      const otherConversation = "22222222-2222-4222-8222-222222222222";
      for (const [name, input] of [
        ["code_write", { codeId, path: "a.ts", content: "other" }],
        ["code_check", { codeId }],
        ["code_test", { codeId }],
        ["code_submit", { codeId }],
        [
          "code_simulate",
          { codeId, fixture: { version: 1, name: "Missing", now: fixed.getTime(), seed: 42, mocks: [], runs: [{ entrypoint: "monday" }] } },
        ],
      ] as const) {
        const error = CodeAuthoringErrorSchema.parse(await invoke(name, input, otherConversation)).error;
        expect(error.code).toBe("NOT_FOUND");
        expect(error.message).toContain("code_pull");
      }
      // Supplying files can seed a missing draft without reading the saved version.
      const aliasFiles = { "other.ts": "other" };
      expect(
        CodeChatCheckDataSchema.parse(await invoke("code_check", { codeId, files: aliasFiles, entry: "other.ts" }, otherConversation))
          .manifest?.entry,
      ).toBe("other.ts");
      const original = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "a.ts", content: "a" }));
      expect(original.draft.files.map((item) => item.path)).toEqual(["a.ts", "main.ts"]);
      // Old project writes return the exact complete replacement project.
      expect(await invoke("code_write", { project, path: "legacy.ts", content: "legacy" })).toEqual({
        ...project,
        files: { ...project.files, "legacy.ts": "legacy" },
      });
      const replaced = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "legacy.ts", delete: true }));
      expect(replaced.draft.files.map((item) => item.path)).toEqual(["code.ts"]);
    });
  });

  test("chat draft lifetime follows changes, expired drafts are missing and the existing sweep removes them", async () => {
    await withDraftChat(async (invoke) => {
      const { codeId } = codeAuthoringContracts.init.data.parse(await invoke("code_init", { title: "Expiring draft" })).config;
      setSystemTime(new Date(fixed.getTime() + 1000));
      await invoke("code_check", { codeId });
      const unchanged = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "missing.ts", delete: true }));
      expect(unchanged.draft.expiresAt).toBe(new Date(fixed.getTime() + CODE_CHAT_DRAFT_LIFETIME_MS).toISOString());
      const changed = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "lib.ts", content: "changed" }));
      const expiresAt = fixed.getTime() + 1000 + CODE_CHAT_DRAFT_LIFETIME_MS;
      expect(changed.draft.expiresAt).toBe(new Date(expiresAt).toISOString());
      setSystemTime(new Date(expiresAt + 1));
      for (const [name, input] of [
        ["code_check", { codeId }],
        ["code_write", { codeId, path: "code.ts", content: "cannot revive" }],
      ] as const)
        expect(CodeAuthoringErrorSchema.parse(await invoke(name, input)).error).toMatchObject({
          code: "NOT_FOUND",
          message: expect.stringContaining("code_pull"),
        });
      expect(await sql`SELECT code_id FROM code.chat_drafts WHERE code_id=${codeId}`).toHaveLength(1);
      const stop = startCodeRunRetention();
      await stop(); // Drains the immediate bounded sweep, without introducing a test timer.
      expect(await sql`SELECT code_id FROM code.chat_drafts WHERE code_id=${codeId}`).toHaveLength(0);
      await invoke("code_pull", { codeId });
      expect(CodeChatDraftSummarySchema.safeParse(await invoke("code_write", { codeId, path: "fresh.ts", content: "" })).success).toBe(
        true,
      );
    });
  });

  test("a submit moves only the draft it submitted to the new version, and a draft gone meanwhile still gets the version", async () => {
    await withDraftChat(async (invoke) => {
      const { codeId } = codeAuthoringContracts.init.data.parse(await invoke("code_init", { title: "Submit bookkeeping" })).config;
      await invoke("code_write", { codeId, path: "code.ts", content: "export const monday = async () => {}; // v1" });
      const first = codeAuthoringContracts.submit.data.parse(await invoke("code_submit", { codeId }));
      await invoke("code_write", { codeId, path: "code.ts", content: "export const monday = async () => {}; // v2" });
      // While the submit checks, a pull replaces the draft with the saved version: it must keep that base.
      runner.mockReturnValueOnce({
        check: async (request) => {
          await invoke("code_pull", { codeId });
          return checked(request);
        },
      });
      const second = codeAuthoringContracts.submit.data.parse(await invoke("code_submit", { codeId }));
      const [replaced] = await sql<{ base_version_id: string }[]>`SELECT base_version_id FROM code.chat_drafts
        WHERE code_id=${codeId} AND conversation_id=${id}::uuid`;
      expect(replaced?.base_version_id).toBe(first.submission.version.id);
      expect(second.submission.version.id).not.toBe(first.submission.version.id);
      // A draft that expires during the submit leaves the saved version and its answer intact.
      await invoke("code_pull", { codeId });
      await invoke("code_write", { codeId, path: "code.ts", content: "export const monday = async () => {}; // v3" });
      runner.mockReturnValueOnce({
        check: async (request) => {
          setSystemTime(new Date(Date.now() + CODE_CHAT_DRAFT_LIFETIME_MS + 1));
          return checked(request);
        },
      });
      expect(codeAuthoringContracts.submit.data.safeParse(await invoke("code_submit", { codeId })).success).toBe(true);
    });
  });

  test("the sweep removes drafts of deleted chats once chats exist", async () => {
    await withDraftChat(async (invoke) => {
      const { codeId } = codeAuthoringContracts.init.data.parse(await invoke("code_init", { title: "Orphan draft" })).config;
      const deleted = "33333333-3333-4333-8333-333333333334";
      await invoke("code_check", { codeId, files: { "code.ts": "export default null;" } }, deleted);
      // This suite does not migrate AI; stand in its chat table and drop only what the test created.
      const [existing] = await sql<{ schema: string | null }[]>`SELECT to_regnamespace('ai')::text AS schema`;
      await sql`CREATE SCHEMA IF NOT EXISTS ai`;
      await sql`CREATE TABLE IF NOT EXISTS ai.conversations(id UUID PRIMARY KEY)`;
      try {
        await sql`INSERT INTO ai.conversations(id) VALUES(${id}::uuid) ON CONFLICT DO NOTHING`;
        await expireCodeChatDrafts({ now: new Date(), limit: 100 });
        const rows = await sql<{ conversation_id: string }[]>`SELECT conversation_id FROM code.chat_drafts WHERE code_id=${codeId}`;
        expect(rows.map((row) => row.conversation_id)).toEqual([id]);
      } finally {
        if (!existing?.schema) await sql`DROP SCHEMA ai CASCADE`;
      }
    });
  });

  test("chat draft budgets reject the post-write state atomically and retain the previous draft", async () => {
    await withDraftChat(async (invoke) => {
      const { codeId } = codeAuthoringContracts.init.data.parse(await invoke("code_init", { title: "Bounded draft" })).config;
      const full = Object.fromEntries(Array.from({ length: CODE_CHECK_LIMITS.files }, (_, n) => [`file${n}.ts`, ""]));
      await invoke("code_check", { codeId, files: full, entry: "file0.ts" });
      for (const input of [
        { codeId, path: "overflow.ts", content: "" },
        { codeId, path: "file0.ts", content: "é".repeat(CODE_CHECK_LIMITS.sourceBytes / 2 + 1) },
      ])
        expect(CodeAuthoringErrorSchema.parse(await invoke("code_write", input)).error.code).toBe("BAD_INPUT");
      const stable = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "file0.ts", content: "" }));
      expect(stable.draft.files).toHaveLength(CODE_CHECK_LIMITS.files);
      expect(stable.draft.files.every((item) => item.bytes === 0)).toBe(true);
      const half = CODE_CHECK_LIMITS.requestBytes / 2 - 4096;
      await invoke("code_write", { codeId, path: "test/one.json", content: "x".repeat(half) });
      await invoke("code_write", { codeId, path: "test/two.json", content: "x".repeat(half) });
      // Content alone stays 50 bytes under the budget; paths and structure push the whole draft over it.
      expect(
        CodeAuthoringErrorSchema.parse(await invoke("code_write", { codeId, path: "test/three.json", content: "x".repeat(8192 - 50) }))
          .error.code,
      ).toBe("BAD_INPUT");
      const after = CodeChatDraftSummarySchema.parse(await invoke("code_write", { codeId, path: "test/absent.json", delete: true }));
      expect(after.draft.tests.map((item) => item.path)).toEqual(["test/one.json", "test/two.json"]);
    });
  });

  test.each(["ai.decide", "ai.generate"])(
    "core.%s is selected as AI by the authoritative checker and appears in policy row KI",
    async (operation) => {
      const qualified = `core.${operation}`;
      const manifest = compileCapabilityManifest("core", {
        protocolVersion: 2,
        queries: { [operation]: operation === "ai.decide" ? aiDecisionQuery : aiGenerationQuery },
      });
      const app = { appId: "core", appName: "Core", appIcon: "ti ti-cloud", appDescription: "Platform", manifest };
      capabilities.mockResolvedValue({ ok: true, data: { protocolVersion: 2, apps: [app], page: { hasMore: false } } });
      const display = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: app });
      runner.mockReturnValue({
        check: async (request) => {
          expect(request.aiOperations).toEqual([qualified]);
          const result = checked(request);
          if (!result.ok) return result;
          const permission = { operation: qualified, target: null, file: "code.ts", line: 1 };
          return {
            ...result,
            permissions: [{ ...permission, status: "new" }],
            manifest: { ...result.manifest, ai: true, permissions: [permission] },
          };
        },
      });
      try {
        const initialized = await codeAuthoringServices.init({ title: "Decision triage" }, context);
        const input = { codeId: initialized.config.codeId, entry: "code.ts", files: initialized.files };
        const request = await createCodeCheckRequest(input.codeId, input.files, input.entry, context);
        expect(request.aiOperations).toEqual([qualified]);
        const result = await codeAuthoringServices.check(input, context);
        expect(result.manifest?.policyRows).toEqual(["ai", "read"]);
      } finally {
        display.mockRestore();
        capabilities.mockResolvedValue({ ok: true, data: { protocolVersion: 2, apps: [], page: { hasMore: false } } });
        runner.mockReturnValue({ check: async (request) => checked(request) });
      }
    },
  );
  test("concurrent pushes share C8's atomic base guard and complete conflict diff", async () => {
    const initialized = await codeAuthoringServices.init({ title: "Weekly report" }, context);
    expect(initialized.files["code.ts"]).toContain('app.schedule({ cron: "0 8 * * 1", name: "monday" },');
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
    expect(success.value.runningVersion).toBeNull();
    expect(conflict.files[0]?.path).toBe("code.ts");
    expect(conflict.files[0]?.lines.some((line) => line.kind === "add")).toBe(true);
    const pulled = await codeAuthoringServices.pull({ codeId: common.codeId }, context);
    expect(codeAuthoringContracts.pull.data.parse(pulled).config.baseVersionId).toBe(success.value.submission.version.id);
    expect(["first", "second"]).toContain(pulled.files["code.ts"]!);
  });
  test("a submitted version uses each secret's current destination; a page resubmits without a local project", async () => {
    const own = spyOn(origins, "readCodeOwnOrigins").mockResolvedValue(["https://cloud.example"]);
    const code = await codeAuthoringServices.init({ title: "Secrets" }, context);
    const { codeId } = code.config;
    const first = await codeAuthoringServices.push(
      { codeId, entry: "code.ts", files: { "code.ts": "export const monday = 1;" }, baseVersionId: null },
      context,
    );
    const value = "fixture-private-credential";
    const destination = { origin: "https://api.example.com", pathPrefix: "/v1", headers: ["authorization"] };
    const set = await codeAuthoringServices.secretSet(
      { codeId, name: "API", value, binding: destination, binding_revision: null },
      context,
    );
    await codeAuthoringServices.secretSet({ codeId, name: "GONE", value, binding: destination, binding_revision: null }, context);
    const listed = await codeAuthoringServices.secretList({ codeId, limit: 20 }, context);
    expect(listed.items[0]).toMatchObject({ name: "API", configured: true, valueSetBy: id, valueSetAt: expect.any(String) });
    expect(JSON.stringify(listed)).not.toContain(value);
    const gone = listed.items.find((item) => item.name === "GONE")!;
    await codeAuthoringServices.secretDelete({ codeId, name: "GONE", binding_revision: gone.binding_revision }, context);

    // A stale page refuses instead of submitting over a newer version.
    await expect(codeAuthoringServices.resubmit({ codeId, baseVersionId: crypto.randomUUID() }, context)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const second = await codeAuthoringServices.resubmit({ codeId, baseVersionId: first.submission.version.id }, context);
    expect(second.submission.version.number).toBe(first.submission.version.number + 1);
    const diff = await codeAuthoringServices.diff({ codeId, versionId: second.submission.version.id }, context);
    const { configured: _configured, ...binding } = set.secret;
    expect(diff.diff.secrets).toEqual([binding]);
    expect(diff.diff.policyRows).toContain("internet");
    const pulled = await codeAuthoringServices.pull({ codeId }, context);
    expect(pulled.files["code.ts"]).toBe("export const monday = 1;");
    expect(JSON.stringify(diff)).not.toContain(value);
    own.mockRestore();
  });

  test("a binding check refuses this installation's own addresses before any value travels", async () => {
    const own = spyOn(origins, "readCodeOwnOrigins").mockResolvedValue(["https://cloud.example"]);
    try {
      const binding = { pathPrefix: "/", headers: ["authorization"] };
      const { codeId } = (await codeAuthoringServices.init({ title: "Binding check" }, context)).config;
      expect(
        await codeAuthoringServices.secretCheck({ codeId, binding: { ...binding, origin: "https://cloud.example" } }, context),
      ).toEqual({
        version: 1,
        allowed: false,
      });
      expect(
        await codeAuthoringServices.secretCheck({ codeId, binding: { ...binding, origin: "https://api.example.com" } }, context),
      ).toEqual({
        version: 1,
        allowed: true,
      });
    } finally {
      own.mockRestore();
    }
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
          policy: { silent: "shared" },
          input: z.object({ title: z.string().describe("Task title.") }).strict(),
          data: z.object({ id: z.string() }).strict(),
          review: () => {
            throw new Error("Real action reviews must never run in authoring tests");
          },
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
      'import {app, spaces} from "@sdk";\napp.schedule({ cron: "0 8 * * 1", name: "monday" }, async () => {\n  await spaces.space("sp_fixture").task.create({title: "Weekly review", idempotencyKey: "review:2030-01-07"});\n});\nexport default app;\n';
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
          if (event.name === "code_check") {
            const check = CodeChatCheckDataSchema.parse(event.result);
            expect(check.permissions).toEqual([{ ...permission, status: "new", title: null, typeTitle: "Space", own: false }]);
            expect(check.manifest?.policyRows).toEqual(["silent_shared"]);
          }
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
      // Resource ownership and its Code account are immutable from creation.
      const resourceCodeId = "c_resourcefixture";
      const accountId = "44444444-4444-4444-8444-444444444444";
      await sql`INSERT INTO auth.service_accounts(id,name,kind,created_by)
        VALUES(${accountId}::uuid,'code:spaces.space:sp_other','code',${otherId}::uuid)`;
      await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,title,service_account_id,created_by)
        VALUES(${resourceCodeId},'resource','spaces.space','sp_other','Other resource Code',${accountId}::uuid,${otherId}::uuid)`;
      for (const name of ["code_read", "code_pull", "code_sdk"])
        expect(CodeAuthoringErrorSchema.parse(await invoke(name, { codeId: resourceCodeId })).error.code).toBe("NOT_FOUND");
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
  test("pullAll is Cloud-admin-only and skips resource Code without editor rights", async () => {
    const nonAdmin = { ...context, authority: { ...context.authority, actor: { kind: "user" as const, user: { ...user, roles: [] } } } };
    await expect(codeAuthoringServices.pullAll({}, nonAdmin)).rejects.toThrow("Cloud administration");
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind,created_by) VALUES('code:example.box:box_1234','code',${id}::uuid) RETURNING id`;
    const [appAccount] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind,created_by) VALUES('code:app:example','code',${id}::uuid) RETURNING id`;
    if (!account || !appAccount) throw new Error("Missing test accounts");
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,title,service_account_id,created_by)
      VALUES('c_allresource','resource','example.box','box_1234','Resource',${account.id}::uuid,${id}::uuid)`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_app_id,title,service_account_id,created_by)
      VALUES('c_allapp','app','example','App',${appAccount.id}::uuid,${id}::uuid)`;
    const reader = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({
      ok: false,
      error: { code: "NOT_FOUND", message: "not installed", status: 404 },
    });
    const collect = async () => {
      const items: CodeAuthoringData<"pullAll">["items"] = [];
      let cursor: string | undefined;
      do {
        const page = codeAuthoringContracts.pullAll.data.parse(await codeAuthoringServices.pullAll({ cursor }, context));
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    };
    try {
      const items = await collect();
      const ids = items.map((item) => item.config.codeId);
      expect(ids).not.toContain("c_allresource");
      for (const id of ids) expect(id.startsWith("c_allperson") || id.startsWith("c_allapp")).toBe(false);
      for (const item of items) expect(item.config.owner.kind).toBe("resource");
      const owner = spyOn(access, "readCodeOwner").mockResolvedValue({ title: "Resource", admin: true });
      try {
        // The ordinary list carries no live owner grant; pullAll must resolve it before excluding this Code.
        expect((await collect()).map((item) => item.config.codeId)).toContain("c_allresource");
      } finally {
        owner.mockRestore();
      }
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
