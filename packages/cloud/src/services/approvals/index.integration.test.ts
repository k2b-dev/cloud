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
    ids.push(record.id);
    return { ...record, snapshot };
  };
  const approve = (id: string, approved = true) => approvals.decide(id, { approved }, { userId, via: "web_session" });
  const consume = (record: Awaited<ReturnType<typeof ask>>) =>
    approvals.consume(record.id, {
      input: record.snapshot.input,
      review: record.snapshot.review ?? null,
      requester: record.snapshot.requester,
    });
  test("refreshes pending snapshots but preserves decided requests", async () => {
    const record = await ask();
    const refreshed = { ...record.snapshot, sentence: "Updated?", input: { value: "two" }, expiresInMs: APPROVAL_MAX_WAIT_MS * 2 };
    expect(await approvals.request(refreshed)).toEqual({ id: record.id });
    expect(await approvals.get(record.id)).toMatchObject({ sentence: "Updated?", status: "pending" });
    const row = await approvals.get(record.id);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeLessThanOrEqual(APPROVAL_MAX_WAIT_MS + 1000);
    await approve(record.id);
    await approvals.request({ ...refreshed, sentence: "Must stay unchanged" });
    expect(await approvals.get(record.id)).toMatchObject({ sentence: "Updated?", status: "approved" });
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
