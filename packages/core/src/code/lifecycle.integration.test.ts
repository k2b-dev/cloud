import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import { codeOwnerDeleted, sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { z } from "zod";
import type { CodeAccessProofClaims } from "../../../../scripts/fixtures/code-platform";
import {
  codeAccessBindings,
  compileCapabilities,
  createCodeAccessAuthorityRoutes,
  invokeCompiledCapability,
  codeAccessProofs as proofs,
  removeCodeAccess,
  setCodeAccess,
} from "../../../../scripts/fixtures/code-platform";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailRequestContext } from "../../../mail/src/service/auth";
import { spaceCodeAccess } from "../../../spaces/src/service/code-access";
import { migrate as migrateLifecycle } from "../migrate/core/code-lifecycle";
import type { CodeContext } from "./access";
import * as transport from "./activation-transport";
import { CodeActivationTransportError } from "./activation-transport";
import {
  codeAccessCleanupOutbox,
  codeDeletionOutbox,
  codeOwnerDeletedOutbox,
  listCodeCleanupJobs,
  processCodeCleanupJob,
  processCodeOwnerDeleted,
} from "./lifecycle";
import { checkCodeOwnerBeforeRun } from "./owner-check";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { findCode } from "./store";

// Mail selects a private migrated database and Sync namespace before loading its domain modules.
await import("../../../mail/test/integration-preload");
const { mailCapabilities } = await import("../../../mail/src/capabilities");
const { createMailbox, deleteMailbox, restoreMailbox } = await import("../../../mail/src/service/mailboxes");

