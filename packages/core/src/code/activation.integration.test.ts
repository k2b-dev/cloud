import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { type CodeAccessGrant, sql } from "@k2b/cloud";
import * as provider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CodeCheckedVersionManifest, User } from "@k2b/cloud/contracts";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { z } from "zod";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migratePwa } from "../migrate/core/pwa";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import { activateCodeVersion, cancelCodeActivation, processCodeActivation, readCodeActivation } from "./activation";
import { cleanupCodeActivation, codeActivationCleanupOutbox, reconcileCodeAccess } from "./activation-maintenance";
import { type CodeActivationTransport, CodeActivationTransportError } from "./activation-transport";
import * as authoringChecks from "./authoring-check";
import type { Code } from "./contracts";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { codeBundleHash, codeSourceHash, findCode } from "./store";
import { submitCodeVersion } from "./versions";

const fixed = new Date("2026-10-31T12:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111",
  adminId = "22222222-2222-4222-8222-222222222222",
  nextOwnerId = "44444444-4444-4444-8444-444444444444";
const person = (id: string, admin = false): User => ({
  id,
  uid: id,
  provider: "local",
  profile: "user",
  roles: admin ? ["admin"] : ["user"],
  givenname: "Test",
  sn: "Code",
  displayName: "Test Code",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context = (id = ownerId, admin = false): CodeContext => ({
  authority: {
    actor: { kind: "user", user: person(id, admin) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
    credentialProof: {
      kind: "session",
      userId: id,
      sid: "33333333-3333-4333-8333-333333333333",
      authEpoch: 0,
      expiresAt: "2026-11-01T12:00:00.000Z",
    },
  },
  locale: "de",
});
const owner = context(),
  administrator = context(adminId, true);
const operation = {
  title: "Fixture",
  description: "Fixture operation.",
  openWorld: false,
  input: z.object({}).strict(),
  data: z.object({}).strict(),
  run: () => ({ ok: true as const, data: { data: {} } }),
};
const action = {
  ...operation,
  review: () => ({
    ok: true as const,
    data: {
      locale: "en",
      slots: {},
      sentence: { action: "Change fixture", running: "Changing fixture", done: "Changed fixture", confirm: "Confirm", decline: "Cancel" },
    },
  }),
};
const catalog = compileCapabilityManifest("example", {
  protocolVersion: 2,
  types: { item: { title: "Item", description: "Fixture item.", reader: "item.read" } },
  queries: { "item.read": { ...operation, input: z.object({ id: z.string().describe("Item ID.") }).strict() } },
  actions: {
    "item.change": { ...action, target: "item", destructive: false, idempotency: "none", policy: { silent: "draft" } },
    "item.add": { ...action, target: "item", destructive: false, idempotency: "none", policy: { silent: "draft" } },
  },
});

let database: Awaited<ReturnType<typeof useFreshDatabase>>;
databaseSuite()("durable Code activation", () => {
  let serverCheck: ReturnType<typeof spyOn<typeof authoringChecks, "verifyCodeSubmission">>;
  let settingsSpy: ReturnType<typeof spyOn<typeof codeSettings, "get">>,
    readersSpy: ReturnType<typeof spyOn<typeof provider, "readResourcePrincipals">>,
    catalogSpy: ReturnType<typeof spyOn<typeof provider, "getCapabilityCatalogApp">>;
  let ordinal = 0;
  const live = new Map<string, CodeAccessGrant>(),
    tombstones = new Set<string>();
  const sets: Array<{ id: string; dryRun: boolean; grantId: string; person: string }> = [];
  const removals: string[] = [];
  let ownerAdministrator = ownerId;
  let targetReadable = true;
  let denyDry: string | null = null,
    denySet: string | null = null,
    crashAt: string | null = null,
    crashAfter = false,
    revoked = false,
    listDown = false;
  const transport: CodeActivationTransport = {
    set: async (input) => {
      sets.push({ id: input.item.target.id, dryRun: input.dryRun, grantId: input.item.grantId, person: input.activatingPerson });
      if (input.item.owner && input.activatingPerson !== adminId && input.activatingPerson !== ownerAdministrator)
        return { granted: false, reasonCode: "not_manager", reason: "Owner administrator changed." };
      if (tombstones.has(input.item.grantId)) return { granted: false, reasonCode: "removed", reason: "Removed by the target manager." };
      if (input.item.target.id === (input.dryRun ? denyDry : denySet))
        return {
          granted: false,
          reasonCode: "not_manager",
          reason: "Only this target is blocked.",
          readable: targetReadable,
          title: "Fixture target",
          managerUserIds: [nextOwnerId],
        };
      if (!input.dryRun && input.item.target.id === crashAt && !crashAfter) throw new CodeActivationTransportError("crash", true);
      const existing = live.get(input.item.grantId);
      if (existing) return { granted: true, grantId: existing.grantId, level: existing.level };
      if (!input.dryRun)
        live.set(input.item.grantId, {
          grantId: input.item.grantId,
          principal: input.principal,
          target: input.item.target,
          level: "write",
        });
      if (!input.dryRun && input.item.target.id === crashAt && crashAfter) throw new CodeActivationTransportError("lost_response", true);
      return {
        granted: true,
        grantId: input.item.grantId,
        level: "write",
        readable: targetReadable,
        title: "Fixture target",
        managerUserIds: [ownerId],
      };
    },
    notificationManagers: async () => [ownerId],
    list: async (_app, principal) => {
      if (listDown) throw new Error("Provider offline");
      return [...live.values()].filter((g) => g.principal === principal);
    },
    remove: async (appId, _principal, grantId) => {
      expect(appId).toBe("example");
      removals.push(grantId);
      live.delete(grantId);
      tombstones.add(grantId);
    },
  };
  const deps = {
    transport,
    catalog: async () => catalog,
    restoreAuthority: async (row: { activating_person: string | null }) =>
      revoked ? null : row.activating_person === adminId ? administrator : context(row.activating_person ?? ownerId),
  };
  const run = (id: string) => processCodeActivation(id, deps);
  async function newCode(): Promise<Code> {
    const id = `c_c9${String(++ordinal).padStart(4, "0")}`,
      ownerRef = `owner-${ordinal}`;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind) VALUES(${`code:example.item:${ownerRef}`},'code') RETURNING id`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,title,service_account_id,created_by)
      VALUES(${id},'resource','example.item',${ownerRef},'Weekly report',${account!.id}::uuid,${ownerId}::uuid)`;
    const [share] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${ownerId}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${id},${share!.id}::uuid)`;
    return (await findCode(id))!;
  }
  async function version(code: Code, targets = ["A", "B"], baseVersionId: string | null = null, op = "item.change") {
    const sourceFiles = { "code.ts": `export const version = '${++ordinal}';` },
      bundle = `bundle:${ordinal}`;
    const manifest: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      hashes: { source: codeSourceHash(sourceFiles, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      entrypoints: [{ kind: "manual", entrypoint: "run", cron: null, file: "code.ts", line: 1 }],
      policyRows: ["silent_draft"],
      ai: false,
      permissions: targets.map((id) => ({ operation: `example.${op}`, target: { type: "example.item", id }, file: "code.ts", line: 1 })),
    };
    return submitCodeVersion({ codeId: code.id, sourceFiles, bundle, manifest, baseVersionId }, owner);
  }
  async function start(code: Code, versionId: string, ctx = owner) {
    return activateCodeVersion({ codeId: code.id, versionId, activationId: crypto.randomUUID() }, ctx);
  }
  const status = (code: Code, id: string) => readCodeActivation({ codeId: code.id, activationId: id }, owner);
  beforeAll(async () => {
    // These checked fixtures exercise activation; scheduling integration covers the binding runner check.
    serverCheck = spyOn(authoringChecks, "verifyCodeSubmission").mockResolvedValue();
    setSystemTime(fixed);
    database = await useFreshDatabase("core_code_activation");
    await migrateAuth();
    readersSpy = spyOn(provider, "readResourcePrincipals").mockImplementation(async (input) => ({
      state: "checked",
      readable: [...input.principals],
    }));
    // These schemas depend only on auth. Keep session-family alterations in
    // order, while independent schemas avoid serial migration round trips.
    await Promise.all([
      (async () => {
        await migrateAppApproval();
        await migratePwa();
      })(),
      migrateSettings(),
      migrateAudit(),
      migrateCode(),
      migrateApprovals(),
    ]);
    await migratePolicy();
    await migrateVersions();
    await migrateActivation();
    // Exercise upgrades before status queries cache the original table result shape.
    await sql`ALTER TABLE code.activations DROP COLUMN cancel_requested`;
    await sql`CREATE INDEX activation_outbox_cleanup ON code.activation_outbox(id) WHERE kind='cleanup'`;
    await migrateActivation();
    expect(await sql`SELECT id FROM code.activations WHERE cancel_requested`).toHaveLength(0);
    expect(
      (await sql<{ index: string | null }[]>`SELECT to_regclass('code.activation_outbox_cleanup')::text AS index`)[0]!.index,
    ).toBeNull();
    for (const id of [ownerId, adminId, nextOwnerId])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${id},'local','user',${id === adminId})`;
    settingsSpy = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!definition) throw new Error(`Unexpected setting ${key}`);
      return definition.default;
    });
    catalogSpy = spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "example", appName: "Example", appIcon: "ti ti-code", appDescription: "Fixture", manifest: catalog },
    });
  });
  beforeEach(() => {
    ownerAdministrator = ownerId;
    targetReadable = true;
    live.clear();
    tombstones.clear();
    sets.length = 0;
    removals.length = 0;
    denyDry = denySet = crashAt = null;
    crashAfter = revoked = listDown = false;
  });
  afterAll(async () => {
    serverCheck?.mockRestore();
    settingsSpy?.mockRestore();
    catalogSpy?.mockRestore();
    readersSpy?.mockRestore();
    setSystemTime();
  });

  test("a target's dry-run no changes nothing and identifies exactly that target", async () => {
    const code = await newCode(),
      submitted = await version(code);
    denyDry = "B";
    const process = await start(code, submitted.version.id);
    await run(process.id);
    expect(await status(code, process.id)).toMatchObject({
      state: "failed",
      failure: { target: { type: "example.item", id: "B" }, code: "not_manager" },
    });
    expect(live.size).toBe(0);
    expect(sets.every((set) => set.dryRun)).toBe(true);
    expect((await findCode(code.id))!.activeVersionId).toBeNull();
    expect(await sql`SELECT id FROM auth.mandates WHERE workload_id=${submitted.version.id}`).toHaveLength(0);
  });
  test("an unregistered target fails visibly before target effects", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    await processCodeActivation(activation.id, { ...deps, catalog: async () => null });
    expect(await status(code, activation.id)).toMatchObject({
      state: "failed",
      failure: { code: "target_unavailable", target: { type: "example.item", id: "A" } },
    });
    expect(sets).toHaveLength(0);
    expect(live.size).toBe(0);
  });
  test("personal activation creates its owner's version mandate without resource grants", async () => {
    const id = `c_c9p${String(++ordinal).padStart(4, "0")}`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by) VALUES(${id},'person',${ownerId}::uuid,'Personal',${ownerId}::uuid)`;
    const code = (await findCode(id))!,
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    expect(sets).toHaveLength(0);
    const [mandate] = await sql<
      { subject_kind: string; subject_user_id: string; policy: { grants?: unknown } }[]
    >`SELECT * FROM auth.mandates WHERE workload_id=${submitted.version.id}`;
    expect(mandate).toMatchObject({ subject_kind: "user", subject_user_id: ownerId });
    expect(mandate!.policy.grants).toBeUndefined();
  });
  test("same permissions reuse grants and require only owner authority", async () => {
    const code = await newCode(),
      first = await version(code),
      activation = await start(code, first.version.id);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    const grants = [...live.keys()];
    sets.length = 0;
    denyDry = "A";
    denySet = "A";
    const second = await version(code, ["A", "B"], first.version.id),
      next = await start(code, second.version.id);
    await run(next.id);
    expect((await status(code, next.id)).state).toBe("active");
    expect([...live.keys()]).toEqual(grants);
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.every((set) => set.id.startsWith("owner-") && set.dryRun)).toBe(true);
    const [mandate] = await sql<{ policy: unknown }[]>`SELECT policy FROM auth.mandates WHERE workload_id=${second.version.id}`;
    expect(mandate!.policy).toMatchObject({
      grants: [
        { appId: "example", capabilityId: "item.change", kind: "action", target: { type: "example.item", id: "A" } },
        { appId: "example", capabilityId: "item.change", kind: "action", target: { type: "example.item", id: "B" } },
      ],
    });
  });
  test("explicit reactivation reuses an unchanged mandate but never resumes a separately paused mandate", async () => {
    const code = await newCode(),
      submitted = await version(code, ["A"]),
      first = await start(code, submitted.version.id);
    await run(first.id);
    const again = await start(code, submitted.version.id);
    await run(again.id);
    const firstStatus = await status(code, first.id);
    expect((await status(code, again.id)).mandateId).toBe(firstStatus.mandateId);
    expect(await sql`SELECT id FROM auth.mandates WHERE workload_id=${submitted.version.id}`).toHaveLength(1);
    await sql`UPDATE auth.mandates SET state='paused',revision=revision+1 WHERE id=${firstStatus.mandateId}::uuid`;
    const blocked = await start(code, submitted.version.id);
    await run(blocked.id);
    expect((await status(code, blocked.id)).state).toBe("failed");
    expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id=${firstStatus.mandateId}::uuid`)[0]!.state).toBe(
      "paused",
    );
    expect(live.size).toBe(1);
  });
  test("parallel workers serialize one activation and never issue a second set", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    await Promise.allSettled([run(activation.id), run(activation.id)]);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    expect(sets.filter((set) => !set.dryRun).map((set) => set.id)).toEqual(["A", "B"]);
    expect(live.size).toBe(2);
  });
  test("two distinct activations of the same Code complete in series", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      next = await version(code, ["B"], first.version.id);
    const a = await start(code, first.version.id),
      b = await start(code, next.version.id);
    const entered = Promise.withResolvers<void>();
    const firstRun = processCodeActivation(a.id, {
      ...deps,
      restoreAuthority: async (row) => {
        entered.resolve();
        return deps.restoreAuthority(row);
      },
    });
    await entered.promise;
    const secondRun = processCodeActivation(b.id, {
      ...deps,
      restoreAuthority: async (row) => {
        expect((await status(code, a.id)).state).toBe("active");
        return deps.restoreAuthority(row);
      },
    });
    await Promise.allSettled([firstRun, secondRun]);
    await run(b.id);
    expect((await status(code, b.id)).state).toBe("active");
    expect((await findCode(code.id))!.activeVersionId).toBe(next.version.id);
    expect(sets.filter((set) => !set.dryRun).map((set) => set.id)).toEqual(["A", "B"]);
  });
  test("a broader target permission requires that target administrator again", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      active = await start(code, first.version.id);
    await run(active.id);
    const oldGrants = [...live.keys()];
    const next = await version(code, ["A"], first.version.id, "item.add"),
      activation = await start(code, next.version.id);
    sets.length = 0;
    denyDry = "A";
    await run(activation.id);
    expect((await status(code, activation.id)).failure?.target).toEqual({ type: "example.item", id: "A" });
    expect(sets.some((set) => set.id === "A" && set.dryRun)).toBe(true);
    expect(sets.every((set) => set.dryRun)).toBe(true);
    expect([...live.keys()]).toEqual(oldGrants);
    expect((await findCode(code.id))!.activeVersionId).toBe(first.version.id);
  });
  test("a new owner administrator can reuse existing target permission; the previous one cannot", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      active = await start(code, first.version.id);
    await run(active.id);
    const oldGrants = [...live.keys()],
      next = await version(code, ["A"], first.version.id);
    ownerAdministrator = nextOwnerId;
    const previous = await start(code, next.version.id);
    await run(previous.id);
    expect((await status(code, previous.id)).failure?.target?.id).toBe(code.owner.kind === "resource" ? code.owner.ref.id : "");
    const [share] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${nextOwnerId}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${code.id},${share!.id}::uuid)`;
    sets.length = 0;
    denyDry = "A";
    const activation = await start(code, next.version.id, context(nextOwnerId));
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    expect(sets.every((set) => set.id.startsWith("owner-") && set.dryRun && set.person === nextOwnerId)).toBe(true);
    expect([...live.keys()]).toEqual(oldGrants);
  });
  test("crash between targets and a lost set response resume with the same proof grantId, never a duplicate", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    crashAt = "B";
    await expect(run(activation.id)).rejects.toThrow("crash");
    expect(live.size).toBe(1);
    const first = [...live.keys()][0];
    crashAfter = true;
    await expect(run(activation.id)).rejects.toThrow("lost_response");
    expect(live.size).toBe(2);
    crashAt = null;
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    expect(live.size).toBe(2);
    expect(live.has(first!)).toBe(true);
    expect(new Set(sets.filter((set) => set.id === "B").map((set) => set.grantId)).size).toBe(1);
  });
  test("late refusal rolls back only this process's own grants and preserves the active version", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      active = await start(code, first.version.id);
    await run(active.id);
    const oldGrant = [...live.keys()][0]!,
      next = await version(code, ["A", "B", "C"], first.version.id);
    denySet = "C";
    const activation = await start(code, next.version.id);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("failed");
    expect(live.has(oldGrant)).toBe(true);
    expect(removals).not.toContain(oldGrant);
    expect(live.size).toBe(1);
    expect((await findCode(code.id))!.activeVersionId).toBe(first.version.id);
  });
  test("removed target grant is observed but never restored by reconciliation or a crashed retry", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    crashAt = "B";
    await expect(run(activation.id)).rejects.toThrow();
    const removed = [...live.keys()][0]!;
    live.delete(removed);
    tombstones.add(removed);
    crashAt = null;
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("failed");
    expect(live.has(removed)).toBe(false);
    const next = await start(code, submitted.version.id);
    await run(next.id);
    const active = [...live.keys()][0]!;
    live.delete(active);
    tombstones.add(active);
    sets.length = 0;
    expect(await reconcileCodeAccess({ codeId: code.id }, owner, transport)).toContainEqual(
      // The Code page names who confirmed the grant and when, also after the target removed it.
      expect.objectContaining({
        grantId: active,
        state: "removed",
        activatedBy: expect.any(String),
        activatedAt: expect.any(String),
        activatedVersionId: expect.any(String),
      }),
    );
    expect(sets).toHaveLength(0);
    expect(live.has(active)).toBe(false);
  });
  test("removing an active grant makes a later activation require that target's authority again", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      active = await start(code, first.version.id);
    await run(active.id);
    const removed = [...live.keys()][0]!;
    live.delete(removed);
    tombstones.add(removed);
    const next = await version(code, ["A"], first.version.id);
    denyDry = "A";
    const blocked = await start(code, next.version.id);
    await run(blocked.id);
    expect((await status(code, blocked.id)).state).toBe("failed");
    expect(live.size).toBe(0);
    denyDry = null;
    const explicit = await start(code, next.version.id);
    await run(explicit.id);
    expect((await status(code, explicit.id)).state).toBe("active");
    expect(live.size).toBe(1);
    expect(live.has(removed)).toBe(false);
  });
  test("phone, service-account, API-key and invocation credentials cannot activate", async () => {
    const code = await newCode(),
      submitted = await version(code);
    const phone: CodeContext = {
      ...owner,
      authority: { ...owner.authority, actor: { kind: "user", user: person(ownerId), sessionKind: "app" } },
    };
    await expect(start(code, submitted.version.id, phone)).rejects.toThrow("phone");
    await expect(
      start(code, submitted.version.id, {
        ...owner,
        authority: {
          ...owner.authority,
          credentialKind: "api_key",
          scopes: ["write"],
          actor: {
            kind: "service_account",
            delegatedUser: person(ownerId),
            scopes: ["write"],
            serviceAccount: {
              id: code.serviceAccountId!,
              name: "CI user",
              kind: "user_delegated",
              status: "active",
              delegatedUserId: ownerId,
              appId: null,
              resourceType: null,
              resourceId: null,
              createdBy: ownerId,
              createdAt: fixed.toISOString(),
            },
          },
        },
      }),
    ).rejects.toThrow("browser");
    await expect(
      start(code, submitted.version.id, { ...owner, authority: { ...owner.authority, credentialKind: "invocation", scopes: ["write"] } }),
    ).rejects.toThrow("browser");
    await expect(
      start(code, submitted.version.id, { ...owner, authority: { ...owner.authority, credentialKind: "api_key", scopes: ["write"] } }),
    ).rejects.toThrow("browser");
  });
  test("production authority restore reads a real session and stops after its revocation", async () => {
    const code = await newCode(),
      submitted = await version(code),
      signIn = await createTestBrowserSignIn(ownerId);
    const signed: CodeContext = {
      ...owner,
      authority: {
        ...owner.authority,
        credentialProof: {
          kind: "session",
          userId: ownerId,
          sid: signIn.sid,
          authEpoch: 0,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    };
    const activation = await start(code, submitted.version.id, signed);
    crashAt = "B";
    await expect(processCodeActivation(activation.id, { transport, catalog: deps.catalog })).rejects.toThrow("crash");
    expect(live.size).toBe(1);
    await sql`UPDATE auth.session_families SET revoked_at=now() WHERE sid=${signIn.sid}::uuid`;
    await processCodeActivation(activation.id, { transport, catalog: deps.catalog });
    expect((await status(code, activation.id)).failure?.code).toBe("authority_revoked");
    expect(live.size).toBe(0);
  });
  test("a pending non-admin activation requires a fresh explicit process after administrator promotion", async () => {
    const code = await newCode(),
      submitted = await version(code),
      signIn = await createTestBrowserSignIn(ownerId);
    const signed: CodeContext = {
      ...owner,
      authority: {
        ...owner.authority,
        credentialProof: {
          kind: "session",
          userId: ownerId,
          sid: signIn.sid,
          authEpoch: 0,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    };
    const activation = await start(code, submitted.version.id, signed);
    try {
      await sql`UPDATE auth.users SET admin=TRUE WHERE id=${ownerId}::uuid`;
      await processCodeActivation(activation.id, { transport, catalog: deps.catalog });
      expect(await status(code, activation.id)).toMatchObject({ state: "failed", failure: { code: "authority_changed" } });
      expect(live.size).toBe(0);
    } finally {
      await sql`UPDATE auth.users SET admin=FALSE WHERE id=${ownerId}::uuid`;
    }
  });
  test("revoked activating authority compensates its grants without needing the revoked credential", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    crashAt = "B";
    await expect(run(activation.id)).rejects.toThrow();
    revoked = true;
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("failed");
    expect(live.size).toBe(0);
  });
  test("cleanup preserves the grants of a waiting activation", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      active = await start(code, first.version.id);
    await run(active.id);
    const next = await version(code, ["B", "C"], first.version.id),
      pending = await start(code, next.version.id);
    crashAt = "C";
    await expect(run(pending.id)).rejects.toThrow();
    const waitingIds = [...live.keys()];
    await cleanupCodeActivation(code.id, transport, async () => {});
    expect([...live.keys()]).toEqual(waitingIds);
    crashAt = null;
    await run(pending.id);
    expect((await status(code, pending.id)).state).toBe("active");
  });
  test("a cleanup delivery cannot consume a new cleanup request committed before its acknowledgement", async () => {
    const code = await newCode(),
      submitted = await version(code, ["A"]),
      active = await start(code, submitted.version.id);
    await run(active.id);
    const [row] = await sql<
      { id: string; attempts: number; code_id: string; activation_id: null }[]
    >`SELECT * FROM code.activation_outbox WHERE code_id=${code.id} AND kind='cleanup'`;
    expect(row).toBeDefined();
    await codeActivationCleanupOutbox.dispatch(row!, async () => {
      await cleanupCodeActivation(code.id, transport, async () => {});
      await sql`INSERT INTO code.activation_outbox(code_id,kind) VALUES(${code.id},'cleanup')`;
    });
    expect(await sql`SELECT id FROM code.activation_outbox WHERE code_id=${code.id} AND kind='cleanup'`).toHaveLength(1);
  });
  test("enqueue and cancellation return while a worker is inside a target request", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      next = await version(code, ["B"], first.version.id);
    const active = await start(code, first.version.id),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const worker = processCodeActivation(active.id, {
      ...deps,
      transport: {
        ...transport,
        set: async (input, ctx) => {
          if (!input.dryRun) {
            entered.resolve();
            await release.promise;
          }
          return transport.set(input, ctx);
        },
      },
    });
    try {
      await entered.promise;
      const queued = await start(code, next.version.id);
      expect(queued.state).toBe("pending");
      expect((await cancelCodeActivation({ codeId: code.id, activationId: active.id }, owner)).state).toBe("rolling_back");
      await expect(run(queued.id)).rejects.toThrow("activation_busy");
    } finally {
      release.resolve();
      await worker;
    }
    expect((await status(code, active.id)).state).toBe("cancelled");
    expect(live.size).toBe(0);
  });
  test("cancellation after the final checkpoint prevents the active-version commit", async () => {
    const code = await newCode(),
      submitted = await version(code, ["A"]),
      activation = await start(code, submitted.version.id);
    let cancelled = false;
    await processCodeActivation(activation.id, {
      ...deps,
      transport: {
        ...transport,
        list: async (app, principal) => {
          if (live.size && !cancelled) {
            cancelled = true;
            await cancelCodeActivation({ codeId: code.id, activationId: activation.id }, owner);
          }
          return transport.list(app, principal);
        },
      },
    });
    expect(cancelled).toBe(true);
    expect(await status(code, activation.id)).toMatchObject({ state: "cancelled", failure: { code: "cancelled" } });
    expect((await findCode(code.id))!.activeVersionId).toBeNull();
    expect(await sql`SELECT id FROM auth.mandates WHERE workload_id=${submitted.version.id}`).toHaveLength(0);
    expect(live.size).toBe(0);
  });
  test("cancellation during rollback preserves the target's original refusal", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    denySet = "B";
    await expect(
      processCodeActivation(activation.id, {
        ...deps,
        transport: {
          ...transport,
          remove: async () => {
            throw new Error("Cleanup offline");
          },
        },
      }),
    ).rejects.toThrow("Cleanup offline");
    const refused = { target: { type: "example.item", id: "B" }, code: "not_manager" };
    expect(await cancelCodeActivation({ codeId: code.id, activationId: activation.id }, owner)).toMatchObject({
      state: "rolling_back",
      failure: refused,
    });
    await run(activation.id);
    expect(await status(code, activation.id)).toMatchObject({ state: "failed", failure: refused });
    expect(live.size).toBe(0);
  });
  test("old versions retain grants and mandate until their last queued or running run finishes", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      active = await start(code, first.version.id);
    await run(active.id);
    const oldGrant = [...live.keys()][0]!;
    const [runRow] = await sql<
      { id: string }[]
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit,created_at)
      VALUES(${code.id},${first.version.id}::uuid,'manual','run',1024,10,${fixed}) RETURNING id`;
    const next = await version(code, ["B"], first.version.id),
      activation = await start(code, next.version.id);
    await run(activation.id);
    await expect(cleanupCodeActivation(code.id, transport, async () => {})).rejects.toThrow("draining");
    expect(live.has(oldGrant)).toBe(true);
    await sql`UPDATE code.runs SET state='succeeded',ended_at=${fixed} WHERE id=${runRow!.id}::uuid`;
    await cleanupCodeActivation(code.id, transport, async () => {});
    expect(live.has(oldGrant)).toBe(false);
    expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE workload_id=${first.version.id}`)[0]!.state).toBe(
      "revoked",
    );
  });
  test("owner deletion leaves the grant journal for durable lifecycle cleanup", async () => {
    const code = await newCode(),
      submitted = await version(code, ["A"]),
      activation = await start(code, submitted.version.id);
    await run(activation.id);
    const grants = [...live.keys()];
    await sql`UPDATE code.codes SET state='deleting',active_version_id=NULL WHERE id=${code.id}`;
    await cleanupCodeActivation(code.id, transport, async () => {
      throw new Error("Deleted Code must not send activation notices");
    });
    expect(removals).toEqual([]);
    expect([...live.keys()]).toEqual(grants);
    expect(await sql`SELECT grant_id FROM code.target_grants WHERE code_id=${code.id} AND state='granted'`).toHaveLength(grants.length);
    expect(await sql`SELECT id FROM code.activations WHERE id=${activation.id}::uuid`).toHaveLength(1);
  });
  test("unreadable target refusal persists and returns neither title nor managers; readable refusal keeps both", async () => {
    for (const readable of [false, true]) {
      targetReadable = readable;
      const code = await newCode(),
        submitted = await version(code, ["B"]),
        activation = await start(code, submitted.version.id);
      denyDry = "B";
      await run(activation.id);
      const result = await status(code, activation.id);
      expect(result.state).toBe("failed");
      expect(result.failure).toMatchObject({ target: { type: "example.item", id: "B" }, code: "not_manager", readable });
      const [saved] = await sql<
        { failure: unknown; plan: unknown }[]
      >`SELECT failure,plan FROM code.activations WHERE id=${activation.id}::uuid`;
      expect(JSON.stringify(saved!.plan)).not.toContain("managerUserIds");
      expect(JSON.stringify(saved!.plan)).not.toContain("Fixture target");
      if (readable) {
        expect(result.failure).toMatchObject({ title: "Fixture target", managerUserIds: [nextOwnerId] });
        expect(saved!.failure).toMatchObject({ title: "Fixture target", managerUserIds: [nextOwnerId] });
        // The page needs names; they exist only in the answer to someone who just passed the reader check.
        expect(result.failure?.managerNames).toHaveLength(1);
        expect(saved!.failure).not.toHaveProperty("managerNames");
        // Losing read access also removes presentation on an existing status response.
        readersSpy.mockResolvedValueOnce({ state: "checked", readable: [] });
        const hidden = await status(code, activation.id);
        expect(hidden.failure).not.toHaveProperty("title");
        expect(hidden.failure).not.toHaveProperty("managerUserIds");
        expect(hidden.failure).not.toHaveProperty("managerNames");
      } else {
        expect(result.failure).toMatchObject({ reason: "Einschalten kann nur, wer dieses Ziel verwaltet" });
        for (const value of [result, saved]) {
          expect(JSON.stringify(value)).not.toContain("Fixture target");
          expect(JSON.stringify(value)).not.toContain(nextOwnerId);
          expect(JSON.stringify(value)).not.toContain("managerUserIds");
        }
      }
    }
  });
  test("Core outage reasons remain useful when the target is unreadable", async () => {
    const code = await newCode(),
      submitted = await version(code, ["A"]),
      activation = await start(code, submitted.version.id);
    targetReadable = false;
    crashAt = "A";
    await expect(run(activation.id)).rejects.toThrow("crash");
    expect((await status(code, activation.id)).failure).toEqual({
      target: { type: "example.item", id: "A" },
      code: "activation_retry",
      reason: "Activation is waiting for a dependency. Retry is automatic; the old version stays active.",
    });
    const failure = {
      target: { type: "app", id: "example" },
      code: "target_unavailable",
      reason: "The target operation catalog is unavailable. Activate again after the application is ready.",
    };
    await sql`UPDATE code.activations SET failure=${JSON.stringify(failure)}::text::jsonb WHERE id=${activation.id}::uuid`;
    expect((await status(code, activation.id)).failure).toEqual(failure);
  });
  test("saved answers without a reader decision use the current viewer's read access", async () => {
    const code = await newCode(),
      submitted = await version(code, ["B"]),
      activation = await start(code, submitted.version.id);
    denyDry = "B";
    await run(activation.id);
    const failure = {
      target: { type: "example.item", id: "B" },
      code: "not_manager",
      reason: "Fixture target requires management",
      title: "Fixture target",
      managerUserIds: [nextOwnerId],
    };
    await sql`UPDATE code.activations SET failure=${JSON.stringify(failure)}::text::jsonb WHERE id=${activation.id}::uuid`;
    readersSpy.mockResolvedValueOnce({ state: "checked", readable: [] });
    const hidden = await status(code, activation.id);
    expect(hidden.failure).toEqual({
      target: failure.target,
      code: failure.code,
      reason: "Einschalten kann nur, wer dieses Ziel verwaltet",
      readable: false,
    });
    expect(JSON.stringify(hidden)).not.toContain("Fixture target");
    expect(JSON.stringify(hidden)).not.toContain(nextOwnerId);
    expect((await status(code, activation.id)).failure).toEqual({ ...failure, managerNames: [nextOwnerId] });
    // A guest who may read the target learns no other person's name, as in directory search.
    const guest = {
      ...owner,
      authority: { ...owner.authority, actor: { kind: "user" as const, user: { ...person(ownerId), roles: ["guest" as const] } } },
    };
    const asGuest = await readCodeActivation({ codeId: code.id, activationId: activation.id }, guest);
    expect(asGuest.failure).not.toHaveProperty("managerNames");
  });
  test("unreadable Cloud-admin activation uses server-only recipients and still sends each notice once", async () => {
    targetReadable = false;
    const code = await newCode(),
      submitted = await version(code, ["A"]),
      activation = await start(code, submitted.version.id, administrator);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    const [saved] = await sql<{ plan: unknown }[]>`SELECT plan FROM code.activations WHERE id=${activation.id}::uuid`;
    expect(JSON.stringify(saved!.plan)).not.toContain("managerUserIds");
    expect(JSON.stringify(saved!.plan)).not.toContain("Fixture target");
    expect(
      await sql`SELECT grant_id FROM code.target_grants WHERE activation_id=${activation.id}::uuid AND cardinality(manager_user_ids)>0`,
    ).toHaveLength(0);
    const delivered: string[] = [];
    const notify = async (input: { userId: string; target: { id: string } }) => {
      expect(input.userId).toBe(ownerId);
      delivered.push(input.target.id);
    };
    await cleanupCodeActivation(code.id, transport, notify);
    await cleanupCodeActivation(code.id, transport, notify);
    expect(delivered.sort()).toEqual(["A", code.owner.kind === "resource" ? code.owner.ref.id : ""].sort());
    expect(
      await sql`SELECT target FROM code.activation_notices WHERE activation_id=${activation.id}::uuid AND jsonb_typeof(target)<>'object'`,
    ).toHaveLength(0);
  });
  test("persisted target objects route rollback to the provider and remove every newly applied grant", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    denySet = "B";
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("failed");
    const rows = await sql<
      { target: { type: string; id: string }; state: string }[]
    >`SELECT target,state FROM code.target_grants WHERE activation_id=${activation.id}::uuid ORDER BY target->>'id'`;
    expect(rows.map((row) => row.target)).toEqual([
      { type: "example.item", id: "A" },
      { type: "example.item", id: "B" },
    ]);
    expect(rows.every((row) => row.state === "released")).toBe(true);
    expect(removals).toHaveLength(2);
    expect(live.size).toBe(0);
    const [saved] = await sql<
      { authority: unknown; plan: unknown; failure: unknown; mandate_policy: unknown }[]
    >`SELECT authority,plan,failure,mandate_policy FROM code.activations WHERE id=${activation.id}::uuid`;
    expect(Array.isArray(saved!.plan)).toBe(true);
    expect(typeof saved!.failure).toBe("object");
    expect(typeof saved!.mandate_policy).toBe("object");
  });
  test("Cloud-admin activation changes no personal shares and emits one durable notice per affected target", async () => {
    const code = await newCode(),
      submitted = await version(code, ["A"]),
      activation = await start(code, submitted.version.id, administrator);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    const delivered: string[] = [];
    const notify = async (input: { target: { id: string } }) => {
      delivered.push(input.target.id);
    };
    await cleanupCodeActivation(code.id, transport, notify);
    await cleanupCodeActivation(code.id, transport, notify);
    expect(delivered.sort()).toEqual(["A", code.owner.kind === "resource" ? code.owner.ref.id : ""].sort());
    expect(await sql`SELECT id FROM auth.access WHERE user_id=${adminId}::uuid`).toHaveLength(0);
  });
  test("activation identities are idempotent and cancellation compensates an interrupted process", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    expect((await activateCodeVersion({ codeId: code.id, versionId: submitted.version.id, activationId: activation.id }, owner)).id).toBe(
      activation.id,
    );
    crashAt = "B";
    await expect(run(activation.id)).rejects.toThrow();
    await cancelCodeActivation({ codeId: code.id, activationId: activation.id }, owner);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("cancelled");
    expect(live.size).toBe(0);
    await migrateActivation();
    await migrateActivation();
    expect(await sql`SELECT id FROM code.activations WHERE id=${activation.id}::uuid AND cancel_requested`).toHaveLength(1);
    expect(
      (await sql<{ index: string | null }[]>`SELECT to_regclass('code.activation_outbox_cleanup')::text AS index`)[0]!.index,
    ).toBeNull();
    expect((await status(code, activation.id)).state).toBe("cancelled");
  });
});

// The session fixture's file-level cleanup runs before the private database is removed.
afterAll(async () => {
  await database?.drop();
});
