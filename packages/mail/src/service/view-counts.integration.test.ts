import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { type ConversationViewCounts, getConversationViewCounts } from "./messages";

const suite = suiteFor("database", "nats");

// 5,000 messages are enough for the planner to price the counts like a large mailbox; the opt-in
// performance run measures the same mailbox at 20,000 or 100,000 messages.
const requestedMessageCount = Number.parseInt(process.env.MAIL_PERFORMANCE_MESSAGE_COUNT ?? "", 10);
const MESSAGE_COUNT =
  process.env.MAIL_PERFORMANCE_TESTS === "1" && Number.isFinite(requestedMessageCount)
    ? Math.min(Math.max(requestedMessageCount, 5_000), 100_000)
    : 5_000;
// Warm counts took about 60 ms at 5,000 messages, 95 ms at 20,000 and 340 ms at 100,000. Before,
// PostgreSQL spent about 5 s compiling the query with JIT at each of these sizes, 4.6 s at 5,000.
const BUDGET_MS = 1_000;

type Folder = "inbox" | "sent" | "archive" | "trash" | "junk" | "spam" | "all";
const FOLDERS: readonly Folder[] = ["inbox", "sent", "archive", "trash", "junk", "spam", "all"];
/** Trash, the provider's Junk, and a custom Spam folder that a role override turns into Junk. */
const HIDDEN_FROM_FOLLOW_UP: ReadonlySet<Folder> = new Set(["trash", "junk", "spam"]);

/**
 * The invented mailbox, written once here and once in SQL below: message n (1-based) belongs to
 * conversation floor((n - 1) * 2 / 5), so threads hold two or three messages. Most messages are
 * filed by n % 20; some threads sit entirely in Trash or Spam, and some copies were deleted.
 */
const conversationOf = (item: number) => Math.floor(((item - 1) * 2) / 5);
const foldersOf = (item: number): Folder[] => {
  const conversation = conversationOf(item);
  if (conversation % 13 === 5) return ["trash"];
  if (conversation % 17 === 6) return ["spam"];
  const slot = item % 20;
  if (slot < 4) return ["sent"];
  if (slot < 12) return ["inbox"];
  if (slot < 17) return ["archive"];
  if (slot === 17) return ["trash"];
  if (slot === 18) return ["junk"];
  return ["inbox", "all"];
};
const isDeleted = (item: number) => conversationOf(item) % 23 === 7 || item % 31 === 0;
const workStatusOf = (conversation: number) => (conversation % 10 < 6 ? "done" : conversation % 10 === 8 ? "waiting" : "needs_action");
/** Snoozed until tomorrow, or a snooze that already ran out. */
const snoozeOf = (conversation: number) => (conversation % 40 === 9 ? "future" : conversation % 40 === 19 ? "past" : null);
/** The reader, a former teammate without access, or nobody. */
const assigneeOf = (conversation: number) => (conversation % 3 === 0 ? "reader" : conversation % 3 === 1 ? "former" : null);

const expectedCounts = (): ConversationViewCounts => {
  const evidence = new Map<number, { visible: boolean; followUp: boolean }>();
  for (let item = 1; item <= MESSAGE_COUNT; item += 1) {
    const conversation = conversationOf(item);
    const state = evidence.get(conversation) ?? { visible: false, followUp: false };
    if (!isDeleted(item)) {
      state.visible = true;
      if (foldersOf(item).some((folder) => !HIDDEN_FROM_FOLLOW_UP.has(folder))) state.followUp = true;
    }
    evidence.set(conversation, state);
  }
  const counts: ConversationViewCounts = {
    needs_action: 0,
    mine: 0,
    unassigned: 0,
    waiting: 0,
    done: 0,
    snoozed: 0,
    send_problems: 0,
    recently_active: 0,
  };
  for (const [conversation, state] of evidence) {
    if (!state.visible) continue;
    const status = workStatusOf(conversation);
    const snoozed = snoozeOf(conversation) === "future";
    counts.recently_active += 1;
    if (status === "done") counts.done += 1;
    if (!state.followUp) continue;
    if (snoozed) {
      counts.snoozed += 1;
      continue;
    }
    if (status === "needs_action") counts.needs_action += 1;
    if (status === "waiting") counts.waiting += 1;
    if (status !== "done" && assigneeOf(conversation) === "reader") counts.mine += 1;
    if (status !== "done" && assigneeOf(conversation) !== "reader") counts.unassigned += 1;
  }
  return counts;
};

/**
 * Fixture short IDs are 0 and five hex digits, as in the SQL below. Service-generated readable IDs
 * never contain 0, so they cannot collide with a short ID another test or the service allocates.
 */
const fixtureShortId = (index: number) => `0${index.toString(16).padStart(5, "0")}`;