const fixed = new Date("2026-11-01T12:00:00.000Z");
const bindings = codeAccessBindings("spaces", {
  protocolVersion: 2,
  types: { space: { title: "Space", description: "Fixture.", access: spaceCodeAccess } },
});
const context = (user: User): CodeContext & MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] },
  locale: "de",
});
const capabilityContext = (user: User): CapabilityExecutionContext => {
  const actor = {
    kind: "user" as const,
    user,
    delegation: {
      kind: "invocation" as const,
      callingAppId: "core",
      credentialKind: "session" as const,
      invocationId: "c10-integration",
      codeAccess: "set" as const,
    },
  };
  return {
    ...context(user),
    authority: { actor, accessSubject: { type: "user", userId: user.id }, credentialKind: "invocation", scopes: [] },
    actor,
    user,
    accessSubject: { type: "user", userId: user.id },
    requestId: "c10-integration",
    origin: "app",
    locale: "de",
    signal: new AbortController().signal,
  };
};
let ordinal = 0;
async function person() {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,admin)
    VALUES(${`c10-person-${++ordinal}`},'local','user','Lifecycle fixture',TRUE) RETURNING id`;
  const user = await accounts.users.get({ id: row!.id });
  if (!user) throw new Error("Fixture person missing");
  return user;
}
async function fixture(user: User, personal = false) {
  const n = ++ordinal,
    id = `c_c10${String(n).padStart(5, "0")}`;
  const mailbox = await createMailbox(context(user), { name: `Lifecycle ${n}` });
  if (!mailbox.ok) throw new Error(mailbox.error.message);
  const [owner] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id=${mailbox.data.id}::uuid`;
  const ref = { type: "mail.mailbox", id: owner!.short_id };
  let principal: string | null = null;
  if (!personal) {
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind,created_by)
      VALUES(${`code:${ref.type}:${ref.id}`},'code',${user.id}::uuid) RETURNING id`;
    principal = account!.id;
  }
  await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,owner_type,owner_id,title,service_account_id,created_by,state)
    VALUES(${id},${personal ? "person" : "resource"},${personal ? user.id : null}::uuid,
      ${personal ? null : ref.type},${personal ? null : ref.id},'Lifecycle fixture',${principal}::uuid,${user.id}::uuid,'active')`;
  const [version] = await sql<
    { id: string }[]
  >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
    VALUES(${id},1,'{"code.ts":"export {}"}','export {}',${"a".repeat(64)},${"b".repeat(64)},NULL,20,9,${user.id}::uuid) RETURNING id`;
  await sql`UPDATE code.codes SET active_version_id=${version!.id}::uuid WHERE id=${id}`;
  const [run] = await sql<{ id: string }[]>`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit)
    VALUES(${id},${version!.id}::uuid,'manual','main',32768,100) RETURNING id`;
  const [mandate] = await sql<{ id: string }[]>`INSERT INTO auth.mandates(subject_kind,subject_user_id,subject_service_account_id,
      owner_app_id,workload_type,workload_id,policy,created_by_user_id)
    VALUES(${personal ? "user" : "service_account"},${personal ? user.id : null}::uuid,${principal}::uuid,
      'core','code.version',${version!.id},'{"version":1}',${user.id}::uuid) RETURNING id`;
  const [activation] = await sql<
    { id: string }[]
  >`INSERT INTO code.activations(id,code_id,version_id,activating_person,locale,cloud_admin,state)
    VALUES(gen_random_uuid(),${id},${version!.id}::uuid,${user.id}::uuid,'de',FALSE,'active') RETURNING id`;
  return {
    id,
    principal,
    ref,
    mailboxId: mailbox.data.id,
    versionId: version!.id,
    runId: run!.id,
    mandateId: mandate!.id,
    activationId: activation!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function grant(f: Fixture, user: User, planned = false) {
  const shortId = String(++ordinal).padStart(6, "0"),
    grantId = crypto.randomUUID();
  const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces(name,short_id) VALUES('Lifecycle target',${shortId}) RETURNING id`;
  const target = { type: "spaces.space", id: shortId },
    operations = ["spaces.task.create"];
  await sql`INSERT INTO code.target_grants(grant_id,code_id,activation_id,target,operations,state)
    VALUES(${grantId}::uuid,${f.id},${f.activationId}::uuid,${JSON.stringify(target)}::text::jsonb,${operations},${planned ? "planned" : "granted"})`;
  const claims: CodeAccessProofClaims = {
    ver: 1,
    iss: "https://cloud.example",
    aud: "app:spaces",
    token_use: "code_access",
    iat: 1,
    nbf: 1,
    exp: 31,
    codeId: f.id,
    versionId: f.versionId,
    activationId: f.activationId,
    activatingPerson: user.id,
    principal: f.principal!,
    grantId,
    target,
    operations,
  };
  const set = () =>
    setCodeAccess("spaces", bindings, { proof: "verified-fixture", target, operations }, capabilityContext(user), {
      db: sql,
      verifyProof: async () => claims,
    });
  if (!planned) expect(await set()).toMatchObject({ granted: true, grantId });
  return { grantId, spaceId: space!.id, set };
}
async function deliver() {
  const rows = await codeOwnerDeletedOutbox.claim();
  for (const row of rows) await codeOwnerDeletedOutbox.dispatch(row);
  return rows;
}
const remove: Pick<transport.CodeActivationTransport, "remove"> = {
  remove: async (appId, principal, grantId) => {
    if (appId !== "spaces") throw new Error("Unexpected fixture target");
    expect(await removeCodeAccess(appId, bindings, grantId, { cleanupPrincipal: principal, requestId: "c10-cleanup" })).toBe(true);
  },
};
async function drainGrants() {
  for (const row of await codeAccessCleanupOutbox.claim())
    await codeAccessCleanupOutbox.dispatch(row, (job) => processCodeCleanupJob(job, remove));
}
async function drainDeletion() {
  for (const row of await codeDeletionOutbox.claim()) await codeDeletionOutbox.dispatch(row);
}

