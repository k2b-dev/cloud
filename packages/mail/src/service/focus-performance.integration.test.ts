import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailFocusView } from "../contracts";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { listFocusConversations, listFocusOverview } from "./focus";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

// The overview reads every mailbox a person can open. At 25,000 messages in four mailboxes the old
// queries took 2.2 to 3.6 s for Mine and All, almost all of it PostgreSQL compiling them with JIT, and
// so do the new ones without `SET LOCAL jit = off`; a page and its counts now take about 100 to 150 ms
// on PostgreSQL 15. The budget fails both. The opt-in performance run measures up to 100,000 messages.
const DEFAULT_MESSAGE_COUNT = 25_000;
const requestedMessageCount = Number.parseInt(process.env.MAIL_PERFORMANCE_MESSAGE_COUNT ?? "", 10);
const requestedTotal =
  process.env.MAIL_PERFORMANCE_TESTS === "1" && Number.isFinite(requestedMessageCount)
    ? Math.min(Math.max(requestedMessageCount, DEFAULT_MESSAGE_COUNT), 100_000)
    : DEFAULT_MESSAGE_COUNT;
const MAILBOX_COUNT = 4;
// Every mailbox holds the same mail, so the requested count rounds down to a multiple of the mailboxes.
const MESSAGES_PER_MAILBOX = Math.floor(requestedTotal / MAILBOX_COUNT);
const MESSAGE_COUNT = MESSAGES_PER_MAILBOX * MAILBOX_COUNT;
// The median of the warm runs keeps one stall on a busy host from failing the budget.
const BUDGET_MS = 500;
const WARM_RUNS = 5;
const VIEWS: readonly MailFocusView[] = ["mine", "unassigned", "waiting", "all"];

type Folder = "inbox" | "sent" | "archive" | "trash" | "junk";
const FOLDERS: readonly Folder[] = ["inbox", "sent", "archive", "trash", "junk"];

/**
 * Every mailbox holds the same invented mail, written once here and once in SQL below: message n
 * (1-based) belongs to conversation floor((n - 1) * 2 / 5), so threads hold two or three messages.
 */
const conversationOf = (item: number) => Math.floor(((item - 1) * 2) / 5);
const folderOf = (item: number): Folder => {
  if (conversationOf(item) % 13 === 5) return "trash";
  const slot = item % 20;
  if (slot < 4) return "sent";
  if (slot < 12 || slot === 19) return "inbox";
  if (slot < 17) return "archive";
  return slot === 17 ? "trash" : "junk";
};
const isDeleted = (item: number) => conversationOf(item) % 23 === 7 || item % 31 === 0;
const isUnread = (item: number) => item % 9 === 0;
type WorkStatus = "needs_action" | "waiting" | "done";
const workStatusOf = (conversation: number): WorkStatus =>
  conversation % 10 < 6 ? "done" : conversation % 10 === 8 ? "waiting" : "needs_action";
const snoozedNow = (conversation: number) => [9, 18, 21].includes(conversation % 40);
/** The reader, a former teammate whose access ended, and a current teammate. */
const assigneesOf = (conversation: number) => ({
  reader: conversation % 3 === 0,
  former: conversation % 3 === 1,
  teammate: conversation % 7 === 2,
});

/** Conversation `n` of a mailbox as a version 4 UUID, like the IDs Mail creates; pagination cursors accept only those. */
const conversationId = (key: string, n: Bun.SQL.Query<unknown>) =>
  sql`overlay(overlay(md5(${key} || ':conversation:' || ${n}) placing '4' from 13) placing '8' from 17)::uuid`;

