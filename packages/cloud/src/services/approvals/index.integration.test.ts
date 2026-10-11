import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { toPgTextArray } from "../postgres";
import { APPROVAL_MAX_WAIT_MS, type ApprovalRequestInput, approvals, migrateApprovals, pruneApprovalRequests } from ".";

databaseSuite()("platform approvals", () => {
  let userId = "",
    strangerId = "";
  const ids: string[] = [];
  beforeAll(async () => {
    await migrateApprovals();
    await migrateApprovals();
    for (const role of ["owner", "stranger"]) {
      const uid = `approval-${role}-${crypto.randomUUID()}`;
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,mail)
        VALUES(${uid},'local','user',${`${uid}@example.test`}) RETURNING id`;
      if (!row) throw new Error("Missing test user");
      if (role === "owner") userId = row.id;
      else strangerId = row.id;
    }
  });
  afterAll(async () => {
    await sql`DELETE FROM audit.events WHERE target_type='approval_request' AND target_id=ANY(${toPgTextArray(ids)}::text[])`;
    await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid,${strangerId}::uuid)`;
  });
  const input = (): ApprovalRequestInput => ({
    appId: "demo",
    action: "write",
    approvalScope: "item:one",
    requester: { kind: "assistant_turn", ref: `${crypto.randomUUID()}/call`, appId: "assistant", title: "Test chat" },
    subjectId: userId,
    approverUserId: userId,
    assurance: "standard",
    sentence: "Write item?",
    review: { message: "Write item?" },
    input: { value: "one" },
    expiresInMs: APPROVAL_MAX_WAIT_MS,
  });
  const ask = async (snapshot = input()) => {
    const record = await approvals.request(snapshot);
    if (!record.ok) throw new Error("Expected a new approval request");
    ids.push(record.id);
    return { id: record.id, snapshot };
  };
  const approve = (id: string, approved = true) => approvals.decide(id, { approved }, { userId, via: "web_session" });
  const consume = (record: Awaited<ReturnType<typeof ask>>) =>
    approvals.consume(record.id, {
      input: record.snapshot.input,
      review: record.snapshot.review ?? null,
      requester: record.snapshot.requester,
    });
  test("upgrades the phase-one CHECK once and accepts the ACP channel", async () => {
    const [original] = await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint
      WHERE conrelid='approvals.requests'::regclass AND conname='requests_decided_via_check'`;
    expect(original?.conname).toBe("requests_decided_via_check");
    await sql`ALTER TABLE approvals.requests DROP CONSTRAINT requests_decided_via_check`.simple();
    await sql`ALTER TABLE approvals.requests ADD CHECK (decided_via IS NULL OR decided_via IN ('web_session','app_session','oauth','api_key','invocation')) NOT VALID`.simple();
    await migrateApprovals();
    const constraint = () => sql<
      { oid: number; definition: string; convalidated: boolean }[]
    >`SELECT oid,pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint
      WHERE conrelid='approvals.requests'::regclass AND conname='requests_decided_via_check'`;
    const first = await constraint();
    expect(first[0]?.definition).toContain("acp_bridge");
    expect(first[0]?.definition).toContain("cloud_login");
    expect(first[0]?.convalidated).toBe(true);
    await migrateApprovals();
    expect(await constraint()).toEqual(first);
    const record = await ask();
    expect(await approvals.decide(record.id, { approved: true }, { userId, via: "acp_bridge" })).toMatchObject({
      ok: true,
      status: "approved",
    });
  });
  test("upgrades the ACP constraint once and Cloud Login approves both assurance levels with device provenance", async () => {
    await sql`ALTER TABLE approvals.requests DROP CONSTRAINT requests_decided_via_check`.simple();
    await sql`ALTER TABLE approvals.requests ADD CONSTRAINT requests_decided_via_check
      CHECK (decided_via IS NULL OR decided_via IN ('web_session','app_session','oauth','api_key','invocation','acp_bridge')) NOT VALID`.simple();
    await migrateApprovals();
    const constraint = () => sql<
      { oid: number; definition: string }[]
    >`SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='approvals.requests'::regclass AND conname='requests_decided_via_check'`;
    const first = await constraint();
    expect(first[0]?.definition).toContain("cloud_login");
    await migrateApprovals();
    expect(await constraint()).toEqual(first);
    // The decision locks the active device, so a revoked device cannot decide.
    const device = async (revoked: boolean) => {
      const id = crypto.randomUUID();
      await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted,revoked_at)
        VALUES (${id}::uuid,'https://cloud.example.test',${userId}::uuid,'Phone',${JSON.stringify({ id })}::text::jsonb,false,${revoked ? new Date() : null})`;
      return id;
    };
    const revoked = await ask({ ...input(), assurance: "confirm" });
    expect(await approvals.decide(revoked.id, { approved: true }, { userId, via: "cloud_login", deviceId: await device(true) })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await approvals.get(revoked.id)).toMatchObject({ status: "pending" });
    const deviceId = await device(false);
    for (const assurance of ["standard", "confirm"] as const) {
      const record = await ask({ ...input(), assurance });
      expect(await approvals.decide(record.id, { approved: true }, { userId, via: "cloud_login", deviceId })).toMatchObject({
        ok: true,
        status: "approved",
      });
      const [event] = await sql<
        { metadata: unknown }[]
      >`SELECT metadata FROM audit.events WHERE target_type='approval_request' AND target_id=${record.id}`;
      expect(event?.metadata).toMatchObject({ decidedVia: "cloud_login", deviceId });
    }
  });

  test("ACP can reject every assurance and approve standard, but confirm stays pending without an audit", async () => {
    const record = await ask({ ...input(), assurance: "confirm" });
    const before = await approvals.get(record.id);
    expect(await approvals.decide(record.id, { approved: true }, { userId, via: "acp_bridge" })).toEqual({
      ok: false,
      code: "REJECT_ONLY",
    });
    expect(await approvals.get(record.id)).toEqual(before);
    expect(await sql`SELECT id FROM audit.events WHERE target_type='approval_request' AND target_id=${record.id}`).toHaveLength(0);
    expect(await approve(record.id)).toMatchObject({ ok: true, status: "approved" });
    for (const assurance of ["confirm", "standard"] as const) {
      const rejected = await ask({ ...input(), assurance });
      expect(await approvals.decide(rejected.id, { approved: false }, { userId, via: "acp_bridge" })).toMatchObject({
        ok: true,
        status: "rejected",
      });
    }
    const standard = await ask();
    expect(await approvals.decide(standard.id, { approved: true }, { userId, via: "acp_bridge" })).toMatchObject({
      ok: true,
      status: "approved",
    });
  });
  test("ACP confirm approve retries report the existing decision or expiry", async () => {
    const approved = await ask({ ...input(), assurance: "confirm" });
    await approve(approved.id);
    expect(await approvals.decide(approved.id, { approved: true }, { userId, via: "acp_bridge" })).toEqual({
      ok: true,
      status: "approved",
      replay: true,
    });
    expect(await sql`SELECT id FROM audit.events WHERE target_type='approval_request' AND target_id=${approved.id}`).toHaveLength(1);
    await consume(approved);
    expect(await approvals.decide(approved.id, { approved: true }, { userId, via: "acp_bridge" })).toEqual({
      ok: true,
      status: "consumed",
      replay: true,
    });
    const rejected = await ask({ ...input(), assurance: "confirm" });
    await approve(rejected.id, false);
    expect(await approvals.decide(rejected.id, { approved: true }, { userId, via: "acp_bridge" })).toEqual({
      ok: false,
      code: "ALREADY_DECIDED",
      status: "rejected",
    });
    const expired = await ask({ ...input(), assurance: "confirm" });
    await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    expect(await approvals.decide(expired.id, { approved: true }, { userId, via: "acp_bridge" })).toEqual({
      ok: false,
      code: "EXPIRED",
    });
    expect(await approvals.get(expired.id)).toMatchObject({ status: "expired" });
    expect(await sql`SELECT id FROM audit.events WHERE target_type='approval_request' AND target_id=${expired.id}`).toHaveLength(0);
  });
  test("asking again keeps the first snapshot, so a changed review asks again instead of rebinding the decision", async () => {
    const record = await ask();
    const before = await approvals.get(record.id);
    // A worker that restarted before suspending asks again for the same action with what changed meanwhile.
    const changed = {
      ...record.snapshot,
      sentence: "Send to mallory?",
      review: { message: "Send to mallory?" },
      expiresInMs: APPROVAL_MAX_WAIT_MS * 2,
    };
    expect(await approvals.request(changed)).toEqual({ ok: true, id: record.id });
    expect(await approvals.get(record.id)).toEqual(before);
    // The person approves the card they saw first; the changed effect cannot use that decision.
    await approve(record.id);
    expect(await approvals.consume(record.id, { input: changed.input, review: changed.review, requester: changed.requester })).toEqual({
      ok: false,
      code: "REVIEW_CHANGED",
    });
    expect(await approvals.get(record.id)).toMatchObject({ sentence: "Write item?", status: "cancelled" });
  });
  test("refuses a requester reference whose request is decided, expired, or another person's", async () => {
    const decided = await ask();
    await approve(decided.id);
    expect(await approvals.request(decided.snapshot)).toEqual({ ok: false, code: "CONFLICT" });
    const expired = await ask();
    await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    expect(await approvals.request(expired.snapshot)).toEqual({ ok: false, code: "CONFLICT" });
    const foreign = await ask();
    expect(await approvals.request({ ...foreign.snapshot, approverUserId: strangerId, subjectId: strangerId })).toEqual({
      ok: false,
      code: "CONFLICT",
    });
    expect(await approvals.get(decided.id)).toMatchObject({ status: "approved", approverUserId: userId });
  });
  test("caps the wait and records an overdue request as already expired", async () => {
    const capped = await ask({ ...input(), expiresInMs: APPROVAL_MAX_WAIT_MS * 2 });
    const row = await approvals.get(capped.id);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeLessThanOrEqual(APPROVAL_MAX_WAIT_MS + 1000);
    const overdue = await ask({ ...input(), expiresInMs: -60_000 });
    expect(await approve(overdue.id)).toEqual({ ok: false, code: "EXPIRED" });
    expect(await approve(overdue.id, false)).toEqual({ ok: false, code: "ALREADY_DECIDED", status: "expired" });
  });
  test("changed arguments or review cancel the approved request permanently", async () => {
    for (const changed of ["input", "review"] as const) {
      const record = await ask();
      await approve(record.id);
      const result = await approvals.consume(record.id, {
        input: changed === "input" ? { value: "different" } : record.snapshot.input,
        review: changed === "review" ? { message: "Different effect?" } : (record.snapshot.review ?? null),
        requester: record.snapshot.requester,
      });
      expect(result).toEqual({ ok: false, code: changed === "input" ? "INPUT_CHANGED" : "REVIEW_CHANGED" });
      expect(await approvals.get(record.id)).toMatchObject({ status: "cancelled" });
      expect(await consume(record)).toEqual({ ok: false, code: "NOT_APPROVED" });
    }
  });
  test("expires undecided requests but retains an in-time decision past its deadline", async () => {
    const expired = await ask();
    await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    expect(await approve(expired.id)).toEqual({ ok: false, code: "EXPIRED" });
    expect(await approvals.get(expired.id)).toMatchObject({ status: "expired" });
    const timely = await ask();
    await approve(timely.id);
    await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${timely.id}::uuid`;
    expect(await consume(timely)).toEqual({ ok: true });
  });
  test("consumes once, including concurrent consumers", async () => {
    const record = await ask();
    await approve(record.id);
    const results = await Promise.all([consume(record), consume(record)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "ALREADY_CONSUMED" }]);
    expect(await consume(record)).toEqual({ ok: false, code: "ALREADY_CONSUMED" });
  });
  test("the first opposite decision wins and the same decision replays without another audit event", async () => {
    const record = await ask();
    const results = await Promise.all([approve(record.id), approve(record.id, false)]);
    expect(results.filter((result) => result.ok && !result.replay)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ code: "ALREADY_DECIDED" });
    const row = await approvals.get(record.id);
    expect(await approve(record.id, row!.status === "approved")).toMatchObject({ ok: true, replay: true, status: row!.status });
    const events = await sql<{ metadata: { decidedVia: string }; action: string }[]>`
      SELECT metadata,action FROM audit.events WHERE target_type='approval_request' AND target_id=${record.id}`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      metadata: { decidedVia: "web_session" },
      action: row!.status === "approved" ? "auth.action.approve" : "auth.action.deny",
    });
  });
  test("hides other approvers and binds consumption to the exact requester", async () => {
    const record = await ask();
    expect(await approvals.decide(record.id, { approved: true }, { userId: strangerId, via: "api_key" })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await consume(record)).toEqual({ ok: false, code: "NOT_APPROVED" });
    await approve(record.id);
    for (const requester of [
      { ...record.snapshot.requester, ref: "other" },
      { kind: "studio_app" as const, ref: record.snapshot.requester.ref },
    ])
      expect(
        await approvals.consume(record.id, { input: record.snapshot.input, review: record.snapshot.review ?? null, requester }),
      ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await consume(record)).toEqual({ ok: true });
    expect(await approve(record.id)).toMatchObject({ ok: true, status: "consumed", replay: true });
  });
  test("joins caller transactions and rolls back decisions and audit together", async () => {
    const record = await ask();
    await expect(
      sql.begin(async (db) => {
        await approvals.decide(record.id, { approved: true }, { userId, via: "oauth" }, db);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await approvals.get(record.id)).toMatchObject({ status: "pending" });
    const events = await sql`SELECT 1 FROM audit.events WHERE target_type='approval_request' AND target_id=${record.id}`;
    expect(events).toHaveLength(0);
  });
  test("cancels only pending or approved requests, and prunes expired retention rows", async () => {
    const pending = await ask(),
      approved = await ask(),
      consumed = await ask();
    await approve(approved.id);
    await approve(consumed.id);
    await consume(consumed);
    await approvals.cancel([]);
    await approvals.cancel([pending.id, approved.id, consumed.id]);
    expect(await approvals.get(pending.id)).toMatchObject({ status: "cancelled" });
    expect(await approvals.get(approved.id)).toMatchObject({ status: "cancelled" });
    expect(await approvals.get(consumed.id)).toMatchObject({ status: "consumed" });
    await sql`UPDATE approvals.requests SET expires_at='1900-01-01'::timestamptz WHERE id=${pending.id}::uuid`;
    expect(await pruneApprovalRequests(new Date("1901-01-01"))).toBe(1);
    expect(await approvals.get(pending.id)).toBeNull();
    expect(await approvals.get(approved.id)).not.toBeNull();
  });
});
