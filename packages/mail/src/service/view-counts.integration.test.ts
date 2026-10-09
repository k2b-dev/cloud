import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { type ConversationViewCounts, getConversationViewCounts } from "./messages";

const suite = suiteFor("database", "nats");

// At 25,000 messages PostgreSQL estimates the counts at about 680,000 cost units, above the 500,000
// at which it inlines and optimizes a query with JIT, so the budget below fails both when the
// counts go back to the old per-view query and when the read stops turning JIT off. At 5,000
// messages the estimate stays below that threshold and dropping `SET LOCAL jit = off` went unseen.
// The opt-in performance run measures the same mailbox at up to 100,000 messages.
const DEFAULT_MESSAGE_COUNT = 25_000;
const requestedMessageCount = Number.parseInt(process.env.MAIL_PERFORMANCE_MESSAGE_COUNT ?? "", 10);
const MESSAGE_COUNT =
  process.env.MAIL_PERFORMANCE_TESTS === "1" && Number.isFinite(requestedMessageCount)
    ? Math.min(Math.max(requestedMessageCount, DEFAULT_MESSAGE_COUNT), 100_000)
    : DEFAULT_MESSAGE_COUNT;
// Warm counts take about 100 to 150 ms at 20,000 to 30,000 messages on PostgreSQL 15 and 17, and
// 340 ms at 100,000 on PostgreSQL 15. With JIT they took 1.0 to 1.6 s at 20,000 and 30,000 messages,
// and the old query about 5 s. The median of the warm runs keeps one stall on a busy host from
// failing the budget.
const BUDGET_MS = 500;
const WARM_RUNS = 5;

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
type WorkStatus = "needs_action" | "waiting" | "done";
const workStatusOf = (conversation: number): WorkStatus =>
  conversation % 10 < 6 ? "done" : conversation % 10 === 8 ? "waiting" : "needs_action";
/** Snoozed until tomorrow (open, Waiting or Done), or a snooze that already ran out (open or Waiting). */
const snoozeOf = (conversation: number) => {
  const slot = conversation % 40;
  if (slot === 9 || slot === 18 || slot === 21) return "future";
  if (slot === 19 || slot === 28) return "past";
  return null;
};
/** The reader, a former teammate without access, or nobody. */
const assigneeOf = (conversation: number) => (conversation % 3 === 0 ? "reader" : conversation % 3 === 1 ? "former" : null);

type OutboxState = "undo_window" | "scheduled" | "sending" | "sent" | "failed" | "unknown" | "needs_attention" | "cancelled";
type CaseMessage = { folder?: Folder; deleted?: true; outbox?: OutboxState; sendError?: string };
/**
 * Conversations with outgoing mail, added to the same mailbox, each with the views it counts in.
 * None has an assignee or a snooze, so an open one also counts as unassigned.
 */
const OUTBOX_CASES: { status: WorkStatus; messages: CaseMessage[]; views: (keyof ConversationViewCounts)[] }[] = [
  // A reply on its way out that the provider holds no copy of yet.
  { status: "needs_action", messages: [{ outbox: "sending" }], views: ["recently_active", "needs_action", "unassigned"] },
  // A reply in its undo window whose only copy was deleted in another mail program.
  {
    status: "needs_action",
    messages: [{ folder: "inbox", deleted: true, outbox: "undo_window" }],
    views: ["recently_active", "needs_action", "unassigned"],
  },
  // A reply scheduled for later is on its way out, but not a send problem.
  { status: "waiting", messages: [{ outbox: "scheduled" }], views: ["recently_active", "waiting", "unassigned"] },
  // A failed reply, alone in its conversation.
  {
    status: "waiting",
    messages: [{ outbox: "failed", sendError: "SMTP_REJECTED" }],
    views: ["recently_active", "waiting", "unassigned", "send_problems"],
  },
  // A reply waiting for a retry after an error keeps a conversation whose question is in Trash in follow-up.
  {
    status: "needs_action",
    messages: [{ folder: "trash" }, { outbox: "scheduled", sendError: "SMTP_TEMPORARY" }],
    views: ["recently_active", "needs_action", "unassigned", "send_problems"],
  },
  // A filed reply whose send needs attention.
  {
    status: "needs_action",
    messages: [{ folder: "sent", outbox: "needs_attention" }],
    views: ["recently_active", "needs_action", "unassigned", "send_problems"],
  },
  // A send with an unknown outcome in a Done conversation.
  { status: "done", messages: [{ folder: "inbox" }, { outbox: "unknown" }], views: ["recently_active", "done", "send_problems"] },
  // A sent reply whose only copy is in Trash leaves follow-up like any mail in Trash.
  { status: "needs_action", messages: [{ folder: "trash", outbox: "sent" }], views: ["recently_active"] },
  // A cancelled reply is not on its way out, so the question in Junk keeps the conversation out of follow-up.
  { status: "needs_action", messages: [{ folder: "junk" }, { outbox: "cancelled" }], views: ["recently_active"] },
  // A cancelled reply alone does not make its conversation visible.
  { status: "needs_action", messages: [{ outbox: "cancelled" }], views: [] },
];