suite("mail conversation view counts in a large mailbox", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let mailboxId = "";
  let context: MailRequestContext;

  beforeAll(async () => {
    const createUser = async (role: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`mail-counts-${role}-${suffix}`}, 'local', 'user', ${`View counts ${role}`}, false)
        RETURNING id
      `;
      if (!row) throw new Error(`Failed to create the ${role} user`);
      userIds.push(row.id);
      return row.id;
    };
    const readerId = await createUser("reader");
    const formerId = await createUser("former");
    context = {
      actor: {
        kind: "user",
        user: {
          id: readerId,
          uid: `mail-counts-reader-${suffix}`,
          provider: "local",
          profile: "user",
          displayName: "View counts reader",
          givenName: "View",
          sn: "Counts",
          mail: `mail-counts-reader-${suffix}@example.com`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: readerId },
      requestId: `mail-view-counts-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `View counts ${suffix}`, description: "Disposable view counts fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"c".repeat(64)}, 'active')
      RETURNING id
    `;
    const folderIds = {} as Record<Folder, string>;
    for (const [index, folder] of FOLDERS.entries()) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (
          ${fixtureShortId(index)}, ${resource!.id}::uuid, ${`counts-${folder}`}, ${folder},
          ${folder === "spam" ? "other" : folder}, 'current'
        )
        RETURNING id
      `;
      folderIds[folder] = row!.id;
    }
    await sql`
      INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
      VALUES (${mailboxId}::uuid, 'junk', ${folderIds.spam}::uuid)
    `;

    // The same mailbox as foldersOf, isDeleted and the per-conversation rules above, in SQL.
    await sql`
      INSERT INTO mail.message_contents (
        id, short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash,
        hydration_status, plain_text, normalized_subject
      )
      SELECT
        md5(${suffix} || ':message:' || item)::uuid, '0' || lpad(to_hex(item), 5, '0'), ${mailboxId}::uuid,
        '<counts-' || item || '@example.com>', 'Thread ' || (item - 1) * 2 / 5, now() - make_interval(mins => item * 7),
        2048, lpad(to_hex(item), 64, '0'), 'complete', 'Message ' || item, 'thread ' || (item - 1) * 2 / 5
      FROM generate_series(1, ${MESSAGE_COUNT}) AS item
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      SELECT
        md5(${suffix} || ':message:' || item)::uuid, 'from', 0, 'Person ' || item % 700,
        'person' || item % 700 || '@example.com', 'person' || item % 700 || '@example.com'
      FROM generate_series(1, ${MESSAGE_COUNT}) AS item
    `;
    await sql`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      SELECT
        (${folderIds}::jsonb ->> placed.folder)::uuid,
        md5(${suffix} || ':message:' || placed.item)::uuid,
        1,
        row_number() OVER (PARTITION BY placed.folder ORDER BY placed.item)
      FROM (
        SELECT item, CASE
          WHEN (item - 1) * 2 / 5 % 13 = 5 THEN 'trash'
          WHEN (item - 1) * 2 / 5 % 17 = 6 THEN 'spam'
          WHEN item % 20 < 4 THEN 'sent'
          WHEN item % 20 < 12 OR item % 20 = 19 THEN 'inbox'
          WHEN item % 20 < 17 THEN 'archive'
          WHEN item % 20 = 17 THEN 'trash'
          ELSE 'junk'
        END AS folder
        FROM generate_series(1, ${MESSAGE_COUNT}) AS item
        UNION ALL
        SELECT item, 'all'
        FROM generate_series(1, ${MESSAGE_COUNT}) AS item
        WHERE item % 20 = 19 AND (item - 1) * 2 / 5 % 13 <> 5 AND (item - 1) * 2 / 5 % 17 <> 6
      ) placed
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords, deleted_at)
      SELECT ref.id, ref.folder_id, ref.message_id, ARRAY['\\Seen']::text[], ARRAY[]::text[],
        CASE WHEN (item - 1) * 2 / 5 % 23 = 7 OR item % 31 = 0 THEN now() END
      FROM generate_series(1, ${MESSAGE_COUNT}) AS item
      JOIN mail.remote_message_refs ref ON ref.message_id = md5(${suffix} || ':message:' || item)::uuid
    `;
    await sql`
      INSERT INTO mail.conversations (
        id, short_id, mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at,
        work_status, snoozed_until, assignee_user_id
      )
      SELECT
        md5(${suffix} || ':conversation:' || thread.conversation)::uuid, '0' || lpad(to_hex(thread.conversation), 5, '0'),
        ${mailboxId}::uuid, 'Thread ' || thread.conversation, 'Person ' || thread.conversation % 700, thread.latest, thread.latest,
        CASE WHEN thread.conversation % 10 < 6 THEN 'done' WHEN thread.conversation % 10 = 8 THEN 'waiting' ELSE 'needs_action' END,
        CASE thread.conversation % 40 WHEN 9 THEN now() + interval '1 day' WHEN 19 THEN now() - interval '1 hour' END,
        CASE thread.conversation % 3 WHEN 0 THEN ${readerId}::uuid WHEN 1 THEN ${formerId}::uuid END
      FROM (
        SELECT (item - 1) * 2 / 5 AS conversation, max(now() - make_interval(mins => item * 7)) AS latest
        FROM generate_series(1, ${MESSAGE_COUNT}) AS item
        GROUP BY 1
      ) thread
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      SELECT
        md5(${suffix} || ':conversation:' || (item - 1) * 2 / 5)::uuid, md5(${suffix} || ':message:' || item)::uuid,
        ${MESSAGE_COUNT} - item, 'headers'
      FROM generate_series(1, ${MESSAGE_COUNT}) AS item
    `;
    for (const table of ["message_contents", "message_placements", "conversations", "conversation_messages"]) {
      await sql.unsafe(`ANALYZE mail.${table}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      // Only a partial index covers message_placements.message_id, so cascading from each deleted
      // message would scan the whole table; at 100,000 messages that alone took minutes.
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

  test(`counts every view of ${MESSAGE_COUNT.toLocaleString("en-US")} messages within ${BUDGET_MS} ms`, async () => {
    const expected = expectedCounts();
    const durations: number[] = [];
    for (let run = 0; run < 4; run += 1) {
      const startedAt = performance.now();
      const counts = await getConversationViewCounts({ context, mailboxId });
      durations.push(performance.now() - startedAt);
      expect(counts.ok && counts.data).toEqual(expected);
    }
    const warm = durations.slice(1);
    console.info(`Mail ${MESSAGE_COUNT} view counts: ${warm.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(Math.max(...warm)).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
