import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as provider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CodeCheckedVersionManifest, User } from "@k2b/cloud/contracts";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { z } from "zod";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAppEvents } from "../migrate/core/app-events";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migratePwa } from "../migrate/core/pwa";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import { activateCodeVersion, cancelCodeActivation, previewCodeActivation, processCodeActivation, readCodeActivation } from "./activation";
import { cleanupCodeActivation, codeActivationCleanupOutbox } from "./activation-maintenance";
import * as authoringChecks from "./authoring-check";
import type { Code } from "./contracts";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { codeBundleHash, codeSourceHash, findCode, insertCodeRun, readCode } from "./store";
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
  let ownerAdministrator = ownerId,
    revoked = false;
  const ownerChecks: string[] = [];
  const deps = {
    readOwner: async (_ref: unknown, ctx: CodeContext) => {
      const id = ctx.authority.actor.kind === "user" ? ctx.authority.actor.user.id : "";
      ownerChecks.push(id);
      return { title: "Owner", admin: id === ownerAdministrator };
    },
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
  async function version(
    code: Code,
    targets = ["A", "B"],
    baseVersionId: string | null = null,
    op = "item.change",
    eventPlace?: { type: string; id: string },
  ) {
    const sourceFiles = { "code.ts": `export const version = '${++ordinal}';` },
      bundle = `bundle:${ordinal}`;
    const manifest: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      hashes: { source: codeSourceHash(sourceFiles, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      entrypoints: eventPlace
        ? [
            {
              kind: "event",
              entrypoint: "event:example.changed@1:place:0",
              event: { type: "example.changed", version: 1, place: eventPlace },
              cron: null,
              file: "code.ts",
              line: 1,
            },
          ]
        : [{ kind: "manual", entrypoint: "run", title: "Lieferungen eintragen", cron: null, file: "code.ts", line: 1 }],
      policyRows: ["silent_draft"],
      ai: false,
      // The checker could place the call at A in the run entrypoint, not the one at B.
      permissions: targets.map((id) => ({
        operation: `example.${op}`,
        target: { type: "example.item", id },
        file: "code.ts",
        line: 1,
        ...(id === "A" ? { entrypoints: ["run"] } : {}),
      })),
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
    await migrateEvents();
    await migrateAppEvents();
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
    revoked = false;
    ownerChecks.length = 0;
  });
  afterAll(async () => {
    serverCheck?.mockRestore();
    settingsSpy?.mockRestore();
    catalogSpy?.mockRestore();
    readersSpy?.mockRestore();
    setSystemTime();
  });

  test("legacy mandate keeps its policy, asks for confirmation, and pauses at the next version switch", async () => {
    const code = await newCode();
    const first = await version(code);
    const activation = await start(code, first.version.id);
    await run(activation.id);
    const policy = { version: 1, apps: ["example"], operations: ["capability.query:item.read"], actions: "deny" };
    await sql`UPDATE auth.mandates SET policy=${JSON.stringify(policy)}::text::jsonb
      WHERE workload_id=${first.version.id}`;
    expect((await readCode(code.id, administrator)).code.needsReconfirmation).toBe(true);
    const [before] = await sql`SELECT id,policy,revision::int,state FROM auth.mandates WHERE workload_id=${first.version.id}`;
    expect(before).toMatchObject({ policy, state: "active" });
    // Submitting alone leaves the old entry and its exact policy in force.
    const next = await version(code, ["A"], first.version.id);
    expect((await sql`SELECT state,policy FROM auth.mandates WHERE id=${before!.id}::uuid`)[0]).toMatchObject({ state: "active", policy });
    const nextActivation = await start(code, next.version.id);
    await run(nextActivation.id);
    expect((await status(code, nextActivation.id)).state).toBe("active");
    expect((await sql`SELECT state,policy,revision::int FROM auth.mandates WHERE id=${before!.id}::uuid`)[0]).toMatchObject({
      state: "paused",
      policy,
      revision: Number(before!.revision) + 1,
    });
    expect((await readCode(code.id, administrator)).code.needsReconfirmation).toBe(false);
    const [audit] = await sql`SELECT metadata FROM audit.events WHERE action='core.code.activated' AND request_id=${nextActivation.id}`;
    expect(audit?.metadata.pausedLegacyMandateIds).toEqual([before!.id]);
    expect((await sql`SELECT state,policy FROM auth.mandates WHERE workload_id=${next.version.id}`)[0]).toMatchObject({
      state: "active",
      policy: null,
    });
  });

  test.each([true, false])("foreign-place activation checks account readability (allowed=%s)", async (allowed) => {
    const code = await newCode();
    const place = { type: "spaces.space", id: "Spc001" };
    const submitted = await version(code, [], null, "item.change", place);
    const readers = readersSpy.mockImplementation(async (input) => ({ state: "checked", readable: allowed ? [...input.principals] : [] }));
    try {
      const activation = await start(code, submitted.version.id);
      await run(activation.id);
      const result = await status(code, activation.id);
      expect(readers).toHaveBeenCalledWith(
        expect.objectContaining({ ref: place, principals: [{ type: "service_account", serviceAccountId: code.serviceAccountId }] }),
      );
      if (allowed) {
        expect(result.state).toBe("active");
        expect(
          (await sql`SELECT resource_binding FROM events.app_subscriptions WHERE resource_binding->>'key'=${code.id}`)[0]?.resource_binding
            .place,
        ).toEqual(place);
      } else {
        expect(result).toMatchObject({ state: "failed", failure: { code: "FORBIDDEN" } });
        expect(result.failure?.reason).toContain("cannot read");
        expect(await sql`SELECT id FROM events.app_subscriptions WHERE resource_binding->>'key'=${code.id}`).toHaveLength(0);
        expect((await findCode(code.id))?.activeVersionId).toBeNull();
      }
    } finally {
      readersSpy.mockImplementation(async (input) => ({ state: "checked", readable: [...input.principals] }));
    }
  });

  test("personal activation creates its owner's version mandate without resource grants", async () => {
    const id = `c_c9p${String(++ordinal).padStart(4, "0")}`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by) VALUES(${id},'person',${ownerId}::uuid,'Personal',${ownerId}::uuid)`;
    const code = (await findCode(id))!,
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    expect(ownerChecks).toHaveLength(0);
    const [mandate] = await sql<
      { subject_kind: string; subject_user_id: string; policy: unknown }[]
    >`SELECT * FROM auth.mandates WHERE workload_id=${submitted.version.id}`;
    expect(mandate).toMatchObject({ subject_kind: "user", subject_user_id: ownerId });
    expect(mandate!.policy).toBeNull();
    expect(mandate).toMatchObject({ owner_app_id: "runner", state: "active", confirmation_deadline: null });
  });

  test("personal policy-free activation requires the owner's browser, never OAuth, phone or key", async () => {
    const id = `c_c9p${String(++ordinal).padStart(4, "0")}`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by) VALUES(${id},'person',${ownerId}::uuid,'Personal',${ownerId}::uuid)`;
    const code = (await findCode(id))!,
      submitted = await version(code);
    const oauth = context();
    oauth.authority.credentialKind = "oauth";
    oauth.authority.scopes = ["write"];
    oauth.authority.credentialProof = { kind: "oauth", payload: {} };
    await expect(
      activateCodeVersion({ codeId: code.id, versionId: submitted.version.id, activationId: crypto.randomUUID() }, oauth),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Personal Code activation requires its owner's browser session." });
    expect((await previewCodeActivation({ codeId: code.id, versionId: submitted.version.id }, oauth)).allowed).toEqual({
      allowed: false,
      reason: "credential",
    });
    const queued = await start(code, submitted.version.id);
    expect((await cancelCodeActivation({ codeId: code.id, activationId: queued.id }, oauth)).state).toBe("rolling_back");
    const key = context();
    key.authority.credentialKind = "api_key";
    key.authority.scopes = ["write"];
    const phone = context();
    if (phone.authority.actor.kind === "user") phone.authority.actor.sessionKind = "app";
    for (const invalid of [key, phone]) {
      await expect(
        activateCodeVersion({ codeId: code.id, versionId: submitted.version.id, activationId: crypto.randomUUID() }, invalid),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Only a browser session or a personal OAuth credential can activate Code; phone sessions cannot activate.",
      });
    }
    expect(await sql`SELECT id FROM auth.mandates WHERE workload_id=${submitted.version.id}`).toHaveLength(0);
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
      await processCodeActivation(activation.id, { readOwner: deps.readOwner });
      expect(await status(code, activation.id)).toMatchObject({ state: "failed", failure: { code: "authority_changed" } });
    } finally {
      await sql`UPDATE auth.users SET admin=FALSE WHERE id=${ownerId}::uuid`;
    }
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
      await cleanupCodeActivation(code.id);
      await sql`INSERT INTO code.activation_outbox(code_id,kind) VALUES(${code.id},'cleanup')`;
    });
    expect(await sql`SELECT id FROM code.activation_outbox WHERE code_id=${code.id} AND kind='cleanup'`).toHaveLength(1);
  });

  test("old versions retain their entry until their last queued or running run finishes", async () => {
    const code = await newCode(),
      first = await version(code, ["A"]),
      active = await start(code, first.version.id);
    await run(active.id);
    const [runRow] = await sql<
      { id: string }[]
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit,created_at)
      VALUES(${code.id},${first.version.id}::uuid,'manual','run',1024,10,${fixed}) RETURNING id`;
    const next = await version(code, ["B"], first.version.id),
      activation = await start(code, next.version.id);
    await run(activation.id);
    await expect(cleanupCodeActivation(code.id)).rejects.toThrow("draining");
    await sql`UPDATE code.runs SET state='succeeded',ended_at=${fixed} WHERE id=${runRow!.id}::uuid`;
    await cleanupCodeActivation(code.id);
    expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE workload_id=${first.version.id}`)[0]!.state).toBe(
      "revoked",
    );
  });

  test("activation and preview never ask target apps, even for unknown and dynamic manifest targets", async () => {
    const code = await newCode();
    const submitted = await version(code, ["A", "B"]);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          throw new Error("No target requests during activation");
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const preview = await previewCodeActivation({ codeId: code.id, versionId: submitted.version.id }, owner);
      expect(preview).not.toHaveProperty("rows");
      // The card lists the Code page's targets from registry manifests: the own place first, every target new.
      if (code.owner.kind !== "resource") throw new Error("Expected resource Code");
      const target = (id: string, own: boolean) =>
        expect.objectContaining({ ref: { type: "example.item", id }, typeTitle: "Item", own, href: null });
      expect(preview.targets).toEqual([
        { target: target(code.owner.ref.id, true), operations: [], isNew: false },
        { target: target("A", false), operations: ["example.item.change"], isNew: true },
        { target: target("B", false), operations: ["example.item.change"], isNew: true },
      ]);
      const activation = await start(code, submitted.version.id);
      await run(activation.id);
      expect((await status(code, activation.id)).state).toBe("active");
      expect((await findCode(code.id))!.activeVersionId).toBe(submitted.version.id);
      const [entry] = await sql`SELECT * FROM auth.mandates WHERE workload_id=${submitted.version.id}`;
      expect(entry).toMatchObject({
        owner_app_id: "runner",
        subject_service_account_id: code.serviceAccountId,
        policy: null,
        state: "active",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ownerChecks.length).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  test("an explicit Code editor cannot bypass the current owner manager check", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    ownerAdministrator = nextOwnerId;
    await run(activation.id);
    expect(await status(code, activation.id)).toMatchObject({ state: "failed", failure: { code: "not_owner_manager", target: null } });
    expect((await findCode(code.id))!.activeVersionId).toBeNull();
    expect(await sql`SELECT id FROM auth.mandates WHERE workload_id=${submitted.version.id}`).toHaveLength(0);
  });
  test("owner unavailability retries without changing the active version; revoked authority stops it", async () => {
    const code = await newCode(),
      first = await version(code),
      active = await start(code, first.version.id);
    await run(active.id);
    const next = await version(code, ["C"], first.version.id),
      activation = await start(code, next.version.id);
    await expect(
      processCodeActivation(activation.id, {
        ...deps,
        readOwner: async () => {
          throw new Error("Owner offline");
        },
      }),
    ).rejects.toThrow("Owner offline");
    expect((await status(code, activation.id)).state).toBe("waiting");
    expect((await findCode(code.id))!.activeVersionId).toBe(first.version.id);
    revoked = true;
    await run(activation.id);
    expect(await status(code, activation.id)).toMatchObject({ state: "failed", failure: { code: "authority_revoked" } });
    expect((await findCode(code.id))!.activeVersionId).toBe(first.version.id);
  });
  test("enqueue and cancel remain available during an owner check; cancellation prevents the atomic switch", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const worker = processCodeActivation(activation.id, {
      ...deps,
      readOwner: async (...args) => {
        entered.resolve();
        await release.promise;
        return deps.readOwner(...args);
      },
    });
    try {
      await entered.promise;
      expect((await start(code, submitted.version.id)).state).toBe("pending");
      expect((await cancelCodeActivation({ codeId: code.id, activationId: activation.id }, owner)).state).toBe("rolling_back");
    } finally {
      release.resolve();
      await worker;
    }
    expect((await status(code, activation.id)).state).toBe("cancelled");
    expect((await findCode(code.id))!.activeVersionId).toBeNull();
    expect(await sql`SELECT id FROM auth.mandates WHERE workload_id=${submitted.version.id}`).toHaveLength(0);
  });
  test("parallel duplicate deliveries are idempotent and one version has one confirmed entry", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    const attempts = await Promise.allSettled([run(activation.id), run(activation.id)]);
    expect(attempts.some((a) => a.status === "fulfilled")).toBe(true);
    await run(activation.id);
    expect((await status(code, activation.id)).state).toBe("active");
    expect(await sql`SELECT id FROM auth.mandates WHERE workload_id=${submitted.version.id}`).toHaveLength(1);
    expect((await activateCodeVersion({ codeId: code.id, versionId: submitted.version.id, activationId: activation.id }, owner)).id).toBe(
      activation.id,
    );
  });
  test("preview retains local activator attribution without any target-manager lookup", async () => {
    const code = await newCode(),
      submitted = await version(code),
      activation = await start(code, submitted.version.id);
    await run(activation.id);
    await sql`UPDATE auth.users SET display_name='Activation owner' WHERE id=${ownerId}::uuid`;
    const [share] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${nextOwnerId}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${code.id},${share!.id}::uuid)`;
    const preview = await previewCodeActivation({ codeId: code.id, versionId: submitted.version.id }, context(nextOwnerId));
    expect(preview.activated).toMatchObject({ byYou: false, byName: "Activation owner" });
    const hidden = context(nextOwnerId);
    if (hidden.authority.actor.kind === "user") hidden.authority.actor.user.roles = ["guest"];
    expect((await previewCodeActivation({ codeId: code.id, versionId: submitted.version.id }, hidden)).activated?.byName).toBeNull();
  });

  test("migration preserves active, draining and ordinary shares, finishes obsolete compensation and runs once", async () => {
    const code = await newCode(),
      obsolete = await version(code),
      obsoleteActivation = await start(code, obsolete.version.id);
    await run(obsoleteActivation.id);
    const prior = await version(code, ["A"], obsolete.version.id),
      first = await start(code, prior.version.id);
    await run(first.id);
    const current = await version(code, ["A"], prior.version.id),
      active = await start(code, current.version.id);
    await run(active.id);
    await insertCodeRun({ codeId: code.id, versionId: prior.version.id, trigger: "manual", entrypoint: "run", input: null });
    const submitted = await version(code, ["A", "B"], current.version.id),
      pending = await start(code, submitted.version.id),
      cancelling = await start(code, submitted.version.id),
      failed = await start(code, submitted.version.id);
    const oldFailure = {
      target: { type: "example.item", id: "old" },
      code: "not_manager",
      reason: "Original reason",
      managerNames: ["Old manager"],
    };
    await sql`UPDATE code.activations SET state='failed',failure=${JSON.stringify(oldFailure)}::text::jsonb WHERE id=${failed.id}::uuid`;
    await sql`UPDATE code.activations SET state='applying' WHERE id=${pending.id}::uuid`;
    await sql`UPDATE code.activations SET state='rolling_back',failure=${JSON.stringify({ target: { type: "example.item", id: "old" }, code: "cancelled", reason: "Cancelled", managerNames: ["Old manager"] })}::text::jsonb WHERE id=${cancelling.id}::uuid`;
    // These are the actual old table contracts, including ownership and version FKs.
    await sql`CREATE TABLE code.target_grants (
      grant_id UUID PRIMARY KEY, code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      activation_id UUID NOT NULL REFERENCES code.activations(id) ON DELETE CASCADE,
      target JSONB NOT NULL, operations TEXT[] NOT NULL, level TEXT,
      state TEXT NOT NULL CHECK(state IN ('planned','attempting','granted','removed','released')),
      manager_user_ids UUID[] NOT NULL DEFAULT '{}')`;
    await sql`CREATE TABLE code.version_grants (
      version_id UUID NOT NULL REFERENCES code.versions(id) ON DELETE CASCADE,
      grant_id UUID NOT NULL REFERENCES code.target_grants(grant_id) ON DELETE CASCADE,
      PRIMARY KEY(version_id,grant_id))`;
    await sql`CREATE TABLE code.a4_target_shares(access_id UUID REFERENCES auth.access(id) ON DELETE CASCADE, target_id TEXT)`;
    const share = async (permission: "read" | "write", target: string) => {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.access(service_account_id,permission)
        VALUES(${code.serviceAccountId}::uuid,${permission}::auth.permission_level) RETURNING id`;
      await sql`INSERT INTO code.a4_target_shares VALUES(${row!.id}::uuid,${target})`;
      return row!.id;
    };
    const activeShare = await share("write", "active"),
      drainingShare = await share("read", "draining"),
      ordinaryShare = await share("read", "ordinary"),
      abandonedShare = await share("write", "pending"),
      cancelledShare = await share("write", "cancelled"),
      obsoleteShare = await share("read", "obsolete");
    const journal = async (grantId: string, activationId: string, state: "attempting" | "granted") =>
      sql`INSERT INTO code.target_grants(grant_id,code_id,activation_id,target,operations,level,state)
        VALUES(${grantId}::uuid,${code.id},${activationId}::uuid,'{"type":"example.item","id":"fixture"}',ARRAY['example.item.change'],'write',${state})`;
    await journal(obsoleteShare, obsoleteActivation.id, "granted");
    await journal(activeShare, active.id, "granted");
    await journal(drainingShare, first.id, "granted");
    await journal(abandonedShare, pending.id, "attempting");
    await journal(cancelledShare, cancelling.id, "granted");
    // A stale journal without a real share must not create one.
    await journal(crypto.randomUUID(), pending.id, "granted");
    await sql`INSERT INTO code.version_grants VALUES(${obsolete.version.id}::uuid,${obsoleteShare}::uuid),(${current.version.id}::uuid,${activeShare}::uuid),(${prior.version.id}::uuid,${drainingShare}::uuid)`;
    const retained = [activeShare, drainingShare, ordinaryShare].sort();
    const before = await sql`SELECT * FROM auth.access WHERE id=ANY(${sql.array(retained, "uuid")}) ORDER BY id`;
    const junctionBefore =
      await sql`SELECT * FROM code.a4_target_shares WHERE access_id=ANY(${sql.array(retained, "uuid")}) ORDER BY access_id`;
    await migrateActivation();
    for (const attempt of [pending, cancelling])
      expect(await status(code, attempt.id)).toMatchObject({ state: "cancelled", failure: { target: null } });
    expect((await findCode(code.id))?.activeVersionId).toBe(current.version.id);
    expect((await sql`SELECT failure FROM code.activations WHERE id=${failed.id}::uuid`)[0]!.failure).toEqual({
      target: null,
      code: oldFailure.code,
      reason: oldFailure.reason,
    });
    expect(await sql`SELECT * FROM code.a4_target_shares ORDER BY access_id`).toEqual(junctionBefore);
    expect((await sql`SELECT to_regclass('code.target_grants') AS table`)[0]!.table).toBeNull();
    expect(await sql`SELECT * FROM auth.access WHERE service_account_id=${code.serviceAccountId}::uuid ORDER BY id`).toEqual(before);
    expect((await sql`SELECT failure FROM code.activations WHERE id=${cancelling.id}::uuid`)[0]!.failure).toEqual({
      target: null,
      code: "activation_model_changed",
      reason: "Start a new activation after the access-model update.",
    });
    const fresh = await start(code, submitted.version.id);
    await migrateActivation();
    expect((await status(code, fresh.id)).state).toBe("pending");
    await run(fresh.id);
    expect((await status(code, fresh.id)).state).toBe("active");
    expect(await sql`SELECT * FROM auth.access WHERE service_account_id=${code.serviceAccountId}::uuid ORDER BY id`).toEqual(before);
  });
});

// Imported session fixtures clean their rows in file-level hooks before this final drop.
afterAll(async () => {
  await database?.drop();
});
