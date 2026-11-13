import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { newShortId } from "./lib/short-id";
import { migrate } from "./migrate";

const suite = suiteFor("database", "nats");

/** Two one-way Mail migrations share one start: the F6 reply-draft consolidation (marker 4) and the rule retirement
 * (marker 5). Each upgrade path below starts from the schema history a real installation has and checks that neither
 * migration touches a draft the other one owns, in either order, and that a restart changes nothing. */
const released = [
  { version: 1, name: "baseline" },
  { version: 2, name: "principal_assignees" },
  { version: 3, name: "suggestions_per_author" },
  { version: 4, name: "one_reply_draft" },
  { version: 5, name: "rules_retired" },
];
const retirementTriggers = [
  "mail_rules_retired_command",
  "mail_rules_retired_draft",
  "mail_rules_retired_event",
  "mail_rules_retired_outbox",
  "mail_rules_retired_replay",
  "mail_rules_retired_run",
];

type Marker = { version: number; name: string; applied_at: Date; details: unknown };
const markers = () => sql<Marker[]>`SELECT version, name, applied_at, details FROM mail.schema_migrations ORDER BY version`;
const markerNames = async () => (await markers()).map(({ version, name }) => ({ version, name }));
const presentRetirementTriggers = async () =>
  (
    await sql<{ name: string }[]>`SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal
      AND tgname = ANY(${sql.array(retirementTriggers, "TEXT")}) ORDER BY tgname`
  ).map((row) => row.name);
const index = async (name: string) => {
  const [row] = await sql<{ valid: boolean; definition: string }[]>`SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i WHERE i.indexrelid = to_regclass(${`mail.${name}`}::text)`;
  return row ?? null;
};