const expectedMailboxCounts = () => {
  const evidence = new Map<number, { visible: boolean; followUp: boolean; unread: boolean }>();
  for (let item = 1; item <= MESSAGES_PER_MAILBOX; item += 1) {
    const conversation = conversationOf(item);
    const state = evidence.get(conversation) ?? { visible: false, followUp: false, unread: false };
    if (!isDeleted(item)) {
      state.visible = true;
      const followUp = folderOf(item) !== "trash" && folderOf(item) !== "junk";
      if (followUp) state.followUp = true;
      if (followUp && isUnread(item)) state.unread = true;
    }
    evidence.set(conversation, state);
  }
  const counts: Record<MailFocusView, number> = { mine: 0, unassigned: 0, waiting: 0, all: 0 };
  let unread = 0;
  let needsAction = 0;
  for (const [conversation, state] of evidence) {
    if (!state.visible) continue;
    if (state.unread) unread += 1;
    if (!state.followUp || snoozedNow(conversation)) continue;
    const status = workStatusOf(conversation);
    const assignees = assigneesOf(conversation);
    if (status === "needs_action") needsAction += 1;
    if (status !== "done") counts.all += 1;
    if (status === "needs_action" && assignees.reader) counts.mine += 1;
    if (status === "waiting" && assignees.reader) counts.waiting += 1;
    if (status === "needs_action" && !assignees.reader && !assignees.teammate) counts.unassigned += 1;
  }
  return { counts, unread, needsAction };
};

