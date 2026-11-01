import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { CapabilityActionCallReviewSchema, type User } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiCapabilities } from "../capabilities";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import type { CodeContext } from "./access";
import {
  effectiveCodePolicy,
  previewCodePolicy,
  readCodePolicy,
  readCodePolicyGroups,
  readCodePolicySnapshot,
  replaceCodePolicyCoverage,
  updateCodePolicy,
} from "./policy";
import { type CodePolicyDefinition, type CodePolicyRow, codePolicyPreset } from "./policy-contracts";
import { effective } from "./policy-effective";
import { codePolicyPauseOutbox } from "./policy-outbox";
import { readCode } from "./store";

const now = new Date("2026-10-31T12:00:00.000Z");
const adminId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const parent = "44444444-4444-4444-8444-444444444444";
const child = "55555555-5555-4555-8555-555555555555";
const ipa1 = "66666666-6666-4666-8666-666666666666";
const ipa2 = "77777777-7777-4777-8777-777777777777";
const user = (id: string): User => ({
  id,
  uid: id,
  roles: id === adminId ? ["admin"] : ["user"],
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
const ctx = (id: string): CodeContext => ({
  authority: {
    actor: { kind: "user", user: user(id) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
  },
});
const admin = ctx(adminId);
const versionId = (n: number) => `88888888-8888-4888-8888-${String(n).padStart(12, "0")}`;
const codeId = (n: number) => `c_p${String(n).padStart(4, "0")}`;
async function active(n: number, rows: CodePolicyRow[] | null, covered: CodePolicyRow[] = [], resource = false) {
  if (resource) {
    const accountId = `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;
    await sql`INSERT INTO auth.service_accounts(id,name,kind,created_by,created_at) VALUES(${accountId}::uuid,${`code:example.owner:${codeId(n)}`},'code',${ownerId}::uuid,${now})`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,service_account_id,title,created_by,created_at)
      VALUES(${codeId(n)},'resource','example.owner',${codeId(n)},${accountId}::uuid,${`Code ${n}`},${ownerId}::uuid,${now})`;
  } else {
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by,created_at) VALUES(${codeId(n)},'person',${ownerId}::uuid,${`Code ${n}`},${ownerId}::uuid,${now})`;
  }
  await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by,created_at)
    VALUES(${versionId(n)}::uuid,${codeId(n)},1,'{}','',${"a".repeat(64)},${"b".repeat(64)},${rows === null ? null : JSON.stringify({ policyRows: rows })}::text::jsonb,0,0,${ownerId}::uuid,${now})`;
  await sql`UPDATE code.codes SET state='active',active_version_id=${versionId(n)}::uuid WHERE id=${codeId(n)}`;
  await sql.begin((tx) => replaceCodePolicyCoverage(versionId(n), covered, tx));
}
function change(row: CodePolicyRow, value: "automatic" | "admin" | "never"): CodePolicyDefinition {
  const definition = codePolicyPreset("open");
  return { preset: "custom", rules: definition.rules.map((rule) => (rule.row === row ? { ...rule, value } : rule)) };
}
databaseSuite()("Core Code policy preview and durable pauses", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    setSystemTime(now);
    database = await useFreshDatabase("core_code_policy");
    await migrateAuth();
    await migrateCode();
    await migratePolicy();
    await migrateAudit();
    for (const id of [adminId, ownerId, otherId])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${id},'local','user',${id === adminId})`;
    for (const [id, provider] of [
      [parent, "local"],
      [child, "local"],
      [ipa1, "ipa"],
      [ipa2, "ipa"],
    ])
      await sql`INSERT INTO auth.groups(id,cn,name,provider) VALUES(${id}::uuid,${id},${id},${provider})`;
    await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES(${ownerId}::uuid,${child}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES(${parent}::uuid,${child}::uuid)`;
    await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${ownerId}::uuid,${ipa1}),(${ownerId}::uuid,${ipa2})`;
  });
  beforeEach(async () => {
    await sql`DELETE FROM code.codes`;
    await sql`DELETE FROM code.policy_pause_outbox`;
    const current = await readCodePolicySnapshot();
    await updateCodePolicy({ revision: current.revision, definition: codePolicyPreset("open") }, admin);
    await sql`DELETE FROM code.policy_pause_outbox`;
  });
  afterAll(async () => {
    await codePolicyPauseOutbox.stop();
    await database?.drop();
    setSystemTime();
  });
  test("forward migration preserves a populated policy", async () => {
    const before = await readCodePolicySnapshot();
    await migratePolicy();
    expect(await readCodePolicySnapshot()).toEqual(before);
  });
  test("database groups include local ancestors and IPA memberships without provider priority", async () => {
    const groups = await readCodePolicyGroups(ownerId);
    expect(groups.groups.map((g) => g.id).sort()).toEqual([parent, child, ipa1, ipa2].sort());
    const definition = codePolicyPreset("open");
    definition.preset = "custom";
    definition.rules.push({ groupId: parent, row: "read", value: "admin" }, { groupId: child, row: "read", value: "automatic" });
    expect(effective("read", { kind: "person", userId: ownerId }, definition, groups).value).toBe("automatic");
    definition.rules.push({ groupId: ipa1, row: "read", value: "admin" });
    expect(effective("read", { kind: "person", userId: ownerId }, definition, groups).value).toBe("admin");
  });
  test("missing defaults remain readable and can be repaired by a revision-checked replacement", async () => {
    await sql`DELETE FROM code.policy_rules WHERE group_id IS NULL AND row='read'`;
    const current = await readCodePolicySnapshot();
    expect((await effectiveCodePolicy({}, ctx(ownerId))).rows.find((row) => row.row === "read")?.value).toBe("never");
    await updateCodePolicy({ revision: current.revision, definition: codePolicyPreset("open") }, admin);
    expect((await readCodePolicySnapshot()).definition.rules).toHaveLength(14);
  });
  test("the Action review contains the complete localized proposal at the reviewed revision", async () => {
    const current = await readCodePolicySnapshot();
    const result = await aiCapabilities.actions["code.policy.update"].review(
      { revision: current.revision, definition: change("read", "admin") },
      {
        authority: admin.authority,
        actor: admin.authority.actor,
        accessSubject: admin.authority.accessSubject,
        user: user(adminId),
        locale: "de",
        origin: "http",
        requestId: "policy-review",
        signal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Review failed");
    const review = CapabilityActionCallReviewSchema.parse(result.data);
    expect(review.locale).toBe("de");
    expect(review.content).toMatchObject({ kind: "page", baseRevision: current.revision });
    expect(review.content?.body).toContain("Lesen (read)\nStandard: Admin gibt frei (admin)");
    expect(review.content?.body).toContain("Internet (internet)");
  });
  test("stale concurrent updates reject one writer and enqueue exactly one job", async () => {
    const previous = await readCodePolicySnapshot();
    const results = await Promise.allSettled([
      updateCodePolicy({ revision: previous.revision, definition: codePolicyPreset("admin") }, admin),
      updateCodePolicy({ revision: previous.revision, definition: codePolicyPreset("off") }, admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await readCodePolicySnapshot()).revision).toBe(previous.revision + 1);
    expect(await sql`SELECT id FROM code.policy_pause_outbox`).toHaveLength(1);
    await expect(previewCodePolicy({ revision: previous.revision, definition: codePolicyPreset("off"), limit: 20 }, admin)).rejects.toThrow(
      "changed",
    );
  });
  test("preview is read-only and counts only stricter used rows without approval; worker exposes the same pauses", async () => {
    await active(1, ["read"]);
    await active(2, ["read"], ["read"]);
    await active(3, ["ai"]);
    await active(4, ["read"]);
    await active(5, ["read"]);
    await sql`UPDATE code.codes SET state='draft' WHERE id=${codeId(5)}`;
    await active(6, ["read"]);
    await sql`UPDATE code.codes SET state='paused' WHERE id=${codeId(6)}`;
    const old = await readCodePolicySnapshot();
    const definition = change("read", "admin");
    const preview = await previewCodePolicy({ revision: old.revision, definition, limit: 1 }, admin);
    expect(preview.total).toBe(2);
    expect(preview.items.map((i) => i.codeId)).toEqual([codeId(1)]);
    expect(preview.nextCursor).toBe(codeId(1));
    const second = await previewCodePolicy({ revision: old.revision, definition, limit: 1, cursor: preview.nextCursor! }, admin);
    expect(second.items.map((item) => item.codeId)).toEqual([codeId(4)]);
    expect(second.nextCursor).toBeNull();
    expect(await sql`SELECT id FROM code.policy_pause_outbox`).toHaveLength(0);
    const result = await updateCodePolicy({ revision: old.revision, definition }, admin);
    expect((await readCode(codeId(1), ctx(ownerId))).code.state).toBe("active");
    await codePolicyPauseOutbox.reconcile();
    expect((await readCode(codeId(1), ctx(ownerId))).code).toMatchObject({
      state: "paused",
      pauseReason: "policy_changed",
      pauseRows: ["read"],
      pausePolicyRevision: result.policy.revision,
    });
    expect((await readCode(codeId(2), ctx(ownerId))).code.state).toBe("active");
    expect((await readCode(codeId(3), ctx(ownerId))).code.state).toBe("active");
    expect((await readCode(codeId(4), ctx(ownerId))).code.state).toBe("paused");
    expect((await readCode(codeId(5), ctx(ownerId))).code.state).toBe("draft");
    expect((await readCode(codeId(6), ctx(ownerId))).code.pauseReason).toBeNull();
    const [event] =
      await sql`SELECT metadata FROM audit.events WHERE action='core.code.policy.updated' AND metadata->>'revision'=${String(result.policy.revision)}`;
    expect(event.metadata).toMatchObject({
      expectedPauseCount: 2,
      changes: { default: { read: { before: "automatic", after: "admin" } } },
    });
    const [applied] =
      await sql`SELECT metadata FROM audit.events WHERE action='core.code.policy.pauses_applied' AND metadata->>'revision'=${String(result.policy.revision)}`;
    expect(applied.metadata.pausedCount).toBe(2);

    const never = await previewCodePolicy({ revision: result.policy.revision, definition: change("read", "never"), limit: 20 }, admin);
    expect(never.items.map((i) => i.codeId)).toEqual([codeId(2)]);
  });
  test("pause work continues across batch boundaries and retries safely", async () => {
    for (let n = 1; n <= 52; n++) await active(n, ["ai"]);
    const current = await readCodePolicySnapshot();
    await updateCodePolicy({ revision: current.revision, definition: change("ai", "never") }, admin);
    const [job] = await codePolicyPauseOutbox.claim();
    expect(job).toBeDefined();
    expect(job!.previous).toEqual(current.definition);
    expect((await sql`SELECT jsonb_typeof(manifest) AS kind FROM code.versions LIMIT 1`)[0].kind).toBe("object");
    await codePolicyPauseOutbox.dispatch(job!, async () => {
      throw new Error("retry fixture");
    });
    expect(await sql`SELECT attempts,last_error FROM code.policy_pause_outbox`).toMatchObject([
      { attempts: 1, last_error: "retry fixture" },
    ]);
    await sql`UPDATE code.policy_pause_outbox SET next_attempt_at='2026-01-01'`;
    const [retry] = await codePolicyPauseOutbox.claim();
    expect(retry).toMatchObject({ id: job!.id, attempts: 1 });
    await codePolicyPauseOutbox.dispatch(retry!);
    expect(await sql`SELECT previous,cursor FROM code.policy_pause_outbox`).toEqual([{ previous: current.definition, cursor: codeId(50) }]);
    expect(await sql`SELECT id FROM code.codes WHERE state='paused'`).toHaveLength(50);
    await codePolicyPauseOutbox.reconcile();
    expect(await sql`SELECT id FROM code.codes WHERE state='paused'`).toHaveLength(52);
    expect(await sql`SELECT id FROM code.policy_pause_outbox`).toHaveLength(0);
    await codePolicyPauseOutbox.dispatch(job!); // deleted job cannot resurrect continuation work
    expect(await sql`SELECT id FROM code.policy_pause_outbox`).toHaveLength(0);
  });
  test("superseded tightening and already covered versions do not pause", async () => {
    await active(1, ["read"]);
    let current = await readCodePolicySnapshot();
    await updateCodePolicy({ revision: current.revision, definition: change("read", "never") }, admin);
    current = await readCodePolicySnapshot();
    await updateCodePolicy({ revision: current.revision, definition: codePolicyPreset("open") }, admin);
    await codePolicyPauseOutbox.reconcile();
    expect((await readCode(codeId(1), ctx(ownerId))).code.state).toBe("active");
  });
  test("resource Code keeps default rows despite author loosening, and retains author vetoes", async () => {
    await active(71, ["read"], [], true);
    await active(72, ["read"], ["read"], true);
    await active(73, ["read"]);
    let current = await readCodePolicySnapshot();
    const definition = change("read", "admin");
    definition.rules.push({ groupId: child, row: "read", value: "automatic" });
    const preview = await previewCodePolicy({ revision: current.revision, definition, limit: 20 }, admin);
    expect(preview.items.map((item) => item.codeId)).toEqual([codeId(71)]);
    await updateCodePolicy({ revision: current.revision, definition }, admin);
    await codePolicyPauseOutbox.reconcile();
    expect(await sql`SELECT id FROM code.codes WHERE state='paused'`).toMatchObject([{ id: codeId(71) }]);
    current = await readCodePolicySnapshot();
    const veto = codePolicyPreset("open");
    veto.preset = "custom";
    veto.rules.push({ groupId: child, row: "read", value: "never" });
    expect(
      (await previewCodePolicy({ revision: current.revision, definition: veto, limit: 20 }, admin)).items.map((item) => item.codeId),
    ).toEqual([codeId(72), codeId(73)]);
    await updateCodePolicy({ revision: current.revision, definition: veto }, admin);
    await codePolicyPauseOutbox.reconcile();
    expect(await sql`SELECT id FROM code.codes WHERE state='active'`).toHaveLength(0);
  });
  test("missing classifications fail closed during tightening; a newly active different version is evaluated afresh", async () => {
    await active(81, null);
    await active(82, ["read"]);
    const current = await readCodePolicySnapshot();
    const definition = change("read", "never");
    const preview = await previewCodePolicy({ revision: current.revision, definition, limit: 20 }, admin);
    expect(preview.items.find((item) => item.codeId === codeId(81))?.reason).toBe("policy_rows_unavailable");
    await updateCodePolicy({ revision: current.revision, definition }, admin);
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by,created_at)
      VALUES(${versionId(83)}::uuid,${codeId(82)},2,'{}','',${"c".repeat(64)},${"d".repeat(64)},'{"policyRows":["ai"]}'::jsonb,0,0,${ownerId}::uuid,${now})`;
    await sql`UPDATE code.codes SET active_version_id=${versionId(83)}::uuid WHERE id=${codeId(82)}`;
    await codePolicyPauseOutbox.reconcile();
    expect((await readCode(codeId(81), ctx(ownerId))).code.pauseReason).toBe("policy_rows_unavailable");
    expect((await readCode(codeId(82), ctx(ownerId))).code.state).toBe("active");
  });
  test("own views cannot impersonate another owner; policy mutations reject ordinary users, narrow scopes and phone sessions", async () => {
    expect((await effectiveCodePolicy({}, ctx(ownerId))).rows).toHaveLength(14);
    await expect(effectiveCodePolicy({ owner: { kind: "person", userId: otherId } }, ctx(ownerId))).rejects.toThrow("administration");
    const previous = await readCodePolicySnapshot();
    const input = { revision: previous.revision, definition: codePolicyPreset("off") };
    const phone: RequestAuthority = { ...admin.authority, actor: { kind: "user", user: user(adminId), sessionKind: "app" } };
    for (const context of [
      ctx(ownerId),
      { authority: phone },
      { authority: { ...admin.authority, credentialKind: "oauth" as const, scopes: ["core:read"] } },
    ])
      await expect(updateCodePolicy(input, context)).rejects.toThrow();
    expect(await sql`SELECT id FROM code.policy_pause_outbox`).toHaveLength(0);
    expect((await readCodePolicy(ctx(ownerId))).policy.revision).toBe(previous.revision);
    const result = await aiCapabilities.queries["code.policy.read"].run(
      {},
      {
        authority: undefined,
        actor: admin.authority.actor,
        accessSubject: admin.authority.accessSubject,
        user: user(adminId),
        origin: "http",
        locale: "en",
        requestId: "policy-test",
        signal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(false);
  });
});
