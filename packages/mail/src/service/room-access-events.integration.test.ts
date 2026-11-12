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
    "sender changed",
    "template changed",
  ])
    test(`${source} commits a live access hint in the same transaction`, async () => {
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
          const sender = crypto.randomUUID(),
            draft = crypto.randomUUID(),
            template = crypto.randomUUID();
          await tx`INSERT INTO mail.sender_identities(id, short_id, mailbox_id, label, display_name, from_address, status)
            VALUES (${sender}::uuid, ${testShortId()}, ${mailbox}::uuid, 'Sender', 'Sender', 'sender@example.test', 'verified')`;
          await tx`INSERT INTO mail.drafts(id, short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, edit_mode)
            VALUES (${draft}::uuid, ${testShortId()}, ${mailbox}::uuid, ${sender}::uuid, 'user', ${user}::uuid, 'user', ${user}::uuid, 'shared')`;
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
          if (source === "sender changed") await tx`UPDATE mail.sender_identities SET status = 'unverified' WHERE id = ${sender}::uuid`;
          if (source === "template changed") await tx`UPDATE mail.compose_templates SET archived_at = now() WHERE id = ${template}::uuid`;
          const hints = () =>
            tx<
              { payload: { k: string; a?: boolean } }[]
            >`SELECT payload FROM events.outbox WHERE app_id = 'mail' AND payload->>'a' = 'true'`;
          expect((await hints()).some((row) => row.payload.k === mailbox)).toBe(true);
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
});