/** The admission fences an installation has before the rule retirement ran (0.74 and 0.75 alike). */
const removeRetirementFences = async () => {
  await sql`DROP TRIGGER IF EXISTS mail_rules_retired_event ON workflows.event`;
  await sql`DROP TRIGGER IF EXISTS mail_rules_retired_run ON workflows.run`;
  await sql`DROP TRIGGER IF EXISTS mail_rules_retired_replay ON workflows.run`;
  await sql`DROP TRIGGER IF EXISTS mail_rules_retired_command ON mail.commands`;
  await sql`DROP TRIGGER IF EXISTS mail_rules_retired_draft ON mail.drafts`;
  await sql`DROP TRIGGER IF EXISTS mail_rules_retired_outbox ON mail.outbox_submissions`;
};
/** Before F6 several open reply drafts could share a conversation, and per-author suggestion slots existed. */
const removeOneReplyBox = async () => {
  await sql`DROP INDEX IF EXISTS mail.drafts_one_open_reply_idx`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS drafts_untouched_suggestion_author_idx ON mail.drafts (mailbox_id, conversation_id, author_id)
    WHERE state IN ('draft', 'scheduled', 'sending') AND author_kind = 'service_account' AND adopted_at IS NULL
      AND conversation_id IS NOT NULL`.simple();
};

type DraftRow = { id: string; state: string; body_markdown: string; revision: string; consolidated_count: number; origin: string };
const draft = async (id: string) => {
  const [row] = await sql<DraftRow[]>`SELECT id, state, body_markdown, revision::text AS revision, consolidated_count, origin
    FROM mail.drafts WHERE id = ${id}::uuid`;
  if (!row) throw new Error(`Draft ${id} missing`);
  return row;
};

suite("Mail one-way migrations in every upgrade order", () => {
  let mailboxId: string;
  let identityId: string;
  let sequence = 0;

  const conversation = async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Question', 'customer@example.test', '2026-11-01T09:00:00Z') RETURNING id`;
    const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<order-${++sequence}@example.test>`}, 'Question', '2026-11-01T09:00:00Z',
        1, ${sequence.toString(16).padStart(64, "0")}, 'complete', 'Question') RETURNING id`;
    return { conversationId: row!.id, messageId: message!.id };
  };
  /** An open reply draft a person wrote; `editedAt` is the evidence F6 ranks first after committed sends. */
  const personDraft = async (source: { conversationId: string; messageId: string }, body: string, createdAt: string, editedAt?: string) => {
    const author = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, intent, source_message_id, sender_identity_id, author_kind, author_id,
        last_editor_kind, last_editor_id, body_markdown, created_at, updated_at, content_edited_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${source.conversationId}::uuid, 'reply', ${source.messageId}::uuid, ${identityId}::uuid,
        'user', ${author}::uuid, 'user', ${author}::uuid, ${body}, ${createdAt}, ${createdAt}, ${editedAt ?? null}) RETURNING id`;
    return row!.id;
  };
  /** A reply a Mail workflow left for review: user origin, so it lives in the person's reply box. */
  const reviewDraft = async (source: { conversationId: string; messageId: string }, body: string) => {
    const version = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, intent, source_message_id, sender_identity_id, author_kind, author_id,
        last_editor_kind, last_editor_id, origin, body_markdown)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${source.conversationId}::uuid, 'reply', ${source.messageId}::uuid, ${identityId}::uuid,
        'workflow', ${version}::uuid, 'workflow', ${version}::uuid, 'user', ${body}) RETURNING id`;
    return row!.id;
  };
  /** A private automatic reply: workflow origin, outside the reply box; the rule retirement discards it. */
  const automaticReply = async (source: { conversationId: string; messageId: string }, body: string, state = "draft") => {
    const version = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, intent, source_message_id, sender_identity_id, author_kind, author_id,
        last_editor_kind, last_editor_id, origin, delivery_class, state, body_markdown)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${source.conversationId}::uuid, 'reply', ${source.messageId}::uuid, ${identityId}::uuid,
        'workflow', ${version}::uuid, 'workflow', ${version}::uuid, 'workflow', 'automatic_reply', ${state}, ${body}) RETURNING id`;
    return row!.id;
  };
  const openReplies = (conversationId: string) =>
    sql<{ id: string }[]>`SELECT id FROM mail.drafts WHERE conversation_id = ${conversationId}::uuid
      AND origin = 'user' AND intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')`;
  const f6 = async () => (await markers()).find((row) => row.version === 4)?.details;

  const seedMailbox = async () => {
    const [mailbox] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes (short_id, name)
      VALUES (${newShortId()}, 'Migration order') RETURNING id`;
    mailboxId = mailbox!.id;
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Team', 'team@example.test', 'mailbox', 'verified') RETURNING id`;
    identityId = identity!.id;
  };

  beforeAll(async () => {
    await migrate();
  });

  test("a fresh installation records every marker once, completes F6 empty and fences retired rules", async () => {
    // This file runs isolated on its own database clone; start Mail's schema from nothing.
    await sql`DROP SCHEMA mail CASCADE`.simple();
    const result = await migrate();
    expect(result).toEqual({ deletedDrafts: 0, affectedConversations: 0, completed: true });
    expect(await markerNames()).toEqual(released);
    expect(await presentRetirementTriggers()).toEqual(retirementTriggers);
    expect(await index("drafts_one_open_reply_idx")).toMatchObject({ valid: true, definition: expect.stringContaining("UNIQUE") });
    expect(await index("drafts_untouched_suggestion_author_idx")).toBeNull();
    const before = await markers();
    await migrate();
    expect(await markers()).toEqual(before);
    await seedMailbox();
  });

  test("0.74 → this release: F6 consolidates person drafts and the retirement discards only automatic replies", async () => {
    // 0.74: no F6, no retirement, several open reply drafts per conversation.
    await sql`DELETE FROM mail.schema_migrations WHERE version IN (4, 5)`;
    await removeRetirementFences();
    await removeOneReplyBox();
    const shared = await conversation();
    const older = await personDraft(shared, "First thoughts", "2026-11-01T10:00:00Z");
    const edited = await personDraft(shared, "Edited answer", "2026-11-01T11:00:00Z", "2026-11-01T12:00:00Z");
    const automatic = await automaticReply(shared, "We received your message");
    const single = await conversation();
    const review = await reviewDraft(single, "Suggested review reply");
    const reviewBefore = await draft(review);

    const result = await migrate();

    expect(result).toEqual({ deletedDrafts: 1, affectedConversations: 1, completed: true });
    expect(await markerNames()).toEqual(released);
    expect((await openReplies(shared.conversationId)).map((row) => row.id)).toEqual([edited]);
    expect(await draft(edited)).toMatchObject({ state: "draft", body_markdown: "Edited answer", consolidated_count: 1 });
    // F6 erased the loser's content; the lifecycle row stays for audit references.
    expect(await draft(older)).toMatchObject({ state: "discarded", body_markdown: "" });
    // The retirement discarded the automatic reply but F6 never read or erased it.
    expect(await draft(automatic)).toMatchObject({ state: "discarded", body_markdown: "We received your message", origin: "workflow" });
    // A workflow review draft has user origin: F6 keeps it as the only reply, the retirement does not touch it.
    expect(await draft(review)).toEqual(reviewBefore);
    expect(await presentRetirementTriggers()).toEqual(retirementTriggers);
    expect(await index("drafts_one_open_reply_idx")).toMatchObject({ valid: true });
    expect(await index("drafts_untouched_suggestion_author_idx")).toBeNull();

    const settled = await markers();
    const drafts = await Promise.all([older, edited, automatic, review].map(draft));
    await migrate();
    expect(await markers()).toEqual(settled);
    expect(await Promise.all([older, edited, automatic, review].map(draft))).toEqual(drafts);
  });

  test("0.75 → this release: the retirement runs after a completed F6 without changing the reply box", async () => {
    const previous = await f6();
    // 0.75: F6 completed with its unique reply box, no retirement yet.
    await sql`DELETE FROM mail.schema_migrations WHERE version = 5`;
    await removeRetirementFences();
    const first = await conversation();
    const person = await personDraft(first, "Person reply", "2026-11-02T10:00:00Z", "2026-11-02T10:05:00Z");
    const automatic = await automaticReply(first, "Out of office");
    const scheduledAutomatic = await automaticReply(first, "Scheduled acknowledgement", "scheduled");
    const second = await conversation();
    const review = await reviewDraft(second, "Workflow review reply");
    const untouched = await Promise.all([person, review].map(draft));

    const result = await migrate();

    expect(result).toEqual(previous as typeof result);
    expect(await f6()).toEqual(previous);
    expect(await markerNames()).toEqual(released);
    expect(await Promise.all([person, review].map(draft))).toEqual(untouched);
    expect(await draft(automatic)).toMatchObject({ state: "discarded", body_markdown: "Out of office" });
    expect(await draft(scheduledAutomatic)).toMatchObject({ state: "discarded", body_markdown: "Scheduled acknowledgement" });
    expect(await presentRetirementTriggers()).toEqual(retirementTriggers);
    await expect(Promise.resolve(automaticReply(first, "Too late"))).rejects.toThrow("Automatic replies are retired");

    const settled = await markers();
    await migrate();
    expect(await markers()).toEqual(settled);
  });

  test("an earlier Code-branch database: markers move to the released numbers and F6 then runs once", async () => {
    // Earlier Code-branch images ran the retirement (marker 3) and moved suggestions to 4; F6 never ran.
    const retiredAt = new Date("2026-11-05T08:00:00Z");
    const suggestionsAt = new Date("2026-11-04T08:00:00Z");
    await sql`DELETE FROM mail.schema_migrations WHERE version IN (3, 4, 5)`;
    await sql`INSERT INTO mail.schema_migrations (version, name, applied_at)
      VALUES (3, 'rules_retired', ${retiredAt}), (4, 'suggestions_per_author', ${suggestionsAt})`;
    await removeOneReplyBox();
    const shared = await conversation();
    const older = await personDraft(shared, "Old draft", "2026-11-03T10:00:00Z");
    const edited = await personDraft(shared, "Final draft", "2026-11-03T11:00:00Z", "2026-11-03T11:30:00Z");
    const retiredReply = await automaticReply(shared, "Retired acknowledgement", "discarded");

    const result = await migrate();

    expect(result).toEqual({ deletedDrafts: 1, affectedConversations: 1, completed: true });
    const after = await markers();
    expect(after.map(({ version, name }) => ({ version, name }))).toEqual(released);
    // The moves keep the original timestamps, so the retirement did not run a second time.
    expect(after.find((row) => row.name === "rules_retired")?.applied_at).toEqual(retiredAt);
    expect(after.find((row) => row.name === "suggestions_per_author")?.applied_at).toEqual(suggestionsAt);
    expect((await openReplies(shared.conversationId)).map((row) => row.id)).toEqual([edited]);
    expect(await draft(older)).toMatchObject({ state: "discarded", body_markdown: "" });
    expect(await draft(retiredReply)).toMatchObject({ state: "discarded", body_markdown: "Retired acknowledgement" });

    await migrate();
    expect(await markers()).toEqual(after);
  });
});
