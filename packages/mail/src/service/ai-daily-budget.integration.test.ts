import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrateAiDailyBudget } from "../migrate-ai-daily-budget";
import { grantMailboxAccess } from "./access";
import {
  consumeAiDailyBudget,
  getAiDailySourceStats,
  getMailboxAiDailyLimit,
  releaseAiDailyBudget,
  reserveAiDailyBudget,
  updateMailboxAiDailyLimit,
} from "./ai-daily-budget";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats", "valkey");
const at = "2026-10-24T21:59:59.000Z"; // One second before Berlin midnight, before the autumn DST change.
const midnight = "2026-10-24T22:00:00.000Z";
const resetAfterDst = "2026-10-25T23:00:00.000Z"; // The next calendar day lasts 25 hours.

suite("Mail source and mailbox calendar-day AI reservations", () => {
  let owner: MailRequestContext;
  let member: MailRequestContext;
  let mailboxId = "";
  let conversationId = "";
  const users: string[] = [];
  const mailboxes: string[] = [];
  let restoreSettings = () => {};
  let setTimeZone = (_zone: string) => {};

  const person = async (name: string): Promise<MailRequestContext> => {
    const uid = `mail-daily-${name}-${crypto.randomUUID()}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${name}, false) RETURNING id
    `;
    if (!row) throw new Error("Missing daily AI fixture user");
    users.push(row.id);
    const user: User = {
      id: row.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: name,
      sn: "Daily",
      displayName: name,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: row.id }, requestId: uid };
  };
  const input = (reservationKey = "operation-1", sourceId = "source-a", plannedMaxCalls = 1) => ({
    mailboxId,
    sourceId,
    sourceName: `Source ${sourceId}`,
    reservationKey,
    plannedMaxCalls,
    maxAiCallsPerDay: 2,
  });
  const stats = async (sourceId = "source-a", maxAiCallsPerDay: number | null = 2) =>
    unwrap(await getAiDailySourceStats({ mailboxId, sourceId, maxAiCallsPerDay }));
  const setLimit = async (maxAiCallsPerDay: number | null) =>
    unwrap(await updateMailboxAiDailyLimit({ context: owner, mailboxId, maxAiCallsPerDay }));
  const reservationCount = async () => {
    const [row] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM mail.ai_daily_reservations WHERE mailbox_id = ${mailboxId}::uuid`;
    return row?.count ?? 0;
  };
  const mailSnapshot = async () => {
    const [row] = await sql<{ value: unknown }[]>`SELECT to_jsonb(c) AS value FROM mail.conversations c WHERE id = ${conversationId}::uuid`;
    return row?.value;
  };

  beforeAll(async () => {
    owner = await person("Owner");
    member = await person("Member");
  });
  beforeEach(async () => {
    setSystemTime(new Date(at));
    mailboxId = unwrap(await createMailbox(owner, { name: "Daily AI integration" })).id;
    mailboxes.push(mailboxId);
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (mailbox_id, subject, summary, latest_message_at) VALUES (${mailboxId}::uuid, 'Budget guard', 'A person wrote this', ${at}::timestamptz) RETURNING id
    `;
    if (!conversation) throw new Error("Missing daily AI fixture conversation");
    conversationId = conversation.id;
    const settings = spyOn(coreSettings, "get").mockResolvedValue("Europe/Berlin");
    setTimeZone = (zone: string) => {
      settings.mockResolvedValue(zone);
    };
    restoreSettings = () => settings.mockRestore();
  });
  afterEach(() => {
    restoreSettings();
    setSystemTime();
  });
  afterAll(async () => {
    for (const id of mailboxes) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      for (const grant of access) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    }
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("the independent migration reruns without losing a setting, hold, or completed counter", async () => {
    await setLimit(4);
    unwrap(await reserveAiDailyBudget(input("held")));
    unwrap(await reserveAiDailyBudget(input("done")));
    unwrap(await consumeAiDailyBudget({ ...input("done"), actualCalls: 1 }));
    await migrateAiDailyBudget(sql);
    await migrateAiDailyBudget(sql);
    expect(unwrap(await getMailboxAiDailyLimit({ context: owner, mailboxId }))).toEqual({ maxAiCallsPerDay: 4 });
    expect(await stats()).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 1 });
  });

  test("reserves the planned maximum before effects; rule denial changes no mail, hold, or counter", async () => {
    const first = unwrap(await reserveAiDailyBudget(input("first", "source-a", 2)));
    expect(first.status).toBe("reserved");
    const beforeMail = await mailSnapshot();
    const beforeStats = await stats();
    const denied = unwrap(await reserveAiDailyBudget(input("denied")));
    expect(denied).toEqual({ status: "limited", scope: "rule", limit: 2, resetsAt: midnight });
    expect(await mailSnapshot()).toEqual(beforeMail);
    expect(await stats()).toEqual(beforeStats);
    expect(await reservationCount()).toBe(1);
  });

  test("a first oversized plan is denied without even creating zero counter rows", async () => {
    expect(unwrap(await reserveAiDailyBudget(input("large", "source-a", 3))).status).toBe("limited");
    const [counters] = await sql<{ mailbox: number; source: number }[]>`
      SELECT (SELECT count(*)::int FROM mail.ai_daily_mailbox_usage WHERE mailbox_id = ${mailboxId}::uuid) AS mailbox,
        (SELECT count(*)::int FROM mail.ai_daily_source_usage WHERE mailbox_id = ${mailboxId}::uuid) AS source
    `;
    expect(counters).toEqual({ mailbox: 0, source: 0 });
    expect(await reservationCount()).toBe(0);
  });

  test("mailbox cap includes other sources and reports mailbox scope without changing mail", async () => {
    await setLimit(1);
    unwrap(await reserveAiDailyBudget(input("a", "source-a")));
    const beforeMail = await mailSnapshot();
    const denied = unwrap(await reserveAiDailyBudget(input("b", "source-b")));
    expect(denied).toEqual({ status: "limited", scope: "mailbox", limit: 1, resetsAt: midnight });
    expect(await mailSnapshot()).toEqual(beforeMail);
    expect(await stats("source-b")).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 0, limitedUntil: midnight });
    expect(await reservationCount()).toBe(1);
  });

  test("one concurrent burst cannot oversubscribe a source", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => reserveAiDailyBudget(input(`burst-${i}`))));
    const outcomes = results.map(unwrap);
    expect(outcomes.filter((r) => r.status === "reserved")).toHaveLength(2);
    expect(outcomes.filter((r) => r.status === "limited" && r.scope === "rule")).toHaveLength(14);
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 2, limitedUntil: midnight });
  });

  test("one concurrent burst of different sources cannot oversubscribe the mailbox", async () => {
    await setLimit(3);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => reserveAiDailyBudget(input(`burst-${i}`, `source-${i}`))));
    const outcomes = results.map(unwrap);
    expect(outcomes.filter((r) => r.status === "reserved")).toHaveLength(3);
    expect(outcomes.filter((r) => r.status === "limited" && r.scope === "mailbox")).toHaveLength(13);
    expect(await reservationCount()).toBe(3);
  });

  test("concurrent duplicate keys share exactly one hold; consumed retries never charge twice", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveAiDailyBudget(input())));
    for (const result of results) expect(unwrap(result).status).toBe("reserved");
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 1 });
    expect(await reservationCount()).toBe(1);
    const settlements = await Promise.all(Array.from({ length: 12 }, () => consumeAiDailyBudget({ ...input(), actualCalls: 1 })));
    for (const result of settlements) expect(result.ok).toBe(true);
    const repeated = unwrap(await reserveAiDailyBudget(input()));
    expect(repeated.status).toBe("consumed");
    expect(await stats()).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 0 });
    expect(repeated).not.toHaveProperty("reservation.db");
  });

  test("failure releases both scopes exactly once and the same retry key can reserve again", async () => {
    await setLimit(1);
    unwrap(await reserveAiDailyBudget(input()));
    await Promise.all(Array.from({ length: 12 }, async () => unwrap(await releaseAiDailyBudget(input()))));
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 0, limitedUntil: null });
    expect(unwrap(await reserveAiDailyBudget(input())).status).toBe("reserved");
    unwrap(await releaseAiDailyBudget(input()));
    expect(unwrap(await reserveAiDailyBudget(input("other", "source-b"))).status).toBe("reserved");
    unwrap(await releaseAiDailyBudget(input("unknown")));
  });

  test("success charges actual calls, frees unused maximum, and release cannot undo success", async () => {
    unwrap(await reserveAiDailyBudget({ ...input("max", "source-a", 2), maxAiCallsPerDay: 3 }));
    unwrap(await consumeAiDailyBudget({ ...input("max"), actualCalls: 1 }));
    unwrap(await releaseAiDailyBudget(input("max")));
    expect(await stats()).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 0 });
    expect(unwrap(await reserveAiDailyBudget(input("next"))).status).toBe("reserved");
    expect((await consumeAiDailyBudget({ ...input("max"), actualCalls: 2 })).ok).toBe(false);
    expect(await stats()).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 1 });
  });

  test("rejects changed maxima and overconsumption without changing the hold", async () => {
    unwrap(await reserveAiDailyBudget(input()));
    expect((await reserveAiDailyBudget(input("operation-1", "source-a", 2))).ok).toBe(false);
    expect((await consumeAiDailyBudget({ ...input(), actualCalls: 2 })).ok).toBe(false);
    expect((await consumeAiDailyBudget({ ...input("missing"), actualCalls: 1 })).ok).toBe(false);
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 1 });
  });

  test("a zero-call plan can run at a paused mailbox without spending AI capacity", async () => {
    await setLimit(0);
    expect(unwrap(await reserveAiDailyBudget(input("none", "source-a", 0))).status).toBe("reserved");
    unwrap(await consumeAiDailyBudget({ ...input("none"), actualCalls: 0 }));
    expect(unwrap(await reserveAiDailyBudget(input("ai")))).toEqual({ status: "limited", scope: "mailbox", limit: 0, resetsAt: midnight });
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 0 });
  });

  test("source counters share versions by stable source ID and remain isolated across mailboxes", async () => {
    unwrap(await reserveAiDailyBudget(input()));
    unwrap(await consumeAiDailyBudget({ ...input(), actualCalls: 1 }));
    unwrap(await reserveAiDailyBudget({ ...input("new-version"), sourceName: "Renamed source, new version" }));
    expect(await stats()).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 1 });
    const other = unwrap(await createMailbox(owner, { name: "Other daily mailbox" }));
    mailboxes.push(other.id);
    expect(unwrap(await reserveAiDailyBudget({ ...input(), mailboxId: other.id })).status).toBe("reserved");
    expect(unwrap(await getAiDailySourceStats({ mailboxId: other.id, sourceId: "source-a" }))).toMatchObject({
      aiCallsToday: 0,
      reservedAiCalls: 1,
    });
  });

  test("source and mailbox counters reset at local midnight, including a 25-hour DST day", async () => {
    await setLimit(1);
    unwrap(await reserveAiDailyBudget({ ...input(), maxAiCallsPerDay: 1 }));
    unwrap(await consumeAiDailyBudget({ ...input(), actualCalls: 1 }));
    expect(await stats("source-a", 1)).toMatchObject({ aiCallsToday: 1, limitedUntil: midnight });
    setSystemTime(new Date(midnight));
    expect(await stats("source-a", 1)).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 0, limitedUntil: null, resetsAt: resetAfterDst });
    const next = unwrap(await reserveAiDailyBudget({ ...input("next-day"), maxAiCallsPerDay: 1 }));
    expect(next.status).toBe("reserved");
    if (next.status !== "limited")
      expect(next.reservation).toMatchObject({ day: "2026-10-25", timeZone: "Europe/Berlin", resetsAt: resetAfterDst });
    expect(unwrap(await reserveAiDailyBudget(input("other", "source-b")))).toEqual({
      status: "limited",
      scope: "mailbox",
      limit: 1,
      resetsAt: resetAfterDst,
    });
    setSystemTime(new Date(resetAfterDst));
    expect(unwrap(await reserveAiDailyBudget(input("following-day"))).status).toBe("reserved");
  });

  test("old holds settle against their original day and never free or charge today's capacity", async () => {
    await setLimit(2);
    unwrap(await reserveAiDailyBudget(input("old-success")));
    unwrap(await reserveAiDailyBudget(input("old-failure")));
    setSystemTime(new Date(midnight));
    unwrap(await reserveAiDailyBudget(input("today")));
    unwrap(await consumeAiDailyBudget({ ...input("old-success"), actualCalls: 1 }));
    unwrap(await releaseAiDailyBudget(input("old-failure")));
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 1 });
    const repeated = unwrap(await reserveAiDailyBudget(input("old-success")));
    expect(repeated.status).toBe("consumed");
    if (repeated.status !== "limited") expect(repeated.reservation.day).toBe("2026-10-24");
    expect(unwrap(await reserveAiDailyBudget(input("old-failure"))).status).toBe("reserved");
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 2 });
  });

  test("uses the installation zone east or west of UTC, with Mail's fallback for an unset zone", async () => {
    const timeZone = "America/New_York";
    setTimeZone(timeZone);
    setSystemTime(new Date("2026-07-04T03:59:59.000Z"));
    const result = unwrap(await reserveAiDailyBudget(input()));
    if (result.status === "limited") throw new Error("Unexpected limit");
    expect(result.reservation).toMatchObject({ day: "2026-07-03", timeZone, resetsAt: "2026-07-04T04:00:00.000Z" });
    setTimeZone("");
    expect(await stats()).toMatchObject({ timeZone: "Europe/Berlin", resetsAt: "2026-07-04T22:00:00.000Z" });
  });

  test("caller transaction rolls a reservation back together with a mail effect", async () => {
    const before = await mailSnapshot();
    await expect(
      sql.begin(async (db) => {
        unwrap(await reserveAiDailyBudget({ ...input(), db }));
        await db`UPDATE mail.conversations SET summary = 'Changed atomically' WHERE id = ${conversationId}::uuid`;
        throw new Error("Rollback pending write");
      }),
    ).rejects.toThrow("Rollback pending write");
    expect(await reservationCount()).toBe(0);
    expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 0 });
    expect(await mailSnapshot()).toEqual(before);
  });

  test("caller transaction rolls release/consume back, then commits settlement with mail state", async () => {
    unwrap(await reserveAiDailyBudget(input()));
    for (const settle of [
      (db: typeof sql) => releaseAiDailyBudget({ ...input(), db }),
      (db: typeof sql) => consumeAiDailyBudget({ ...input(), actualCalls: 1, db }),
    ]) {
      await expect(
        sql.begin(async (db) => {
          unwrap(await settle(db));
          throw new Error("Rollback settlement");
        }),
      ).rejects.toThrow("Rollback settlement");
      expect(await stats()).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 1 });
    }
    await sql.begin(async (db) => {
      // The reservation API acquires the mailbox lock before any conversation mutation.
      unwrap(await consumeAiDailyBudget({ ...input(), actualCalls: 1, db }));
      await db`UPDATE mail.conversations SET summary = 'Committed atomically' WHERE id = ${conversationId}::uuid`;
    });
    expect(await stats()).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 0 });
    expect(await mailSnapshot()).toMatchObject({ summary: "Committed atomically" });
  });

  test("mailbox admin setting defaults to null; write access cannot read or change it", async () => {
    expect(unwrap(await getMailboxAiDailyLimit({ context: owner, mailboxId }))).toEqual({ maxAiCallsPerDay: null });
    if (member.accessSubject.type !== "user") throw new Error("Missing member user");
    unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId,
        principal: { type: "user", userId: member.accessSubject.userId },
        permission: "write",
      }),
    );
    expect((await getMailboxAiDailyLimit({ context: member, mailboxId })).ok).toBe(false);
    const changed = await updateMailboxAiDailyLimit({ context: member, mailboxId, maxAiCallsPerDay: 9 });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("FORBIDDEN");
    expect(unwrap(await getMailboxAiDailyLimit({ context: owner, mailboxId }))).toEqual({ maxAiCallsPerDay: null });
    await setLimit(3);
    expect(unwrap(await getMailboxAiDailyLimit({ context: owner, mailboxId }))).toEqual({ maxAiCallsPerDay: 3 });
    await setLimit(null);
    expect(unwrap(await getMailboxAiDailyLimit({ context: owner, mailboxId }))).toEqual({ maxAiCallsPerDay: null });
  });

  test("lowering the cap blocks new keys but preserves admitted retries and completed usage", async () => {
    unwrap(await reserveAiDailyBudget(input()));
    await setLimit(0);
    expect(unwrap(await reserveAiDailyBudget(input())).status).toBe("reserved");
    expect(unwrap(await reserveAiDailyBudget(input("new")))).toEqual({ status: "limited", scope: "mailbox", limit: 0, resetsAt: midnight });
    unwrap(await consumeAiDailyBudget({ ...input(), actualCalls: 1 }));
    await setLimit(null);
    expect(unwrap(await reserveAiDailyBudget(input("new"))).status).toBe("reserved");
    expect(await stats()).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 1 });
  });

  test("concurrent success and cancellation settle a hold at most once", async () => {
    unwrap(await reserveAiDailyBudget(input()));
    const [success, cancellation] = await Promise.all([
      consumeAiDailyBudget({ ...input(), actualCalls: 1 }),
      releaseAiDailyBudget(input()),
    ]);
    expect(cancellation.ok).toBe(true);
    expect(await stats()).toMatchObject({ aiCallsToday: success.ok ? 1 : 0, reservedAiCalls: 0 });
  });

  test("a denied caller transaction applies no mail effect", async () => {
    await setLimit(0);
    const before = await mailSnapshot();
    const result = await sql.begin(async (db) => {
      const admission = unwrap(await reserveAiDailyBudget({ ...input(), db }));
      if (admission.status === "limited") return admission;
      await db`UPDATE mail.conversations SET summary = 'Must not happen' WHERE id = ${conversationId}::uuid`;
      return admission;
    });
    expect(result.status).toBe("limited");
    expect(await mailSnapshot()).toEqual(before);
    expect(await reservationCount()).toBe(0);
  });

  test("rejects invalid counts without writing budget state", async () => {
    for (const count of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect((await reserveAiDailyBudget({ ...input(), plannedMaxCalls: count })).ok).toBe(false);
      expect((await reserveAiDailyBudget({ ...input(), maxAiCallsPerDay: count })).ok).toBe(false);
      expect((await updateMailboxAiDailyLimit({ context: owner, mailboxId, maxAiCallsPerDay: count })).ok).toBe(false);
    }
    expect((await reserveAiDailyBudget({ ...input(), maxAiCallsPerDay: 0 })).ok).toBe(false);
    expect((await reserveAiDailyBudget({ ...input(), sourceId: " " })).ok).toBe(false);
    expect((await reserveAiDailyBudget({ ...input(), reservationKey: " " })).ok).toBe(false);
    expect(await reservationCount()).toBe(0);
  });
});
