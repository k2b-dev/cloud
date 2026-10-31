import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
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
async function active(n: number, rows: CodePolicyRow[], covered: CodePolicyRow[] = []) {
  await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by,created_at) VALUES(${codeId(n)},'person',${ownerId}::uuid,${`Code ${n}`},${ownerId}::uuid,${now})`;
  await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by,created_at)
    VALUES(${versionId(n)}::uuid,${codeId(n)},1,'{}','',${"a".repeat(64)},${"b".repeat(64)},${JSON.stringify({ policyRows: rows })}::jsonb,0,0,${ownerId}::uuid,${now})`;
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
    const old = await readCodePolicySnapshot();
    const definition = change("read", "admin");
    const preview = await previewCodePolicy({ revision: old.revision, definition, limit: 2 }, admin);
    expect(preview.total).toBe(1);
    expect(preview.items.map((i) => i.codeId)).toEqual([codeId(1)]);
    expect(preview.nextCursor).toBe(codeId(2));
    expect((await previewCodePolicy({ revision: old.revision, definition, limit: 2, cursor: preview.nextCursor! }, admin)).items).toEqual(
      [],
    );
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
    const never = await previewCodePolicy({ revision: result.policy.revision, definition: change("read", "never"), limit: 20 }, admin);
    expect(never.items.map((i) => i.codeId)).toEqual([codeId(2)]);
  });
  test("pause work continues across batch boundaries and retries safely", async () => {
    for (let n = 1; n <= 52; n++) await active(n, ["ai"]);
    const current = await readCodePolicySnapshot();
    await updateCodePolicy({ revision: current.revision, definition: change("ai", "never") }, admin);
    const [job] = await codePolicyPauseOutbox.claim();
    expect(job).toBeDefined();
    await codePolicyPauseOutbox.dispatch(job!, async () => {
      throw new Error("retry fixture");
    });
    expect(await sql`SELECT attempts,last_error FROM code.policy_pause_outbox`).toMatchObject([
      { attempts: 1, last_error: "retry fixture" },
    ]);
    await sql`UPDATE code.policy_pause_outbox SET next_attempt_at='2026-01-01'`;
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
