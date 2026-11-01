import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateSettings } from "../migrate/core/settings";
import * as access from "./access";
import { codeActivationTransport } from "./activation-transport";
import { clearCodeAttentionCache, listCodeAttention } from "./attention";
import { listCodeAutomations } from "./automations";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { countOwnCodeRuns, createCode, createCodeVersion, insertCodeRun } from "./store";

const ids = {
  manager: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  admin: "33333333-3333-4333-8333-333333333333",
};
const fixed = new Date("2026-10-31T12:00:00.000Z");
const person = (id: string, admin = false): User => ({
  id,
  uid: id,
  roles: admin ? ["admin"] : ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Test",
  displayName: "Code Test",
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
const authority = (id: string, admin = false): RequestAuthority => ({
  actor: { kind: "user", user: person(id, admin) },
  accessSubject: { type: "user", userId: id },
  credentialKind: "session",
  scopes: [],
});
const ctx = (id: string, admin = false): access.CodeContext => ({ authority: authority(id, admin), locale: "en" });
const subjectOf = (context: access.CodeContext) =>
  context.authority.accessSubject.type === "user" ? context.authority.accessSubject.userId : null;

// Integration runs only with explicit CLOUD_TEST_DATABASE_URL in CI.
databaseSuite()("Core Code that needs its administrators, and own run counts", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const spies: Array<{ mockRestore(): void }> = [];
  let removedGrant = "";
  let spaceGrants: "present" | "removed" = "removed";
  /** Mailbox ids the manager administers; an unavailable owner throws like a provider outage. */
  const managed = new Set(["box-failed", "box-removed", "box-paused", "box-fine", "box-down"]);
  const finishedRun = async (codeId: string, versionId: string, state: "succeeded" | "failed", at: Date) => {
    const runId = await insertCodeRun({ codeId, versionId, trigger: "schedule", entrypoint: "sort", input: null });
    await sql`UPDATE code.runs SET state=${state},created_at=${at},started_at=${at},ended_at=${at} WHERE id=${runId}::uuid`;
  };
  const mailboxCode = async (id: string) => {
    const code = await createCode(
      { owner: { kind: "resource", ref: { type: "mail.mailbox", id } }, title: `Code ${id}` },
      ctx(ids.manager),
    );
    const version = await createCodeVersion(
      { codeId: code.id, sourceFiles: { "code.ts": "export {};" }, bundle: "export {};", manifest: {}, baseVersionId: null },
      ctx(ids.manager),
    );
    return { code, versionId: version.id };
  };

  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("core_code_attention");
    await migrateAuth();
    await migrateAppApproval();
    await migrateSettings();
    await migrateAudit();
    await migrateCode();
    await migratePolicy();
    await migrateApprovals();
    await migrateVersions();
    await migrateActivation();
    for (const [name, id] of Object.entries(ids))
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${name},'local','user',${name === "admin"})`;
    spies.push(
      // The Space app lists the Code's grants; after removal it lists none.
      spyOn(codeActivationTransport, "list").mockImplementation(async (_appId, principal) =>
        spaceGrants === "present"
          ? [{ grantId: removedGrant, principal, target: { type: "spaces.space", id: "sp_2lg8" }, level: "write" }]
          : [],
      ),
      spyOn(codeSettings, "get").mockImplementation(async (key) => {
        const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
        if (!definition) throw new Error(`Unexpected setting ${key}`);
        return definition.default;
      }),
      spyOn(access, "readCodeOwner").mockImplementation(async (owner, context) => {
        if (owner.kind === "person") return owner.userId === subjectOf(context) ? { title: "Person", admin: true } : null;
        if (owner.kind !== "resource") return null;
        if (owner.ref.id === "box-down" && subjectOf(context) === ids.manager && managed.has("down-now"))
          throw new access.CodeOwnerUnavailableError("Code owner reader unavailable");
        return { title: owner.ref.id, admin: subjectOf(context) === ids.manager && managed.has(owner.ref.id) };
      }),
    );

    const failed = await mailboxCode("box-failed");
    await finishedRun(failed.code.id, failed.versionId, "succeeded", new Date("2026-10-30T08:00:00.000Z"));
    await finishedRun(failed.code.id, failed.versionId, "failed", new Date("2026-10-31T09:41:00.000Z"));
    // A failure followed by success needs nobody.
    const fine = await mailboxCode("box-fine");
    await finishedRun(fine.code.id, fine.versionId, "failed", new Date("2026-10-30T08:00:00.000Z"));
    await finishedRun(fine.code.id, fine.versionId, "succeeded", new Date("2026-10-31T08:00:00.000Z"));
    const paused = await mailboxCode("box-paused");
    await sql`UPDATE code.codes SET state='paused' WHERE id=${paused.code.id}`;
    // Switched on with access at a Space, which the Space's administrator later removed; then a run failed.
    const removed = await mailboxCode("box-removed");
    const activationId = randomUUID();
    removedGrant = randomUUID();
    await sql`INSERT INTO code.activations(id,code_id,version_id,locale,cloud_admin,state)
      VALUES(${activationId}::uuid,${removed.code.id},${removed.versionId}::uuid,'en',false,'active')`;
    await sql`INSERT INTO code.target_grants(grant_id,code_id,activation_id,target,operations,state)
      VALUES(${removedGrant}::uuid,${removed.code.id},${activationId}::uuid,${JSON.stringify({ type: "spaces.space", id: "sp_2lg8" })}::text::jsonb,
        ${sql.array(["spaces.task.create"], "text")},'granted')`;
    await sql`INSERT INTO code.version_grants(version_id,grant_id) VALUES(${removed.versionId}::uuid,${removedGrant}::uuid)`;
    await sql`UPDATE code.codes SET state='active',active_version_id=${removed.versionId}::uuid WHERE id=${removed.code.id}`;
    await finishedRun(removed.code.id, removed.versionId, "failed", new Date("2026-10-31T09:50:00.000Z"));
    const down = await mailboxCode("box-down");
    await sql`UPDATE code.codes SET state='paused' WHERE id=${down.code.id}`;

    // Personal Code: two runs today, one of them failed, and one yesterday.
    const own = await createCode({ owner: { kind: "person", userId: ids.manager }, title: "Weekly report" }, ctx(ids.manager));
    const ownVersion = await createCodeVersion(
      { codeId: own.id, sourceFiles: { "code.ts": "export {};" }, bundle: "export {};", manifest: {}, baseVersionId: null },
      ctx(ids.manager),
    );
    await finishedRun(own.id, ownVersion.id, "succeeded", new Date("2026-10-31T07:00:00.000Z"));
    await finishedRun(own.id, ownVersion.id, "failed", new Date("2026-10-31T09:00:00.000Z"));
    await finishedRun(own.id, ownVersion.id, "succeeded", new Date("2026-10-30T07:00:00.000Z"));
  });
  afterAll(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    setSystemTime();
    await database?.drop();
  });

  test("a Code's automations name the removed access only the one that needs it, its newest run and its next run", async () => {
    managed.add("box-autos");
    const entry = (entrypoint: string, cron: string | null) => ({
      kind: cron ? ("schedule" as const) : ("manual" as const),
      entrypoint,
      cron,
      file: "code.ts",
      line: 1,
    });
    const manifest = {
      version: 1,
      entry: "code.ts",
      policyRows: [],
      ai: false,
      permissions: [],
      hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
      entrypoints: [entry("sort", "0 7 * * 1"), entry("deliver", "*/15 * * * *"), entry("byHand", null)],
    };
    const code = await createCode(
      { owner: { kind: "resource", ref: { type: "mail.mailbox", id: "box-autos" } }, title: "Code box-autos" },
      ctx(ids.manager),
    );
    const version = await createCodeVersion(
      { codeId: code.id, sourceFiles: { "code.ts": "export {};" }, bundle: "export {};", manifest, baseVersionId: null },
      ctx(ids.manager),
    );
    const activationId = randomUUID();
    const grantId = randomUUID();
    await sql`INSERT INTO code.activations(id,code_id,version_id,locale,cloud_admin,state)
      VALUES(${activationId}::uuid,${code.id},${version.id}::uuid,'en',false,'active')`;
    await sql`INSERT INTO code.target_grants(grant_id,code_id,activation_id,target,operations,state)
      VALUES(${grantId}::uuid,${code.id},${activationId}::uuid,${JSON.stringify({ type: "spaces.space", id: "sp_2lg8" })}::text::jsonb,
        ${sql.array(["spaces.task.create"], "text")},'granted')`;
    await sql`INSERT INTO code.version_grants(version_id,grant_id) VALUES(${version.id}::uuid,${grantId}::uuid)`;
    await sql`UPDATE code.codes SET state='active',active_version_id=${version.id}::uuid WHERE id=${code.id}`;
    const run = async (entrypoint: string, state: string, at: string) => {
      const runId = await insertCodeRun({ codeId: code.id, versionId: version.id, trigger: "schedule", entrypoint, input: null });
      await sql`UPDATE code.runs SET state=${state},created_at=${new Date(at)},started_at=${new Date(at)},ended_at=${new Date(at)} WHERE id=${runId}::uuid`;
      return runId;
    };
    await run("sort", "succeeded", "2026-10-31T08:00:00.000Z");
    // A skipped tick is no result.
    await run("sort", "skipped", "2026-10-31T09:00:00.000Z");
    const failedRun = await run("deliver", "failed", "2026-10-31T09:50:00.000Z");
    await sql`INSERT INTO code.calls(run_id,ordinal,kind,call,state,ended_at)
      VALUES(${failedRun}::uuid,1,'action',${JSON.stringify({ capability: "spaces.task.create", target: { type: "spaces.space", id: "sp_2lg8" } })}::text::jsonb,'failed',now())`;
    const nextRun = async (_codeId: string, entrypoint: string) => (entrypoint === "sort" ? "2026-11-02T06:00:00.000Z" : null);
    clearCodeAttentionCache();
    const listed = await listCodeAutomations({ codeId: code.id }, ctx(ids.manager), nextRun);
    expect(listed.removedTargets).toEqual([{ type: "spaces.space", id: "sp_2lg8", title: null, typeTitle: null }]);
    expect(
      listed.items.map((item) => [
        item.entrypoint,
        item.kind,
        item.nextRunAt,
        item.lastRun?.state ?? null,
        item.missingTargets.map((target) => target.id),
      ]),
    ).toEqual([
      ["sort", "schedule", "2026-11-02T06:00:00.000Z", "succeeded", []],
      ["deliver", "schedule", null, "failed", ["sp_2lg8"]],
      ["byHand", "manual", null, null, []],
    ]);
    // A paused Code has no next run, whatever the scheduler still holds.
    await sql`UPDATE code.codes SET state='paused' WHERE id=${code.id}`;
    const paused = await listCodeAutomations({ codeId: code.id }, ctx(ids.manager), nextRun);
    expect(paused.items[0]!.nextRunAt).toBeNull();
    // Someone who may not read this Code gets no answer.
    await expect(listCodeAutomations({ codeId: code.id }, ctx(ids.other), nextRun)).rejects.toThrow();
    await sql`UPDATE code.codes SET state='deleting' WHERE id=${code.id}`;
    expect(await listCodeAutomations({ codeId: code.id }, ctx(ids.manager), nextRun)).toEqual({
      codeId: code.id,
      items: [],
      removedTargets: [],
    });
  });

  test("lists only Code the caller administers that is paused or failed, naming access a target removed", async () => {
    const result = await listCodeAttention({}, ctx(ids.manager));
    expect(result.nextCursor).toBeNull();
    expect(result.items.map((item) => [item.code.owner.kind === "resource" ? item.code.owner.ref.id : null, item.reasons]).sort()).toEqual([
      ["box-down", ["paused"]],
      ["box-failed", ["run_failed"]],
      ["box-paused", ["paused"]],
      ["box-removed", ["run_failed", "access_missing"]],
    ]);
    // While the Space still lists the grant, the failure has another cause.
    spaceGrants = "present";
    clearCodeAttentionCache();
    try {
      const present = await listCodeAttention({}, ctx(ids.manager));
      expect(present.items.find((item) => item.code.title === "Code box-removed")?.reasons).toEqual(["run_failed"]);
    } finally {
      spaceGrants = "removed";
      clearCodeAttentionCache();
    }
    expect(result.items.find((item) => item.code.title === "Code box-failed")?.lastRunAt).toBe("2026-10-31T09:41:00.000Z");
    // Someone who administers none of the owners sees nothing, also as a Cloud admin.
    expect((await listCodeAttention({}, ctx(ids.other))).items).toEqual([]);
    expect((await listCodeAttention({}, ctx(ids.admin, true))).items).toEqual([]);
  });

  test("an owner that cannot answer skips its Code instead of failing the list", async () => {
    managed.add("down-now");
    try {
      const result = await listCodeAttention({}, ctx(ids.manager));
      expect(result.items.map((item) => item.code.title).sort()).toEqual(["Code box-failed", "Code box-paused", "Code box-removed"]);
    } finally {
      managed.delete("down-now");
    }
  });

  test("pages the candidate window in Code ID order and continues after a page without the caller's Code", async () => {
    const all = (await listCodeAttention({}, ctx(ids.manager))).items.map((item) => item.code.id).sort();
    const first = all[0]!;
    const rest = await listCodeAttention({ cursor: first }, ctx(ids.manager));
    expect(rest.items.map((item) => item.code.id).sort()).toEqual(all.slice(1));
    // Someone else's page is empty but still says where to continue when more candidates exist.
    expect((await listCodeAttention({ cursor: all.at(-1) }, ctx(ids.other))).nextCursor).toBeNull();
  });

  test("counts the caller's own runs since the start of their day, and only theirs", async () => {
    expect(await countOwnCodeRuns({ since: "2026-10-31T00:00:00.000Z" }, ctx(ids.manager))).toEqual({ runs: 2, failed: 1 });
    expect(await countOwnCodeRuns({ since: "2026-10-30T00:00:00.000Z" }, ctx(ids.manager))).toEqual({ runs: 3, failed: 1 });
    expect(await countOwnCodeRuns({ since: "2026-10-31T00:00:00.000Z" }, ctx(ids.other))).toEqual({ runs: 0, failed: 0 });
    await expect(countOwnCodeRuns({ since: "2026-10-20T00:00:00.000Z" }, ctx(ids.manager))).rejects.toThrow("7 days");
  });
});
