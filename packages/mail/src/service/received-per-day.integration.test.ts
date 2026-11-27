import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { redis, sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { loadReceivedPerDay, peekReceivedPerDay, receivedPerDayLoadLimit } from "./received-per-day";

// The mails a mailbox received per day, for the v2 reader while none is open: one statement, a day in the reader's time
// zone, received means filed and never in Sent, Drafts or Junk, and an assigned-only reader counts only what it may see.
// The clock is fixed: Friday 27 November 2026, 10:00 UTC, read in Berlin.
const suite = suiteFor("database", "nats", "valkey");
const now = new Date("2026-11-27T10:00:00.000Z");
const timeZone = "Europe/Berlin";

suite("Mail received per day", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: string[] = [];
  let mailboxId = "";
  let readerId = "";
  let otherReaderId = "";
  const folders: Record<"inbox" | "sent" | "junk" | "drafts" | "all" | "archive" | "trash", string> = {
    inbox: "",
    sent: "",
    junk: "",
    drafts: "",
    all: "",
    archive: "",
    trash: "",
  };
  // the mailbox sends as this identity; a mail from it is one it sent, wherever it lies now
  const own = `Kontakt-${suffix}@Example.test`;
  let nextUid = 1;

  const user = async (role: string) => {
    const [row] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`received-${role}-${suffix}`}, 'local', 'user', ${`Received ${role}`}, false) RETURNING id, uid`;
    if (!row) throw new Error("Received fixture user missing");
    users.push(row.id);
    return row;
  };
  const conversation = async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations (short_id, mailbox_id, subject, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Lieferung', now()) RETURNING id`;
    return row!.id;
  };
  /** A message at `at` from `from`, filed in `filedIn` (a deleted copy when `deleted`), in `conversationId`. */
  const message = async (
    conversationId: string,
    at: string,
    filedIn: (keyof typeof folders)[],
    options: { deleted?: boolean; from?: string } = {},
  ) => {
    const deleted = options.deleted ?? false;
    const from = options.from ?? "lieferant@example.test";
    const uid = nextUid++;
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<received-${uid}-${suffix}@example.test>`}, 'Lieferung', 'lieferung',
        ${at}::timestamptz, 1, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'complete', 'Text') RETURNING id`;
    for (const folder of filedIn) {
      const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folders[folder]}::uuid, ${row!.id}::uuid, 1, ${uid}) RETURNING id`;
      await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, deleted_at)
        VALUES (${ref!.id}::uuid, ${folders[folder]}::uuid, ${row!.id}::uuid, ${deleted ? now.toISOString() : null}::timestamptz)`;
    }
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      VALUES (${row!.id}::uuid, 'from', 0, ${from}, ${from.toLowerCase()})`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position) VALUES (${conversationId}::uuid, ${row!.id}::uuid, ${uid})`;
  };

  beforeAll(async () => {
    const owner = await user("owner");
    readerId = (await user("reader")).id;
    otherReaderId = (await user("other-reader")).id;
    const context: MailRequestContext = {
      actor: {
        kind: "user",
        user: {
          ...owner,
          provider: "local",
          profile: "user",
          displayName: owner.uid,
          mail: `${owner.uid}@example.test`,
          roles: ["user"],
        } as never,
      },
      accessSubject: { type: "user", userId: owner.id },
      requestId: `received-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Received ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'active') RETURNING id`;
    for (const role of Object.keys(folders) as (keyof typeof folders)[]) {
      const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role)
        VALUES (${newShortId()}, ${resource!.id}::uuid, ${`${role}-${suffix}`}, ${role}, ${role}) RETURNING id`;
      folders[role] = folder!.id;
    }
    await sql`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Kontakt', 'Kontakt', ${own}, 'disabled', 'verified')`;
    const assigned = await conversation();
    const other = await conversation();
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${assigned}::uuid, ${readerId}::uuid)`;
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${other}::uuid, ${otherReaderId}::uuid)`;
    // today in Berlin: one in the inbox, and one at 00:30 Berlin time, which is still the 26th in UTC
    await message(assigned, "2026-11-27T08:00:00Z", ["inbox"]);
    await message(other, "2026-11-26T23:30:00Z", ["inbox"]);
    // sent: in Sent and All Mail, moved to Archive, moved to Trash; the identity matches whatever its case
    await message(other, "2026-11-26T10:00:00Z", ["sent", "all"], { from: own.toLowerCase() });
    await message(other, "2026-11-19T10:00:00Z", ["archive"], { from: own });
    await message(other, "2026-11-18T10:00:00Z", ["trash"], { from: own });
    // a received mail in Trash still came in
    await message(other, "2026-11-17T10:00:00Z", ["trash"]);
    // junk, a draft and a deleted copy count neither way
    await message(other, "2026-11-25T10:00:00Z", ["junk"]);
    await message(other, "2026-11-25T11:00:00Z", ["drafts"], { from: own });
    await message(other, "2026-11-24T10:00:00Z", ["inbox"], { deleted: true });
    // archived: only in All Mail, still received
    await message(assigned, "2026-11-20T10:00:00Z", ["all"]);
    // the first of the 371 days, the day before, and tomorrow in Berlin
    await message(other, "2025-11-22T10:00:00Z", ["inbox"]);
    await message(other, "2025-11-21T10:00:00Z", ["inbox"]);
    await message(other, "2026-11-27T23:30:00Z", ["inbox"]);
  });
  afterAll(async () => {
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    await sql`DELETE FROM audit.events WHERE request_id = ${`received-${suffix}`}`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  const everything = { scope: "mailbox", permission: "read" } as const;

  test("one statement counts the mails in and out per day of the last 371 days in the reader's time zone; then the cache answers", async () => {
    const meter = await meterSql();
    try {
      let received: Awaited<ReturnType<typeof loadReceivedPerDay>> | undefined;
      const statements = await meter.during(async () => {
        received = await loadReceivedPerDay({ mailboxId, access: everything, timeZone, now });
      });
      expect(statements).toHaveLength(1);
      expect(received).toEqual({
        today: "2026-11-27",
        days: [
          { date: "2025-11-22", incoming: 1, sent: 0 },
          { date: "2026-11-17", incoming: 1, sent: 0 },
          { date: "2026-11-18", incoming: 0, sent: 1 },
          { date: "2026-11-19", incoming: 0, sent: 1 },
          { date: "2026-11-20", incoming: 1, sent: 0 },
          { date: "2026-11-26", incoming: 0, sent: 1 },
          { date: "2026-11-27", incoming: 2, sent: 0 },
        ],
      });
      // the same reader, time zone and day again: from the cache, without a statement
      const again = await meter.during(async () => {
        expect(await loadReceivedPerDay({ mailboxId, access: everything, timeZone, now })).toEqual(received!);
      });
      expect(again).toHaveLength(0);
    } finally {
      await meter.close();
    }
  });

  test("two assigned-only readers each count their own conversations; the cache keeps them apart", async () => {
    const mine = await loadReceivedPerDay({
      mailboxId,
      access: { scope: "assigned", permission: "read", userId: readerId },
      timeZone,
      now,
    });
    expect(mine?.days).toEqual([
      { date: "2026-11-20", incoming: 1, sent: 0 },
      { date: "2026-11-27", incoming: 1, sent: 0 },
    ]);
    const theirs = await loadReceivedPerDay({
      mailboxId,
      access: { scope: "assigned", permission: "read", userId: otherReaderId },
      timeZone,
      now,
    });
    expect(theirs?.days.map((day) => day.date)).toEqual([
      "2025-11-22",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-26",
      "2026-11-27",
    ]);
  });

  test("a day is the reader's: in UTC the mail of 00:30 Berlin time falls on the day before, the late one on today", async () => {
    const received = await loadReceivedPerDay({ mailboxId, access: everything, timeZone: "UTC", now });
    expect(received?.days.slice(-2)).toEqual([
      { date: "2026-11-26", incoming: 1, sent: 1 },
      { date: "2026-11-27", incoming: 2, sent: 0 },
    ]);
  });

  test("concurrent misses count once; a page only peeks and never counts", async () => {
    const meter = await meterSql();
    try {
      const paris = { mailboxId, access: everything, timeZone: "Europe/Paris", now };
      const peeked = await meter.during(async () => {
        expect(await peekReceivedPerDay(paris)).toBeNull();
      });
      expect(peeked).toHaveLength(0);
      let answers: unknown[] = [];
      const statements = await meter.during(async () => {
        answers = await Promise.all(Array.from({ length: 5 }, () => loadReceivedPerDay(paris)));
      });
      expect(statements).toHaveLength(1);
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
      expect(await peekReceivedPerDay(paris)).toEqual(answers[0] as never);
    } finally {
      await meter.close();
    }
  });

  test("without the cache the counts run against the database, never more at once than the pool allows", async () => {
    const meter = await meterSql();
    // after the meter: it may bind the runtime's clients anew
    const down = spyOn(redis, "send").mockRejectedValue(new Error("Valkey down"));
    try {
      const limit = receivedPerDayLoadLimit();
      // one key per time zone: no two calls share a count
      const zones = Intl.supportedValuesOf("timeZone")
        .filter((zone) => zone.startsWith("Europe/"))
        .slice(0, limit + 3);
      let answers: unknown[] = [];
      const statements = await meter.during(async () => {
        answers = await Promise.all(zones.map((zone) => loadReceivedPerDay({ mailboxId, access: everything, timeZone: zone, now })));
      });
      expect(statements).toHaveLength(limit);
      expect(answers.filter((answer) => answer === null)).toHaveLength(3);
      expect(down).toHaveBeenCalled();
    } finally {
      await meter.close();
      down.mockRestore();
    }
  });
});
