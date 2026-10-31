import { afterAll, beforeAll, expect, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { reviewFixture } from "../../_internal/capability-review.test-fixture";
import { migrateCloudAi } from "../../ai/migrate";
import { sql } from "../../runtime/clients";
import { encryptValue } from "../settings/crypto";
import {
  approvalReviewDigest,
  approvals,
  type CodeVersionApprovalRequestInput,
  countPending,
  listPending,
  migrateApprovals,
  registerApprovalDecisionHandler,
} from ".";
import { readApprovalContent } from "./content";

// Each suite receives an isolated test database from the shared infrastructure gate.
databaseSuite()("independent Code-version approvals", () => {
  const users: string[] = [];
  const requests: string[] = [];
  let author = "",
    admin = "",
    otherAdmin = "",
    outsider = "";
  let dispose: (() => void) | undefined;
  let failTransition = false;
  let transitions = 0;
  const install = () =>
    registerApprovalDecisionHandler("code_version", async (tx, request) => {
      transitions++;
      await tx`UPDATE auth.users SET display_name=${`version:${request.status}`} WHERE id=${author}::uuid`;
      if (failTransition) throw new Error("Version transition failed");
    });
  beforeAll(async () => {
    await migrateCloudAi();
    for (const [name, isAdmin] of [
      ["author", true],
      ["admin", true],
      ["second-admin", true],
      ["outsider", false],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
        VALUES (${`code-approval-${name}-${crypto.randomUUID()}`},'local','user',${isAdmin}) RETURNING id`;
      if (!row) throw new Error("Missing fixture user");
      users.push(row.id);
      if (name === "author") author = row.id;
      else if (name === "admin") admin = row.id;
      else if (name === "second-admin") otherAdmin = row.id;
      else outsider = row.id;
    }
    dispose = install();
  });
  afterAll(async () => {
    dispose?.();
    for (const id of requests) await sql`DELETE FROM audit.events WHERE target_type='approval_request' AND target_id=${id}`;
    for (const id of requests) await sql`DELETE FROM approvals.requests WHERE id=${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
  });
  const snapshot = (): CodeVersionApprovalRequestInput => ({
    kind: "code_version",
    appId: "demo",
    action: "version.approve",
    requester: { kind: "code_version", ref: crypto.randomUUID(), appId: "demo", title: "Monday report", href: "/code/demo/" },
    authorUserId: author,
    approverRole: "admin",
    sentence: "Approve this version of Monday report?",
    input: { codeId: "demo", versionId: "v1", sourceHash: "a".repeat(64), bundleHash: "b".repeat(64) },
    review: { ...reviewFixture(), content: { kind: "page", title: "Source diff", body: "- old\n+ new", format: "plain" } },
    expiresInMs: 600_000,
  });
  const ask = async (input = snapshot()) => {
    const result = await approvals.request(input);
    if (!result.ok) throw new Error("Expected a request");
    requests.push(result.id);
    return { id: result.id, input };
  };
  const decide = (id: string, userId = admin, approved = true) => approvals.decide(id, { approved }, { userId, via: "web_session" });

  test("adds the role without rewriting existing personal approval rows", async () => {
    const input = snapshot();
    const result = await approvals.request({
      ...input,
      kind: "action",
      subjectId: outsider,
      requester: { ...input.requester, kind: "assistant_turn" },
      approverUserId: outsider,
      assurance: "standard",
    });
    if (!result.ok) throw new Error("Missing personal request");
    requests.push(result.id);
    const before = await approvals.get(result.id);
    await migrateApprovals();
    await migrateApprovals();
    expect(await approvals.get(result.id)).toEqual(before);
    expect(before).toMatchObject({ kind: "action", approverUserId: outsider, approverRole: null, status: "pending" });
    expect(await decide(result.id, admin)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await decide(result.id, outsider)).toMatchObject({ ok: true, status: "approved" });
  });

  test("the database permits exactly one personal or role recipient and keeps Code confirmation mandatory", async () => {
    const { id } = await ask();
    await expect(sql`UPDATE approvals.requests SET approver_user_id=${admin}::uuid WHERE id=${id}::uuid`).rejects.toThrow();
    await expect(sql`UPDATE approvals.requests SET approver_role=NULL WHERE id=${id}::uuid`).rejects.toThrow();
    await expect(sql`UPDATE approvals.requests SET assurance='standard' WHERE id=${id}::uuid`).rejects.toThrow();
    await expect(sql`UPDATE approvals.requests SET requester_kind='assistant_turn' WHERE id=${id}::uuid`).rejects.toThrow();
    expect(await approvals.get(id)).toMatchObject({ approverRole: "admin", approverUserId: null, assurance: "confirm", status: "pending" });
  });

  test("only a current Cloud admin decides; being the author or chat user grants nothing", async () => {
    const { id } = await ask();
    expect(await decide(id, outsider)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await decide(id, outsider, false)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await decide(id, author)).toEqual({ ok: false, code: "SELF_APPROVAL" });
    expect(await approvals.get(id)).toMatchObject({ status: "pending", approverUserId: null, approverRole: "admin", assurance: "confirm" });
    const before = transitions;
    expect(await decide(id)).toEqual({ ok: true, status: "approved", replay: false });
    expect(await decide(id)).toEqual({ ok: true, status: "approved", replay: true });
    expect(transitions).toBe(before + 1);
    expect(await approvals.get(id)).toMatchObject({ decidedByUserId: admin, decidedVia: "web_session", status: "approved" });
    expect(await decide(id, otherAdmin, false)).toEqual({ ok: false, code: "ALREADY_DECIDED", status: "approved" });
    const [event] = await sql<{ actor_user_id: string; metadata: unknown }[]>`SELECT actor_user_id,metadata FROM audit.events
      WHERE target_type='approval_request' AND target_id=${id}`;
    expect(event).toMatchObject({ actor_user_id: admin, metadata: { kind: "code_version" } });
  });

  test("authors can reject; two admins cannot decide differently", async () => {
    const rejected = await ask();
    expect(await decide(rejected.id, author, false)).toMatchObject({ ok: true, status: "rejected" });
    const concurrent = await ask();
    const before = transitions;
    const results = await Promise.all([decide(concurrent.id, admin), decide(concurrent.id, otherAdmin, false)]);
    expect(results.filter((result) => result.ok && !result.replay)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "ALREADY_DECIDED")).toHaveLength(1);
    expect(transitions).toBe(before + 1);
  });

  test("an owner's failure rolls back platform decision, domain write and audit", async () => {
    const { id } = await ask();
    await sql`UPDATE auth.users SET display_name='before-failure' WHERE id=${author}::uuid`;
    failTransition = true;
    try {
      await expect(decide(id)).rejects.toThrow("Version transition failed");
    } finally {
      failTransition = false;
    }
    expect(await approvals.get(id)).toMatchObject({ status: "pending", decidedByUserId: null });
    const [user] = await sql<{ display_name: string }[]>`SELECT display_name FROM auth.users WHERE id=${author}::uuid`;
    expect(user?.display_name).toBe("before-failure");
    expect(await sql`SELECT id FROM audit.events WHERE target_type='approval_request' AND target_id=${id}`).toHaveLength(0);
    expect(await decide(id)).toMatchObject({ ok: true });
  });

  test("without the kind owner, decisions remain visibly unavailable and pending", async () => {
    const { id } = await ask();
    dispose?.();
    try {
      expect(await decide(id)).toEqual({ ok: false, code: "UNAVAILABLE" });
    } finally {
      dispose = install();
    }
    expect(await approvals.get(id)).toMatchObject({ status: "pending" });
  });

  test("lists, counts and complete content require the role but no pending chat", async () => {
    const { id, input } = await ask();
    const digest = approvalReviewDigest(input.review);
    expect((await listPending({ approverUserId: admin, id })).items[0]).toMatchObject({
      id,
      kind: "code_version",
      conversationShortId: null,
    });
    expect((await listPending({ approverUserId: outsider, id })).items).toEqual([]);
    expect((await countPending({ approverUserId: admin })).apps.demo).toBeGreaterThan(0);
    expect((await countPending({ approverUserId: outsider })).total).toBe(0);
    expect(await readApprovalContent({ id, digest, approverUserId: admin })).toEqual({
      kind: "page",
      title: "Source diff",
      body: "- old\n+ new",
      format: "plain",
    });
    expect(await readApprovalContent({ id, digest, approverUserId: outsider })).toBeNull();
    await sql`UPDATE auth.users SET admin=false WHERE id=${admin}::uuid`;
    try {
      expect((await listPending({ approverUserId: admin, id })).items).toEqual([]);
      expect(await readApprovalContent({ id, digest, approverUserId: admin })).toBeNull();
      expect(await decide(id)).toEqual({ ok: false, code: "NOT_FOUND" });
    } finally {
      await sql`UPDATE auth.users SET admin=true WHERE id=${admin}::uuid`;
    }
    await decide(id);
    expect(await readApprovalContent({ id, digest, approverUserId: admin })).toBeNull();
  });

  test("FreeIPA admin roles use current configured groups, not the local admin flag", async () => {
    const { id } = await ask();
    const rollback = new Error("role fixture rollback");
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE auth.users SET provider='ipa',admin=false WHERE id=${outsider}::uuid`;
        await tx`INSERT INTO auth.ipa_user_effective_groups VALUES(${outsider}::uuid,'code-review-admins')`;
        await tx`INSERT INTO settings.entries(key,value) VALUES('freeipa.groups.admin',${await encryptValue(["code-review-admins"])})
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
        expect(await approvals.decide(id, { approved: true }, { userId: outsider, via: "web_session" }, tx)).toMatchObject({ ok: true });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await approvals.get(id)).toMatchObject({ status: "pending" });
  });

  test("role questions survive the author's sign-out, expire normally, and cannot be rebound or consumed as chat consent", async () => {
    const { id, input } = await ask();
    await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${author}::uuid`;
    expect(await approvals.request(input)).toEqual({ ok: true, id });
    expect(await approvals.request({ ...input, input: { bundleHash: "changed" } })).toEqual({ ok: false, code: "CONFLICT" });
    expect(await decide(id)).toMatchObject({ ok: true });
    expect(await approvals.consume(id, { requester: input.requester, input: input.input, review: input.review ?? null })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    const expired = await ask();
    await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    expect(await decide(expired.id)).toEqual({ ok: false, code: "EXPIRED" });
  });

  test("deleting a version author does not cascade a role request", async () => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile)
      VALUES (${`deleted-author-${crypto.randomUUID()}`},'local','user') RETURNING id`;
    if (!user) throw new Error("Missing author");
    const { id } = await ask({ ...snapshot(), authorUserId: user.id });
    await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    expect(await approvals.get(id)).toMatchObject({ status: "pending", authorUserId: null, subjectId: null });
    expect(await decide(id)).toMatchObject({ ok: true });
  });

  test("ACP only rejects and Cloud Login requires a current device belonging to the admin", async () => {
    const { id } = await ask();
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "acp_bridge" })).toEqual({
      ok: false,
      code: "REJECT_ONLY",
    });
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "cloud_login" })).toEqual({ ok: false, code: "NOT_FOUND" });
    const deviceId = crypto.randomUUID();
    await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
      VALUES (${deviceId}::uuid,'https://cloud.example.test',${admin}::uuid,'Phone','{}'::jsonb,false)`;
    expect(await approvals.decide(id, { approved: true }, { userId: otherAdmin, via: "cloud_login", deviceId })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await sql`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${deviceId}::uuid`;
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "cloud_login", deviceId })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await sql`UPDATE auth.app_devices SET revoked_at=NULL WHERE id=${deviceId}::uuid`;
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "cloud_login", deviceId })).toMatchObject({ ok: true });
    expect(await approvals.get(id)).toMatchObject({ decidedByUserId: admin, decidedDeviceId: deviceId });
  });
});