/** Sent, Trash, Junk (and Spam, mapped to Junk) and All Mail never decide where mail appears. */
const DISPLAY_NEUTRAL: ReadonlySet<Folder> = new Set(["sent", "trash", "junk", "spam", "all"]);

/** The counts while `keptInside` keeps its mail inside the folder, or while every folder shows it everywhere. */
const expectedCounts = (keptInside?: Folder): ConversationViewCounts => {
  const evidence = new Map<number, { visible: boolean; followUp: boolean; isolated: boolean; counted: boolean }>();
  for (let item = 1; item <= MESSAGE_COUNT; item += 1) {
    const conversation = conversationOf(item);
    const state = evidence.get(conversation) ?? { visible: false, followUp: false, isolated: false, counted: false };
    if (!isDeleted(item)) {
      state.visible = true;
      if (foldersOf(item).some((folder) => !HIDDEN_FROM_FOLLOW_UP.has(folder))) state.followUp = true;
      if (foldersOf(item).some((folder) => folder === keptInside)) state.isolated = true;
      if (foldersOf(item).some((folder) => folder !== keptInside && !DISPLAY_NEUTRAL.has(folder))) state.counted = true;
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
    kept: 0,
  };
  for (const [conversation, state] of evidence) {
    if (!state.visible) continue;
    const status = workStatusOf(conversation);
    const snoozed = snoozeOf(conversation) === "future";
    // Assigned to me keeps conversations whose mail stays inside its folder; the other views leave them out.
    const shown = !state.isolated || state.counted;
    if (shown) counts.recently_active += 1;
    if (shown && status === "done") counts.done += 1;
    if (!state.followUp) continue;
    if (snoozed) {
      if (shown) counts.snoozed += 1;
      continue;
    }
    if (shown && status === "needs_action") counts.needs_action += 1;
    if (shown && status === "waiting") counts.waiting += 1;
    if (status !== "done" && assigneeOf(conversation) === "reader") counts.mine += 1;
    if (shown && status !== "done" && assigneeOf(conversation) !== "reader") counts.unassigned += 1;
  }
  for (const outboxCase of OUTBOX_CASES) {
    for (const view of outboxCase.views) counts[view] += 1;
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
  const folderIds = {} as Record<Folder, string>;

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
        CASE
          WHEN thread.conversation % 40 IN (9, 18, 21) THEN now() + interval '1 day'
          WHEN thread.conversation % 40 IN (19, 28) THEN now() - interval '1 hour'
        END,
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

    // The outbox cases, with what a send refers to. Their short IDs start above every bulk index.
    let nextCaseIndex = 0x80000;
    const caseShortId = () => fixtureShortId(nextCaseIndex++);
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret
      ) VALUES (
        ${mailboxId}::uuid, 'IMAP', 'team@example.com', 'team@example.com',
        'imap.example.com', 993, 'implicit', 'smtp.example.com', 587, 'starttls', 'password', 'fixture'
      ) RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
      VALUES (${resource!.id}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb)
      RETURNING id
    `;
    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
      VALUES (${caseShortId()}, ${mailboxId}::uuid, 'team@example.com', 'Team')
      RETURNING id
    `;
    const [draft] = await sql<{ id: string }[]>`
      INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, state)
      VALUES (${caseShortId()}, ${mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${readerId}::uuid, 'user', ${readerId}::uuid, 'sent')
      RETURNING id
    `;
    let caseUid = 0;
    for (const [caseIndex, outboxCase] of OUTBOX_CASES.entries()) {
      const [conversation] = await sql<{ id: string }[]>`
        INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
        VALUES (${caseShortId()}, ${mailboxId}::uuid, ${`Outbox case ${caseIndex}`}, 'Team', now(), ${outboxCase.status})
        RETURNING id
      `;
      for (const [position, message] of outboxCase.messages.entries()) {
        const key = `outbox-case-${caseIndex}-${position}`;
        const [content] = await sql<{ id: string }[]>`
          INSERT INTO mail.message_contents (
            short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash,
            hydration_status, plain_text, normalized_subject
          ) VALUES (
            ${caseShortId()}, ${mailboxId}::uuid, ${`<${key}@example.com>`}, ${`Outbox case ${caseIndex}`}, now(), 512,
            ${`e${String(caseIndex * 10 + position).padStart(63, "0")}`}, 'complete', ${key}, ${`outbox case ${caseIndex}`}
          ) RETURNING id
        `;
        await sql`
          INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
          VALUES (${conversation!.id}::uuid, ${content!.id}::uuid, ${position}, 'headers')
        `;
        if (message.folder) {
          caseUid += 1;
          const [ref] = await sql<{ id: string }[]>`
            INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
            VALUES (${folderIds[message.folder]}::uuid, ${content!.id}::uuid, 2, ${caseUid})
            RETURNING id
          `;
          await sql`
            INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords, deleted_at)
            VALUES (
              ${ref!.id}::uuid, ${folderIds[message.folder]}::uuid, ${content!.id}::uuid, ARRAY['\\Seen']::text[], ARRAY[]::text[],
              CASE WHEN ${message.deleted === true} THEN now() END
            )
          `;
        }
        if (message.outbox) {
          const [command] = await sql<{ id: string }[]>`
            INSERT INTO mail.commands (
              mailbox_id, kind, actor_kind, actor_id, idempotency_key, request_hash, target, payload,
              access_subject_kind, access_subject_id, credential_scopes
            ) VALUES (
              ${mailboxId}::uuid, 'send', 'user', ${readerId}::uuid, ${`send-${key}`}, ${"f".repeat(64)},
              '{}'::jsonb, '{}'::jsonb, 'user', ${readerId}::uuid, ARRAY[]::text[]
            ) RETURNING id
          `;
          await sql`
            INSERT INTO mail.outbox_submissions (
              short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id,
              stable_message_id, state, last_error_code, mime_date, message_id
            ) VALUES (
              ${caseShortId()}, ${mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${identity!.id}::uuid,
              ${binding!.id}::uuid, ${`<${key}@example.com>`}, ${message.outbox}, ${message.sendError ?? null}, now(), ${content!.id}::uuid
            )
          `;
        }
      }
    }

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
    for (let run = 0; run <= WARM_RUNS; run += 1) {
      const startedAt = performance.now();
      const counts = await getConversationViewCounts({ context, mailboxId });
      durations.push(performance.now() - startedAt);
      expect(counts.ok && counts.data).toEqual(expected);
    }
    const warm = durations.slice(1);
    console.info(`Mail ${MESSAGE_COUNT} view counts: ${warm.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(warm.toSorted((left, right) => left - right)[Math.floor(WARM_RUNS / 2)]).toBeLessThan(BUDGET_MS);
  }, 120_000);

  test(`counts every view within ${BUDGET_MS} ms while a folder keeps its mail inside`, async () => {
    await sql`UPDATE mail.folders SET display = 'folder_only' WHERE id = ${folderIds.archive}::uuid`;
    try {
      const expected = expectedCounts("archive");
      expect(expected.needs_action).toBeLessThan(expectedCounts().needs_action);
      const durations: number[] = [];
      for (let run = 0; run <= WARM_RUNS; run += 1) {
        const startedAt = performance.now();
        const counts = await getConversationViewCounts({ context, mailboxId });
        durations.push(performance.now() - startedAt);
        expect(counts.ok && counts.data).toEqual(expected);
      }
      const warm = durations.slice(1);
      console.info(`Mail ${MESSAGE_COUNT} view counts with a folder kept inside: ${warm.map((value) => value.toFixed(1)).join(", ")} ms`);
      expect(warm.toSorted((left, right) => left - right)[Math.floor(WARM_RUNS / 2)]).toBeLessThan(BUDGET_MS);
    } finally {
      await sql`UPDATE mail.folders SET display = 'everywhere' WHERE id = ${folderIds.archive}::uuid`;
    }
  }, 120_000);
});
