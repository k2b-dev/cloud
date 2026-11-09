import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { accounts } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { listConversationDraftSummaries } from "./conversation-draft-summaries";
import { listConversationDrafts } from "./drafts";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");
const at = "2026-10-20T06:00:00.000Z";

suite("conversation list draft summaries", () => {
  const users: string[] = [];
  let accountId = "";
  let mailboxId = "";
  let owner: MailRequestContext;
  let assigned: MailRequestContext;
  let identityId = "";
  const conversations: string[] = [];
  const messages: string[] = [];
  const context = async (name: string): Promise<MailRequestContext> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`draft-summary-${newShortId()}`}, 'local', 'user', ${name}) RETURNING id`;
    if (!row) throw new Error("Missing summary user");
    users.push(row.id);
    const user = await accounts.users.get({ id: row.id });
    if (!user) throw new Error("Missing summary principal");
    return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
  };
  beforeAll(async () => {
    owner = await context("Owner");
    assigned = await context("Assigned");
    await context("Third");
    await context("Fourth");
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES ('Draft assistant', 'standalone') RETURNING id`;
    accountId = account!.id;
    mailboxId = unwrap(await createMailbox(owner, { name: `Summaries ${newShortId()}` })).id;
    unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId,
        principal: { type: "user", userId: users[1]! },
        permission: "read",
        scope: "assigned",
      }),
    );
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, from_address, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Sender', 'sender@example.test', 'verified') RETURNING id`;
    identityId = identity!.id;
    for (let i = 0; i < 2; i++) {
      const [conversation] = await sql<{ id: string }[]>`INSERT INTO mail.conversations (short_id, mailbox_id, subject, latest_message_at)
        VALUES (${newShortId()}, ${mailboxId}::uuid, 'Summary fixture', ${at}) RETURNING id`;
      const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${newShortId()}@example.test>`}, 'Original', ${at}, 1, ${String(i).repeat(64)}, 'complete') RETURNING id`;
      conversations.push(conversation!.id);
      messages.push(message!.id);
      await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
        VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 0)`;
    }
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id)
      VALUES (${conversations[0]}::uuid, ${users[1]}::uuid)`;
    // Creator and last editor can differ; repeated contributors count once.
    for (let i = 0; i < 4; i++) {
      const date = new Date(Date.parse(at) + i * 1000);
      await sql`INSERT INTO mail.drafts
        (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id,
          author_kind, author_id, last_editor_kind, last_editor_id, created_at, updated_at)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${conversations[0]}::uuid, ${messages[0]}::uuid, 'reply', ${identityId}::uuid,
          'user', ${users[i]}::uuid, ${i === 3 ? "service_account" : "user"}, ${i === 3 ? accountId : users[i]}::uuid, ${date}, ${date})`;
    }
    // Visible conversation, hidden source: apply the complete draft visibility predicate.
    await sql`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${conversations[0]}::uuid, ${messages[1]}::uuid, 'reply', ${identityId}::uuid,
        'user', ${users[0]}::uuid, 'user', ${users[0]}::uuid, ${at}, ${at})`;
    await sql`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${conversations[1]}::uuid, ${messages[1]}::uuid, 'reply', ${identityId}::uuid,
        'user', ${users[0]}::uuid, 'user', ${users[0]}::uuid)`;
    for (const state of ["sent", "sending", "scheduled", "discarded"]) {
      await sql`INSERT INTO mail.drafts (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id,
        author_kind, author_id, last_editor_kind, last_editor_id, state)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${conversations[0]}::uuid, ${messages[0]}::uuid, 'reply', ${identityId}::uuid,
          'user', ${users[0]}::uuid, 'user', ${users[0]}::uuid, ${state})`;
    }
    // Workflow drafts cannot exist: the retired-rules trigger rejects open workflow and automatic-reply drafts.
  });
  afterAll(async () => {
    if (mailboxId) {
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
        UNION SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${grants.map((g) => g.access_id)}::jsonb))`;
    }
    if (accountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${users}::jsonb))`;
  });

  test("counts only open user drafts and caps distinct contributors at three, newest first", async () => {
    const summaries = unwrap(await listConversationDraftSummaries({ context: owner, mailboxId, conversationIds: conversations }));
    const summary = summaries.get(conversations[0]!);
    expect(summary?.count).toBe(5);
    expect(summary?.editors).toEqual([
      { kind: "service_account", id: accountId, displayName: "Draft assistant" },
      { kind: "user", id: users[3]!, displayName: "Fourth" },
      { kind: "user", id: users[2]!, displayName: "Third" },
    ]);
    expect(summaries.get(conversations[1]!)?.count).toBe(1);
  });

  test("assigned counts match the conversation draft list, including source visibility", async () => {
    const summaries = unwrap(
      await listConversationDraftSummaries({ context: assigned, mailboxId, conversationIds: [...conversations, conversations[0]!] }),
    );
    const drafts = unwrap(await listConversationDrafts({ context: assigned, mailboxId, conversationId: conversations[0]! }));
    expect(summaries.get(conversations[0]!)?.count).toBe(4);
    expect(summaries.get(conversations[0]!)?.count).toBe(drafts.length);
    expect(summaries.has(conversations[1]!)).toBe(false);
    expect(unwrap(await listConversationDraftSummaries({ context: assigned, mailboxId, conversationIds: [] })).size).toBe(0);
  });
});