suiteFor("database", "nats")("Code owner lifecycle across Mail, Core and Spaces", () => {
  let settingsSpy: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  beforeAll(async () => {
    settingsSpy = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!definition) throw new Error(`Unexpected setting ${key}`);
      return definition.default;
    });
    setSystemTime(fixed);
    await migrateLifecycle();
    await migrateLifecycle();
  });
  afterAll(() => {
    settingsSpy?.mockRestore();
    setSystemTime();
  });

  test("mailbox deletion locks and revokes before network cleanup, then erases all owned data", async () => {
    const user = await person(),
      f = await fixture(user),
      g = await grant(f, user);
    expect((await deleteMailbox(context(user), f.mailboxId)).ok).toBe(true);
    const reports = await deliver();
    expect(reports).toHaveLength(1);
    expect(await findCode(f.id)).toMatchObject({ state: "deleting" });
    expect(await sql`SELECT id FROM auth.mandates WHERE id=${f.mandateId}::uuid AND state='revoked'`).toHaveLength(1);
    expect(await sql`SELECT id FROM auth.service_accounts WHERE id=${f.principal}::uuid AND status='disabled'`).toHaveLength(1);
    expect(await sql`SELECT id FROM code.runs WHERE id=${f.runId}::uuid AND state='cancelled' AND generation=1`).toHaveLength(1);
    expect(await sql`SELECT id FROM auth.access WHERE id=${g.grantId}::uuid`).toHaveLength(1);
    // Acknowledged or duplicated owner deliveries cannot create another cleanup batch.
    await processCodeOwnerDeleted(reports[0]!);
    expect((await listCodeCleanupJobs({ codeId: f.id }, context(user))).items).toHaveLength(2);
    await drainGrants();
    await drainDeletion();
    for (const table of ["codes", "versions", "runs", "activations", "target_grants", "cleanup_jobs"])
      expect(await sql.unsafe(`SELECT 1 FROM code.${table} WHERE ${table === "codes" ? "id" : "code_id"}=$1`, [f.id])).toHaveLength(0);
    expect(await sql`SELECT id FROM auth.service_accounts WHERE id=${f.principal}::uuid`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth.access WHERE id=${g.grantId}::uuid`).toHaveLength(0);
    expect((await restoreMailbox(context(user), f.mailboxId)).ok).toBe(true);
    expect(await findCode(f.id)).toBeNull();
  });

  test("unreachable targets wait visibly, preserve cleanup authority and recover after an ambiguous reply", async () => {
    const user = await person(),
      f = await fixture(user);
    await grant(f, user);
    await sql.begin((tx) => codeOwnerDeleted(tx, f.ref));
    await deliver();
    const [job] = await codeAccessCleanupOutbox.claim();
    expect(job).toBeDefined();
    await codeAccessCleanupOutbox.dispatch(job!, (row) =>
      processCodeCleanupJob(row, {
        remove: async () => {
          throw new CodeActivationTransportError("target_unavailable", true);
        },
      }),
    );
    const waiting = await listCodeCleanupJobs({ codeId: f.id, limit: 1 }, context(user));
    const all = await listCodeCleanupJobs({ codeId: f.id }, context(user));
    expect(all.items.find((job) => job.kind === "code.access.rm")).toMatchObject({
      state: "waiting",
      attempts: 1,
      lastError: "target_unavailable",
    });
    expect(waiting.nextCursor).not.toBeNull();
    expect((await listCodeCleanupJobs({ codeId: f.id, cursor: waiting.nextCursor! }, context(user))).items).toHaveLength(1);
    const nonAdmin = { ...user, roles: ["user" as const] };
    await expect(listCodeCleanupJobs({}, context(nonAdmin))).rejects.toThrow(/administration authority/);
    await drainDeletion();
    expect((await findCode(f.id))?.state).toBe("deleting");
    // Remove succeeded but the reply was lost. Retry the very same persisted grantId.
    await sql`UPDATE code.cleanup_jobs SET next_attempt_at=now() WHERE code_id=${f.id}`;
    const [retry] = await codeAccessCleanupOutbox.claim();
    await codeAccessCleanupOutbox.dispatch(retry!, async (row) => {
      await processCodeCleanupJob(row, remove);
      throw new Error("lost_reply");
    });
    await sql`UPDATE code.cleanup_jobs SET next_attempt_at=now() WHERE code_id=${f.id}`;
    await drainGrants();
    await drainDeletion();
    expect(await findCode(f.id)).toBeNull();
  });

  test("planned grants are tombstoned before delayed activation sets arrive; rollback emits nothing", async () => {
    const user = await person(),
      f = await fixture(user),
      g = await grant(f, user, true);
    await expect(
      sql.begin(async (tx) => {
        await codeOwnerDeleted(tx, f.ref);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await codeOwnerDeletedOutbox.claim()).toHaveLength(0);
    await expect(sql.begin((tx) => codeOwnerDeleted(tx, { type: "core.user", id: user.id }))).rejects.toThrow(/declared code.owners/);
    await expect(sql.begin((tx) => codeOwnerDeleted(tx, { ...f.ref, type: "mail.mailboxes" }))).rejects.toThrow(/declared code.owners/);
    await sql.begin(async (tx) => {
      await codeOwnerDeleted(tx, f.ref);
      await codeOwnerDeleted(tx, f.ref);
    });
    await deliver();
    await drainGrants();
    await drainDeletion();
    expect((await findCode(f.id))?.state).toBe("deleting");
    await deliver();
    await sql`UPDATE code.cleanup_jobs SET next_attempt_at=now() WHERE code_id=${f.id}`;
    expect(
      await sql`SELECT grant_id FROM capabilities.code_access_grants WHERE app_id='spaces'
      AND grant_id=${g.grantId}::uuid AND revoked`,
    ).toHaveLength(1);
    expect(await g.set()).toMatchObject({ granted: false, reasonCode: "account_inactive" });
    // The tombstone also fences a replay if an account is unexpectedly re-enabled.
    await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${f.principal}::uuid`;
    expect(await g.set()).toMatchObject({ granted: false, reasonCode: "removed" });
    await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${f.principal}::uuid`;
    await drainDeletion();
    expect(await findCode(f.id)).toBeNull();
  });

  test("missing owners pause without deletion; outages refuse admission; queued work is skipped", async () => {
    const user = await person(),
      f = await fixture(user);
    const registry = spyOn(cloud, "getApp").mockImplementation(async () => ({
      id: "mail",
      name: "Mail",
      icon: "ti ti-mail",
      description: "Fixture",
      routes: ["/mail"],
      baseUrl: "http://mail.test",
      access: { kind: "grants" },
    }));
    const title = spyOn(transport, "readCodeResourceOwnerTitle").mockResolvedValue(null);
    try {
      expect(await checkCodeOwnerBeforeRun((await findCode(f.id))!)).toBe(false);
      expect(await findCode(f.id)).toMatchObject({ state: "paused", pauseReason: "owner_not_found" });
      expect(await sql`SELECT id FROM code.runs WHERE code_id=${f.id} AND state='skipped' AND outcome='owner_not_found'`).toHaveLength(1);
      expect(await sql`SELECT id FROM code.cleanup_jobs WHERE code_id=${f.id}`).toHaveLength(0);
      title.mockRejectedValue(new Error("offline"));
      await expect(checkCodeOwnerBeforeRun((await findCode(f.id))!)).rejects.toThrow("owner reader unavailable");
      registry.mockResolvedValue(null);
      await expect(checkCodeOwnerBeforeRun((await findCode(f.id))!)).rejects.toThrow("owner reader unavailable");
      await sql`INSERT INTO core.known_apps(id,name,hidden_at) VALUES('mail','Mail',now())
        ON CONFLICT(id) DO UPDATE SET hidden_at=now()`;
      expect(await checkCodeOwnerBeforeRun((await findCode(f.id))!)).toBe(false);
      await sql`UPDATE core.known_apps SET hidden_at=NULL WHERE id='mail'`;
    } finally {
      title.mockRestore();
      registry.mockRestore();
    }
  });

  test("old reports preserve newer Code, and a living person cannot be reported as deleted", async () => {
    const user = await person(),
      f = await fixture(user),
      personal = await fixture(user, true);
    await sql.begin((tx) => codeOwnerDeleted(tx, f.ref));
    // Preserve PostgreSQL microseconds when comparing a creation after the report.
    await sql`UPDATE code.codes SET created_at=(SELECT created_at+interval '1 microsecond' FROM events.outbox
      WHERE kind='code_owner_deleted' ORDER BY seq DESC LIMIT 1) WHERE id=${f.id}`;
    await deliver();
    expect((await findCode(f.id))?.state).toBe("active");
    await sql`SELECT events.enqueue(gen_random_uuid(),'core','code_owner_deleted','fixture-person',
      ${JSON.stringify({ type: "core.user", id: user.id })}::text::jsonb)`;
    await deliver();
    expect((await findCode(personal.id))?.state).toBe("active");
  });

  test("remembered app owners retry while offline and pause after explicit removal", async () => {
    const user = await person(),
      f = await fixture(user);
    const code = (await findCode(f.id))!;
    const registry = spyOn(cloud, "getApp").mockResolvedValue(null);
    await sql`INSERT INTO core.known_apps(id,name) VALUES('example','Example') ON CONFLICT(id) DO UPDATE SET hidden_at=NULL`;
    try {
      const appCode = { ...code, owner: { kind: "app" as const, appId: "example" } };
      await expect(checkCodeOwnerBeforeRun(appCode)).rejects.toThrow("owner reader unavailable");
      expect((await findCode(f.id))?.state).toBe("active");
      await sql`UPDATE core.known_apps SET hidden_at=now() WHERE id='example'`;
      expect(await checkCodeOwnerBeforeRun(appCode)).toBe(false);
      expect((await findCode(f.id))?.pauseReason).toBe("owner_not_found");
    } finally {
      registry.mockRestore();
    }
  });

  test("person deletion deletes personal Code, while their activated resource Code and mandate keep running", async () => {
    const user = await person(),
      personal = await fixture(user, true),
      resource = await fixture(user);
    await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    await deliver();
    await drainDeletion();
    expect(await findCode(personal.id)).toBeNull();
    expect(await findCode(resource.id)).toMatchObject({ state: "active", createdBy: null });
    expect(await sql`SELECT id FROM auth.mandates WHERE id=${resource.mandateId}::uuid AND state='active'`).toHaveLength(1);
    await expect(sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title)
      VALUES('c_orphan','person',${user.id}::uuid,'Orphan')`).rejects.toThrow("owner not found");
  });

  test("owner title projection is account-bound, read-only and contains no reader contents", async () => {
    const user = await person(),
      f = await fixture(user),
      other = await fixture(user);
    const verify = spyOn(proofs, "verifyCodeAccessList").mockResolvedValue({
      ver: 1,
      iss: "https://cloud.example",
      aud: "app:mail",
      iat: 1,
      nbf: 1,
      exp: 31,
      token_use: "code_access_list",
      principal: f.principal!,
    });
    const router = createCodeAccessAuthorityRoutes("mail", mailCapabilities);
    const read = (ref: { type: string; id: string }) =>
      router.request("/queries/code.owner.title", {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: JSON.stringify(ref),
      });
    try {
      expect(await (await read(f.ref)).json()).toEqual({ data: { title: expect.stringContaining("Lifecycle") } });
      expect((await read(other.ref)).status).toBe(403);
      expect((await read({ type: "spaces.space", id: "123456" })).status).toBe(403);
      await sql`UPDATE mail.mailboxes SET deleted_at=now() WHERE id=${f.mailboxId}::uuid`;
      expect(await (await read(f.ref)).json()).toEqual({ data: { title: null } });
      verify.mockResolvedValue(null);
      expect((await read(f.ref)).status).toBe(403);
    } finally {
      verify.mockRestore();
    }
  });
  test("Code calls identify a deleted normalized target before the handler; ordinary refusals keep their meaning", async () => {
    const user = await person(),
      f = await fixture(user);
    let exists = false,
      calls = 0;
    const compiled = compileCapabilities("example", {
      protocolVersion: 2,
      types: { item: { title: "Item", description: "Fixture item.", reader: "read", access: spaceCodeAccess } },
      queries: {
        read: {
          title: "Read",
          description: "Read fixture.",
          openWorld: false,
          input: z.object({ id: z.string().describe("Resource ID.") }).strict(),
          data: z.object({}),
          codeResourceTitle: async (tx) => {
            const [mode] = await tx<{ read_only: string }[]>`SELECT current_setting('transaction_read_only') AS read_only`;
            expect(mode?.read_only).toBe("on");
            return exists ? "Item" : null;
          },
          run: () => ({ ok: true, data: { data: {} } }),
        },
      },
      actions: {
        change: {
          title: "Change",
          description: "Change fixture.",
          target: "item",
          openWorld: false,
          input: z.object({}).strict(),
          data: z.object({}),
          destructive: false,
          idempotency: "none",
          run: () => {
            calls++;
            return { ok: false, error: { code: "FORBIDDEN", message: "Access removed", status: 403 } };
          },
        },
      },
    });
    const base = capabilityContext(user),
      actor = {
        kind: "service_account" as const,
        serviceAccount: {
          id: f.principal!,
          name: "Code",
          kind: "code" as const,
          status: "active" as const,
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: user.id,
          createdAt: fixed.toISOString(),
        },
        delegatedUser: null,
        scopes: [],
        delegation: {
          kind: "invocation" as const,
          callingAppId: "core",
          credentialKind: "mandate" as const,
          invocationId: "c10-code-run",
          workloadType: "code.version",
        },
      };
    const invoke = () =>
      invokeCompiledCapability({
        compiled,
        kind: "action",
        localId: "change",
        input: {},
        target: { type: "example.item", id: "123456" },
        expectedSchemaHash: compiled.actions.get("change")!.manifest.schemaHash,
        context: {
          ...base,
          actor,
          user: null,
          accessSubject: { type: "service_account", serviceAccountId: f.principal! },
          authority: {
            actor,
            accessSubject: { type: "service_account", serviceAccountId: f.principal! },
            credentialKind: "invocation",
            scopes: [],
          },
        },
      });
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "CODE_TARGET_DELETED", message: "Ziel gelöscht", status: 404 } });
    expect(calls).toBe(0);
    exists = true;
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: "Access removed" } });
    expect(calls).toBe(1);
    exists = false;
    const personalResult = await invokeCompiledCapability({
      compiled,
      kind: "action",
      localId: "change",
      input: {},
      target: { type: "example.item", id: "123456" },
      expectedSchemaHash: compiled.actions.get("change")!.manifest.schemaHash,
      context: { ...base, actor: { ...base.actor, delegation: actor.delegation } },
    });
    expect(personalResult).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(calls).toBe(2);
  });
});
