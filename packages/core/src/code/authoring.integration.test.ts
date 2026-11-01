import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as catalog from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { type CodeCheckRequest, type CodeCheckResult, codeSdkHash } from "@k2b/cloud/code";
import type { User } from "@k2b/cloud/contracts";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
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
import { CodeAuthoringConflictSchema, type CodeAuthoringData, codeAuthoringContracts } from "./authoring-contracts";
import { codePolicyPreset } from "./policy-contracts";
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
