import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";

suiteFor("database", "nats")("Mail room access invalidations", () => {
  beforeAll(migrate);
  for (const source of [
    "mailbox grant",
    "assigned-only grant",
    "conversation assignment",
    "mailbox soft deletion",
    "mailbox deletion",
    "mailbox sync disabled",
    "draft sent",
    "draft discarded",
    "draft retired",
    "draft conversation changed",
    "conversation deletion",
    "message moved",
    "message unlinked",
    "sender changed",
    "template changed",
    "sender metadata",
    "sender unchanged",
    "template metadata",
    "template unchanged",
    "message position",
    "message unchanged",
    "message unrelated moved",
    "message unrelated unlinked",
  ])
    test(`${source} ${/metadata|unchanged|position|unrelated/.test(source) ? "does not enqueue" : "commits"} a live access hint`, async () => {
      await sql
        .begin(async (tx) => {
          const user = crypto.randomUUID(),
            mailbox = crypto.randomUUID(),
            conversation = crypto.randomUUID(),
            access = crypto.randomUUID();
          await tx`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${user}::uuid, ${user}, 'local', 'user')`;
          await tx`INSERT INTO auth.access(id, user_id, permission) VALUES (${access}::uuid, ${user}::uuid, 'write')`;
          await tx`INSERT INTO mail.mailboxes(id, short_id, name) VALUES (${mailbox}::uuid, ${testShortId()}, 'Room source')`;
          await tx`INSERT INTO mail.conversations(id, short_id, mailbox_id, latest_message_at) VALUES (${conversation}::uuid, ${testShortId()}, ${mailbox}::uuid, '2026-11-12T12:00:00Z')`;
          const targetConversation = crypto.randomUUID(),
            message = crypto.randomUUID();
          await tx`INSERT INTO mail.conversations(id, short_id, mailbox_id, latest_message_at) VALUES (${targetConversation}::uuid, ${testShortId()}, ${mailbox}::uuid, '2026-11-12T12:00:00Z')`;
          if (source.startsWith("message") || source === "draft conversation changed") {
            await tx`INSERT INTO mail.message_contents(id, short_id, mailbox_id, message_id, internal_date, size_bytes, content_hash, hydration_status)
              VALUES (${message}::uuid, ${testShortId()}, ${mailbox}::uuid, ${`<${message}@example.test>`}, '2026-11-12T12:00:00Z', 1, ${"a".repeat(64)}, 'complete')`;
            await tx`INSERT INTO mail.conversation_messages(conversation_id, message_id, position) VALUES (${conversation}::uuid, ${message}::uuid, 0)`;
          }
          const sender = crypto.randomUUID(),
            draft = crypto.randomUUID(),
            template = crypto.randomUUID();
          await tx`INSERT INTO mail.sender_identities(id, short_id, mailbox_id, label, display_name, from_address, status)
            VALUES (${sender}::uuid, ${testShortId()}, ${mailbox}::uuid, 'Sender', 'Sender', 'sender@example.test', 'verified')`;
          await tx`INSERT INTO mail.drafts(id, short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, edit_mode)
            VALUES (${draft}::uuid, ${testShortId()}, ${mailbox}::uuid, ${sender}::uuid, 'user', ${user}::uuid, 'user', ${user}::uuid, 'shared')`;
          if (source.startsWith("message") && !source.includes("unrelated"))
            await tx`UPDATE mail.drafts SET intent = 'reply', source_message_id = ${message}::uuid,
              conversation_id = ${conversation}::uuid WHERE id = ${draft}::uuid`;
          await tx`INSERT INTO mail.compose_templates(id, short_id, mailbox_id, name, normalized_name, shortcut, kind, scope, body_template, created_by_actor_kind, created_by_actor_id)
            VALUES (${template}::uuid, ${testShortId()}, ${mailbox}::uuid, 'Template', 'template', 'template', 'signature', 'mailbox', 'Signature', 'user', ${user}::uuid)`;
          await tx`DELETE FROM events.outbox WHERE app_id = 'mail'`;
          if (source === "mailbox grant")
            await tx`INSERT INTO mail.mailbox_access(mailbox_id, access_id) VALUES (${mailbox}::uuid, ${access}::uuid)`;
          if (source === "assigned-only grant")
            await tx`INSERT INTO mail.mailbox_assigned_access(mailbox_id, access_id) VALUES (${mailbox}::uuid, ${access}::uuid)`;
          if (source === "conversation assignment")
            await tx`INSERT INTO mail.conversation_assignees(conversation_id, user_id) VALUES (${conversation}::uuid, ${user}::uuid)`;
          if (source === "mailbox soft deletion") await tx`UPDATE mail.mailboxes SET deleted_at = now() WHERE id = ${mailbox}::uuid`;
          if (source === "mailbox deletion") await tx`DELETE FROM mail.mailboxes WHERE id = ${mailbox}::uuid`;
          if (source === "mailbox sync disabled") await tx`UPDATE mail.mailboxes SET sync_enabled = false WHERE id = ${mailbox}::uuid`;
          if (source === "draft sent") await tx`UPDATE mail.drafts SET state = 'sent' WHERE id = ${draft}::uuid`;
          if (source === "draft discarded") await tx`UPDATE mail.drafts SET state = 'discarded' WHERE id = ${draft}::uuid`;
          if (source === "draft retired") await tx`UPDATE mail.drafts SET doc_generation = doc_generation + 1 WHERE id = ${draft}::uuid`;
          if (source === "draft conversation changed")
            await tx`UPDATE mail.drafts SET intent = 'reply', source_message_id = ${message}::uuid,
              conversation_id = ${targetConversation}::uuid WHERE id = ${draft}::uuid`;
          if (source === "conversation deletion") await tx`DELETE FROM mail.conversations WHERE id = ${conversation}::uuid`;
          if (source === "message moved")
            await tx`UPDATE mail.conversation_messages SET conversation_id = ${targetConversation}::uuid WHERE message_id = ${message}::uuid`;
          if (source === "message unlinked") await tx`DELETE FROM mail.conversation_messages WHERE message_id = ${message}::uuid`;
          if (source === "sender changed") await tx`UPDATE mail.sender_identities SET status = 'unverified' WHERE id = ${sender}::uuid`;
          if (source === "template changed") await tx`UPDATE mail.compose_templates SET archived_at = now() WHERE id = ${template}::uuid`;
          if (source === "sender metadata")
            await tx`UPDATE mail.sender_identities SET label = 'Renamed sender', updated_at = now() WHERE id = ${sender}::uuid`;
          if (source === "sender unchanged") await tx`UPDATE mail.sender_identities SET status = status WHERE id = ${sender}::uuid`;
          if (source === "template metadata")
            await tx`UPDATE mail.compose_templates SET body_template = 'Updated signature', name = 'Renamed' WHERE id = ${template}::uuid`;
          if (source === "template unchanged")
            await tx`UPDATE mail.compose_templates SET archived_at = archived_at, scope = scope WHERE id = ${template}::uuid`;
          if (source === "message position")
            await tx`UPDATE mail.conversation_messages SET position = 1 WHERE message_id = ${message}::uuid`;
          if (source === "message unchanged")
            await tx`UPDATE mail.conversation_messages SET conversation_id = conversation_id, message_id = message_id WHERE message_id = ${message}::uuid`;
          if (source === "message unrelated moved")
            await tx`UPDATE mail.conversation_messages SET conversation_id = ${targetConversation}::uuid WHERE message_id = ${message}::uuid`;
          if (source === "message unrelated unlinked") await tx`DELETE FROM mail.conversation_messages WHERE message_id = ${message}::uuid`;
          const hints = () =>
            tx<
              { payload: { k: string; a?: boolean } }[]
            >`SELECT payload FROM events.outbox WHERE app_id = 'mail' AND payload->>'a' = 'true'`;
          expect((await hints()).some((row) => row.payload.k === mailbox)).toBe(!/metadata|unchanged|position|unrelated/.test(source));
          if (source.endsWith("grant")) {
            await tx`DELETE FROM events.outbox WHERE app_id = 'mail'`;
            if (source === "mailbox grant") await tx`DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailbox}::uuid`;
            else await tx`DELETE FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailbox}::uuid`;
            expect((await hints()).some((row) => row.payload.k === mailbox)).toBe(true);
          }
          throw new Error("fixture rollback");
        })
        .catch((error) => {
          if (!(error instanceof Error) || error.message !== "fixture rollback") throw error;
        });
      expect(await sql`SELECT id FROM events.outbox WHERE app_id = 'mail'`).toHaveLength(0);
    });
  for (const deletion of ["unlink", "cascade"] as const)
    test(`bulk ${deletion} coalesces source and derived shared-draft hints across mailboxes`, async () => {
      await sql
        .begin(async (tx) => {
          const mailboxes = Array.from({ length: 4 }, () => crypto.randomUUID());
          const senders = mailboxes.map(() => crypto.randomUUID());
          const conversations = mailboxes.map(() => crypto.randomUUID());
          for (const [index, mailbox] of mailboxes.entries()) {
            await tx`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${mailbox}::uuid, ${testShortId()}, 'Bulk room access')`;
            await tx`INSERT INTO mail.sender_identities (id, short_id, mailbox_id, label, display_name, from_address, status)
            VALUES (${senders[index]}::uuid, ${testShortId()}, ${mailbox}::uuid, 'Sender', 'Sender', 'sender@example.test', 'verified')`;
            await tx`INSERT INTO mail.conversations (id, short_id, mailbox_id, latest_message_at)
            VALUES (${conversations[index]}::uuid, ${testShortId()}, ${mailbox}::uuid, '2026-11-13T12:00:00Z')`;
          }
          const messages = [crypto.randomUUID(), crypto.randomUUID()];
          for (const [index, message] of messages.entries()) {
            await tx`INSERT INTO mail.message_contents (id, short_id, mailbox_id, message_id, internal_date, content_hash)
            VALUES (${message}::uuid, ${testShortId()}, ${mailboxes[0]}::uuid, ${`<${message}@example.test>`},
              '2026-11-13T12:00:00Z', ${String(index).repeat(64)})`;
            await tx`INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
            VALUES (${conversations[0]}::uuid, ${message}::uuid, ${index})`;
            // Two derived drafts in one mailbox must still produce just one coalesced hint.
            await tx`INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind,
            edit_mode, derived_from_message_id, derivation_kind, derivation_key, derivation_request_hash)
            VALUES (${testShortId()}, ${mailboxes[2]}::uuid, ${senders[2]}::uuid, 'system', 'system',
              'shared', ${message}::uuid, 'edit_as_new', ${crypto.randomUUID()}::uuid, ${"a".repeat(64)})`;
          }
          await tx`INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind,
          edit_mode, intent, conversation_id, source_message_id)
          VALUES (${testShortId()}, ${mailboxes[1]}::uuid, ${senders[1]}::uuid, 'system', 'system',
            'shared', 'reply', ${conversations[1]}::uuid, ${messages[0]}::uuid)`;
          // Neither a private open draft nor a discarded shared draft grants a room writer.
          for (const [mode, state] of [
            ["lock", "draft"],
            ["shared", "discarded"],
          ] as const)
            await tx`INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind,
            edit_mode, state, derived_from_message_id, derivation_kind, derivation_key, derivation_request_hash)
            VALUES (${testShortId()}, ${mailboxes[3]}::uuid, ${senders[3]}::uuid, 'system', 'system',
              ${mode}, ${state}, ${messages[0]}::uuid, 'edit_as_new', ${crypto.randomUUID()}::uuid, ${"a".repeat(64)})`;
          await tx`DELETE FROM events.outbox WHERE app_id = 'mail'`;
          if (deletion === "unlink") await tx`DELETE FROM mail.conversation_messages WHERE conversation_id = ${conversations[0]}::uuid`;
          else await tx`DELETE FROM mail.conversations WHERE id = ${conversations[0]}::uuid`;
          const hints = await tx<{ payload: { v: number; k: string; a: boolean }; coalesce_key: string }[]>`
          SELECT payload, coalesce_key FROM events.outbox WHERE app_id = 'mail' AND payload->>'a' = 'true'`;
          const expected = deletion === "cascade" ? mailboxes.slice(0, 3) : mailboxes.slice(1, 3);
          expect(hints.map((hint) => hint.payload.k).sort()).toEqual(expected.sort());
          for (const hint of hints) {
            expect(hint.payload).toEqual({ v: 1, k: hint.payload.k, a: true });
            expect(hint.coalesce_key).toEndWith(`:room.access:${hint.payload.k}`);
          }
          throw new Error("fixture rollback");
        })
        .catch((error) => {
          if (!(error instanceof Error) || error.message !== "fixture rollback") throw error;
        });
    });
});