suite("mail focus across large mailboxes", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  let context: MailRequestContext;

  beforeAll(async () => {
    const createUser = async (role: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`mail-focus-perf-${role}-${suffix}`}, 'local', 'user', ${`Focus ${role}`}, false)
        RETURNING id
      `;
      if (!row) throw new Error(`Failed to create the ${role} user`);
      userIds.push(row.id);
      return row.id;
    };
    const readerId = await createUser("reader");
    const formerId = await createUser("former");
    const teammateId = await createUser("teammate");
    context = {
      actor: {
        kind: "user",
        user: {
          id: readerId,
          uid: `mail-focus-perf-reader-${suffix}`,
          provider: "local",
          profile: "user",
          displayName: "Focus reader",
          givenName: "Focus",
          sn: "Reader",
          mail: `mail-focus-perf-reader-${suffix}@example.com`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: readerId },
      requestId: `mail-focus-performance-${suffix}`,
    };

    for (let index = 0; index < MAILBOX_COUNT; index += 1) {
      const mailbox = await createMailbox(context, { name: `Focus ${index} ${suffix}` });
      if (!mailbox.ok) throw new Error(mailbox.error.message);
      const mailboxId = mailbox.data.id;
      mailboxIds.push(mailboxId);
      const teammate = await grantMailboxAccess({
        context,
        mailboxId,
        principal: { type: "user", userId: teammateId },
        permission: "write",
      });
      if (!teammate.ok) throw new Error(teammate.error.message);
      // Short IDs are 0 and five hex digits; each mailbox gets its own range of 0x40000.
      const base = index * 0x40000;
      const key = `${suffix}:${index}`;
      const [resource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"d".repeat(64)}, 'active')
        RETURNING id
      `;
      const folderIds = {} as Record<Folder, string>;
      for (const [position, folder] of FOLDERS.entries()) {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
          VALUES (
            ${`0${(base + 0x3ff00 + position).toString(16).padStart(5, "0")}`}, ${resource!.id}::uuid,
            ${`focus-${folder}`}, ${folder}, ${folder}, 'current'
          )
          RETURNING id
        `;
        folderIds[folder] = row!.id;
      }
      await sql`
        INSERT INTO mail.message_contents (
          id, short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash,
          hydration_status, plain_text, normalized_subject
        )
        SELECT
          md5(${key} || ':message:' || item)::uuid, '0' || lpad(to_hex(${base} + item), 5, '0'), ${mailboxId}::uuid,
          '<focus-' || ${key} || '-' || item || '@example.com>', 'Thread ' || (item - 1) * 2 / 5,
          now() - make_interval(mins => item * 7), 2048, lpad(to_hex(${base} + item), 64, '0'), 'complete',
          'Message ' || item, 'thread ' || (item - 1) * 2 / 5
        FROM generate_series(1, ${MESSAGES_PER_MAILBOX}) AS item
      `;
      await sql`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        SELECT
          (${folderIds}::jsonb ->> placed.folder)::uuid, md5(${key} || ':message:' || placed.item)::uuid, 1,
          row_number() OVER (PARTITION BY placed.folder ORDER BY placed.item)
        FROM (
          SELECT item, CASE
            WHEN (item - 1) * 2 / 5 % 13 = 5 THEN 'trash'
            WHEN item % 20 < 4 THEN 'sent'
            WHEN item % 20 < 12 OR item % 20 = 19 THEN 'inbox'
            WHEN item % 20 < 17 THEN 'archive'
            WHEN item % 20 = 17 THEN 'trash'
            ELSE 'junk'
          END AS folder
          FROM generate_series(1, ${MESSAGES_PER_MAILBOX}) AS item
        ) placed
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords, deleted_at)
        SELECT ref.id, ref.folder_id, ref.message_id,
          CASE
            WHEN item % 9 = 0 THEN ARRAY[]::text[]
            WHEN item % 37 = 0 THEN ARRAY['\\Seen', '\\Flagged']::text[]
            ELSE ARRAY['\\Seen']::text[]
          END,
          ARRAY[]::text[],
          CASE WHEN (item - 1) * 2 / 5 % 23 = 7 OR item % 31 = 0 THEN now() END
        FROM generate_series(1, ${MESSAGES_PER_MAILBOX}) AS item
        JOIN mail.remote_message_refs ref ON ref.message_id = md5(${key} || ':message:' || item)::uuid
      `;
      await sql`
        INSERT INTO mail.conversations (
          id, short_id, mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at,
          work_status, snoozed_until
        )
        SELECT
          ${conversationId(key, sql`thread.conversation`)},
          '0' || lpad(to_hex(${base} + thread.conversation), 5, '0'), ${mailboxId}::uuid,
          'Thread ' || thread.conversation, 'Person ' || thread.conversation % 700, thread.latest, thread.latest,
          CASE WHEN thread.conversation % 10 < 6 THEN 'done' WHEN thread.conversation % 10 = 8 THEN 'waiting' ELSE 'needs_action' END,
          CASE WHEN thread.conversation % 40 IN (9, 18, 21) THEN now() + interval '1 day' END
        FROM (
          SELECT (item - 1) * 2 / 5 AS conversation, max(now() - make_interval(mins => item * 7)) AS latest
          FROM generate_series(1, ${MESSAGES_PER_MAILBOX}) AS item
          GROUP BY 1
        ) thread
      `;
      await sql`
        INSERT INTO mail.conversation_assignees (conversation_id, user_id)
        SELECT ${conversationId(key, sql`thread`)}, assignee.user_id
        FROM generate_series(0, (${MESSAGES_PER_MAILBOX} - 1) * 2 / 5) AS thread
        JOIN LATERAL (
          SELECT ${readerId}::uuid AS user_id WHERE thread % 3 = 0
          UNION ALL SELECT ${formerId}::uuid WHERE thread % 3 = 1
          UNION ALL SELECT ${teammateId}::uuid WHERE thread % 7 = 2
        ) assignee ON true
      `;
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        SELECT
          ${conversationId(key, sql`(item - 1) * 2 / 5`)}, md5(${key} || ':message:' || item)::uuid,
          ${MESSAGES_PER_MAILBOX} - item, 'headers'
        FROM generate_series(1, ${MESSAGES_PER_MAILBOX}) AS item
      `;
    }

    // Bulk-loaded tables keep the statistics of the empty tables until autovacuum sees them, and the
    // plan must not depend on when that happens.
    for (const table of [
      "message_contents",
      "remote_message_refs",
      "message_placements",
      "conversations",
      "conversation_messages",
      "conversation_assignees",
    ]) {
      await sql.unsafe(`ANALYZE mail.${table}`);
    }
  }, 300_000);

  afterAll(async () => {
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      // Only a partial index covers message_placements.message_id, so cascading from each deleted
      // message would scan the whole table.
      await sql`
        DELETE FROM mail.message_placements placement
        USING mail.message_contents message
        WHERE placement.message_id = message.id AND message.mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      const accessIds = access.map((row) => row.access_id);
      if (accessIds.length > 0) {
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
      }
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  }, 600_000);

  const expected = (shownMailboxes = MAILBOX_COUNT) => {
    const perMailbox = expectedMailboxCounts();
    return {
      counts: {
        mine: perMailbox.counts.mine * shownMailboxes,
        unassigned: perMailbox.counts.unassigned * shownMailboxes,
        waiting: perMailbox.counts.waiting * shownMailboxes,
        all: perMailbox.counts.all * shownMailboxes,
      },
      mailboxCounts: mailboxIds
        .toSorted()
        .map((mailboxId) => ({ mailboxId, unread: perMailbox.unread, needsAction: perMailbox.needsAction })),
    };
  };
  const median = (durations: number[]) => durations.toSorted((left, right) => left - right)[Math.floor(durations.length / 2)]!;

  test(`opens every focus view of ${MESSAGE_COUNT.toLocaleString("en-US")} messages in ${MAILBOX_COUNT} mailboxes within ${BUDGET_MS} ms`, async () => {
    const { counts, mailboxCounts } = expected();
    expect(counts.unassigned).toBeGreaterThan(100);
    for (const view of VIEWS) {
      const durations: number[] = [];
      for (let run = 0; run <= WARM_RUNS; run += 1) {
        const startedAt = performance.now();
        const page = await listFocusConversations({ context, view });
        durations.push(performance.now() - startedAt);
        if (!page.ok) throw new Error(page.error.message);
        expect(page.data.counts).toEqual(counts);
        expect(page.data.items).toHaveLength(Math.min(50, counts[view]));
        expect(page.data.mailboxCounts).toEqual(mailboxCounts);
      }
      const warm = durations.slice(1);
      console.info(`Mail focus ${view} of ${MESSAGE_COUNT} messages: ${warm.map((value) => value.toFixed(1)).join(", ")} ms`);
      expect(median(warm)).toBeLessThan(BUDGET_MS);
    }
  }, 300_000);

  test("pages through a view across mailboxes newest first, each conversation once", async () => {
    const { counts } = expected();
    const seen: { id: string; latestMessageAt: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await listFocusConversations({ context, view: "unassigned", limit: 100, cursor });
      if (!page.ok) throw new Error(page.error.message);
      seen.push(...page.data.items);
      cursor = page.data.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(counts.unassigned);
    expect(new Set(seen.map((item) => item.id)).size).toBe(counts.unassigned);
    const order = seen.map((item) => `${item.latestMessageAt}|${item.id}`);
    expect(order).toEqual(order.toSorted((left, right) => right.localeCompare(left)));
  }, 120_000);

  test(`opens the overview with the first page of every view within ${BUDGET_MS} ms`, async () => {
    const { counts, mailboxCounts } = expected();
    const durations: number[] = [];
    for (let run = 0; run <= WARM_RUNS; run += 1) {
      const startedAt = performance.now();
      const overview = await listFocusOverview({ context });
      durations.push(performance.now() - startedAt);
      if (!overview.ok) throw new Error(overview.error.message);
      expect(overview.data.counts).toEqual(counts);
      expect(overview.data.mailboxCounts).toEqual(mailboxCounts);
      for (const view of VIEWS) expect(overview.data.pages[view].items).toHaveLength(Math.min(50, counts[view]));
    }
    const single = await listFocusConversations({ context, view: "unassigned" });
    const overview = await listFocusOverview({ context });
    if (!single.ok || !overview.ok) throw new Error("Focus read failed");
    expect(overview.data.pages.unassigned).toEqual({ items: single.data.items, nextCursor: single.data.nextCursor });
    const warm = durations.slice(1);
    console.info(`Mail focus overview of ${MESSAGE_COUNT} messages: ${warm.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(median(warm)).toBeLessThan(BUDGET_MS);
  }, 120_000);

  test("leaves a hidden mailbox out of the views but keeps its own counts", async () => {
    const hidden = mailboxIds[0]!;
    const { counts, mailboxCounts } = expected(MAILBOX_COUNT - 1);
    const page = await listFocusConversations({ context, view: "all", excludedMailboxIds: [hidden] });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.counts).toEqual(counts);
    expect(page.data.mailboxCounts).toEqual(mailboxCounts);
    expect(page.data.items.some((item) => item.mailboxId === hidden)).toBe(false);
  }, 60_000);
});
