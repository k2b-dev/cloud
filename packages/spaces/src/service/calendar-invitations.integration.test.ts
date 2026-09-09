import { describe, expect, test } from "bun:test";
import { crypto as stdCrypto } from "@k2b/stdlib";
import type { AccessSubject } from "@k2b/cloud/server";
import { sql } from "bun";
import type { User } from "../contracts";
import {
  getCalendarResponseCommitContext,
  importCalendarInvitation,
  prepareCalendarResponse,
  prepareEventInvitationAttachment,
} from "./calendar-invitations";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ sources: string | null; users: string | null }[]>`
      SELECT
        to_regclass('spaces.calendar_invitation_sources')::text AS sources,
        to_regclass('auth.users')::text AS users
    `;
    return Boolean(row?.sources && row.users);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseDatabase()) ? describe : describe.skip;

const advisoryWaiterCount = async (blockerPid: number) => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pg_stat_activity activity
    WHERE ${blockerPid}::int = ANY(pg_blocking_pids(activity.pid))
  `;
  return row?.count ?? 0;
};

const waitForAdvisoryWaiters = async (blockerPid: number, minimum: number) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await advisoryWaiterCount(blockerPid)) >= minimum) return true;
    await Bun.sleep(10);
  }
  return false;
};

const calendar = (uid: string, sequence: number, recurrenceRule?: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    "DTSTART:20260812T100000Z",
    "DTEND:20260812T110000Z",
    `SUMMARY:Sequence ${sequence}`,
    ...(recurrenceRule ? [`RRULE:${recurrenceRule}`] : []),
    "ORGANIZER:mailto:organizer@example.test",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

suite("Spaces calendar invitation imports", () => {
  test("serializes source mutations and preserves authorization and recurrence invariants", async () => {
    const suffix = crypto.randomUUID();
    const mailboxId = stdCrypto.common.readableId(6);
    const uid = `calendar-import-${suffix}@example.test`;
    let userId: string | null = null;
    let spaceId: string | null = null;
    let accessId: string | null = null;
    let blocker: Awaited<ReturnType<typeof sql.reserve>> | null = null;
    let blockerLocked = false;
    const pendingImports: Promise<unknown>[] = [];

    try {
      const [userRow] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, mail)
        VALUES (${`calendar-import-${suffix}`}, 'local', 'user', 'Calendar Import', ${`calendar-import-${suffix}@example.test`})
        RETURNING id
      `;
      userId = userRow!.id;
      const [space] = await sql<{ id: string }[]>`
        INSERT INTO spaces.spaces (short_id, name, color)
        VALUES (${stdCrypto.common.readableId(6)}, ${`Calendar Import ${suffix}`}, '#3b82f6')
        RETURNING id
      `;
      spaceId = space!.id;
      await sql`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${stdCrypto.common.readableId(6)}, ${spaceId}::uuid, 'Calendar', 1024, false)
      `;
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'write') RETURNING id
      `;
      accessId = access!.id;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${accessId}::uuid)`;

      const user = {
        id: userId,
        uid: `calendar-import-${suffix}`,
        roles: ["user"],
        provider: "local",
        profile: "user",
        givenname: "Calendar",
        sn: "Import",
        displayName: "Calendar Import",
        mail: `calendar-import-${suffix}@example.test`,
        avatarHash: null,
        ipa: null,
        accountExpires: null,
        lastLoginLocal: null,
        memberofGroup: [],
        memberofGroupIds: [],
        manages: [],
        managesGroupIds: [],
      } satisfies User;
      const subject = { type: "user", userId } satisfies AccessSubject;
      const importSequence = (sequence: number, recurrenceRule?: string) =>
        importCalendarInvitation({
          input: {
            mailboxId,
            messageId: stdCrypto.common.readableId(6),
            spaceId: spaceId!,
            calendar: calendar(uid, sequence, recurrenceRule),
            conversation: { ref: { type: "mail.conversation", id: "Conv01" }, label: "Planning" },
          },
          user,
          subject,
        });

      const initial = await importSequence(3);
      expect(initial).toMatchObject({ ok: true, data: { outcome: "created" } });

      blocker = await sql.reserve();
      const lockKey = `spaces:calendar-invitation:${mailboxId}:${uid}`;
      const [backend] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      await blocker`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
      blockerLocked = true;
      const older = importSequence(4);
      pendingImports.push(older);
      expect(await waitForAdvisoryWaiters(backend!.pid, 1)).toBeTrue();
      const newer = importSequence(5);
      pendingImports.push(newer);
      expect(await waitForAdvisoryWaiters(backend!.pid, 2)).toBeTrue();
      await blocker`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
      blockerLocked = false;
      blocker.release();
      blocker = null;
      const [olderResult, newerResult] = await Promise.all([older, newer]);

      expect(olderResult).toMatchObject({ ok: true, data: { outcome: "updated" } });
      expect(newerResult).toMatchObject({ ok: true, data: { outcome: "updated" } });
      const [source] = await sql<{ sequence: number; message_id: string; title: string }[]>`
        SELECT source.sequence, source.message_id, item.title
        FROM spaces.calendar_invitation_sources source
        JOIN spaces.items item ON item.id = source.item_id
        WHERE mailbox_id = ${mailboxId} AND calendar_uid = ${uid}
      `;
      expect(source?.sequence).toBe(5);
      expect(source?.title).toBe("Sequence 5");
      const [resourceReference] = await sql<{ count: number; label: string }[]>`
        SELECT COUNT(*)::int AS count, MAX(reference.label) AS label
        FROM spaces.item_resource_refs reference
        JOIN spaces.calendar_invitation_sources source ON source.item_id = reference.item_id
        WHERE source.mailbox_id = ${mailboxId} AND source.calendar_uid = ${uid}
          AND reference.resource_type = 'mail.conversation' AND reference.resource_id = 'Conv01'
      `;
      expect(resourceReference).toEqual({ count: 1, label: "Planning" });

      const inaccessibleSubject = { type: "user", userId: crypto.randomUUID() } satisfies AccessSubject;
      const hidden = failSignature("Add this invitation to Spaces before responding");
      const responseInput = {
        mailboxId,
        messageId: source!.message_id,
        calendar: calendar(uid, 4),
        attendee: { name: "Attendee", address: "attendee@example.test" },
        participationStatus: "accepted" as const,
      };
      expect(await prepareCalendarResponse({ input: responseInput, subject: inaccessibleSubject })).toEqual(hidden);
      expect(
        await getCalendarResponseCommitContext({
          input: {
            mailboxId,
            messageId: source!.message_id,
            draftId: stdCrypto.common.readableId(6),
            participationStatus: "accepted",
          },
          subject: inaccessibleSubject,
        }),
      ).toEqual(hidden);

      const [linked] = await sql<{ item_id: string; item_short_id: string; column_id: string }[]>`
        SELECT source.item_id, item.short_id AS item_short_id, item.column_id
        FROM spaces.calendar_invitation_sources source
        JOIN spaces.items item ON item.id = source.item_id
        WHERE source.mailbox_id = ${mailboxId} AND source.calendar_uid = ${uid}
      `;

      const outgoingUid = `${linked!.item_short_id}@spaces.cloud`;
      blocker = await sql.reserve();
      const outgoingLockKey = `spaces:calendar-invitation:${mailboxId}:${outgoingUid}`;
      const [outgoingBackend] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      await blocker`SELECT pg_advisory_lock(hashtextextended(${outgoingLockKey}, 0))`;
      blockerLocked = true;
      const competingImport = importCalendarInvitation({
        input: {
          mailboxId,
          messageId: stdCrypto.common.readableId(6),
          spaceId,
          calendar: calendar(outgoingUid, 0),
          conversation: { ref: { type: "mail.conversation", id: "Conv01" }, label: "Planning" },
        },
        user,
        subject,
      });
      pendingImports.push(competingImport);
      expect(await waitForAdvisoryWaiters(outgoingBackend!.pid, 1)).toBeTrue();
      const outgoingPreparation = prepareEventInvitationAttachment({
        spaceId,
        itemId: linked!.item_id,
        subject,
        deliveryId: crypto.randomUUID(),
        mailboxId,
        draftId: stdCrypto.common.readableId(6),
        senderIdentityId: stdCrypto.common.readableId(6),
        organizer: { name: "Organizer", address: "organizer@example.test" },
        attendees: [{ name: "Attendee", address: "attendee@example.test" }],
      });
      pendingImports.push(outgoingPreparation);
      expect(await waitForAdvisoryWaiters(outgoingBackend!.pid, 2)).toBeTrue();
      await blocker`SELECT pg_advisory_unlock(hashtextextended(${outgoingLockKey}, 0))`;
      blockerLocked = false;
      blocker.release();
      blocker = null;
      expect(await competingImport).toMatchObject({ ok: true, data: { outcome: "created" } });
      expect(await outgoingPreparation).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

      const [series] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, starts_at, ends_at, recurrence_rrule, rank, created_by)
        VALUES (
          ${stdCrypto.common.readableId(6)}, ${spaceId}::uuid, ${linked!.column_id}::uuid, 'Parent series',
          '2026-08-12T10:00:00.000Z'::timestamptz, '2026-08-12T11:00:00.000Z'::timestamptz,
          'FREQ=DAILY;COUNT=3', 2048, ${userId}::uuid
        )
        RETURNING id
      `;
      await sql`
        UPDATE spaces.items
        SET recurring_event_id = ${series!.id}::uuid, recurrence_id = starts_at
        WHERE id = ${linked!.item_id}::uuid
      `;
      const invalidSeries = await importSequence(6, "FREQ=DAILY;COUNT=3");
      expect(invalidSeries).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
      const [unchanged] = await sql<{ recurrence_rrule: string | null; sequence: number }[]>`
        SELECT item.recurrence_rrule, source.sequence
        FROM spaces.calendar_invitation_sources source
        JOIN spaces.items item ON item.id = source.item_id
        WHERE source.item_id = ${linked!.item_id}::uuid
      `;
      expect(unchanged).toEqual({ recurrence_rrule: null, sequence: 5 });
    } finally {
      if (blocker) {
        if (blockerLocked) {
          await blocker`SELECT pg_advisory_unlock_all()`.catch(() => undefined);
        }
        blocker.release();
      }
      await Promise.allSettled(pendingImports);
      if (spaceId) await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});

const failSignature = (message: string) => ({ ok: false as const, error: { code: "BAD_INPUT", message, status: 400 as const } });
