import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { executeOperatorAction } from "./operator-actions";

const mailbox = "00003267-0000-4000-8000-000000000001";
const sender = "00003267-0000-4000-8000-000000000002";
const projectionDraft = "00003267-0000-4000-8000-000000000003";

suiteFor(
  "database",
  "nats",
  "valkey",
)("Mail bulk room access", () => {
  beforeAll(async () => {
    await migrate();
    await sql`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${mailbox}::uuid, 'p00000', 'Bulk deletion')`;
    await sql`INSERT INTO mail.sender_identities (id, short_id, mailbox_id, label, display_name, from_address, status)
      VALUES (${sender}::uuid, 'p00000', ${mailbox}::uuid, 'Sender', 'Sender', 'sender@example.test', 'verified')`;
    await sql`INSERT INTO mail.drafts (id, short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind)
      VALUES (${projectionDraft}::uuid, 'p00000', ${mailbox}::uuid, ${sender}::uuid, 'system', 'system')`;
    // Most drafts belong to other mailboxes; only twelve are shared and open.
    await sql`INSERT INTO mail.mailboxes (id, short_id, name)
      SELECT ('00003267-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
        'q' || lpad(to_hex(item), 5, '0'), 'Other mailbox ' || item FROM generate_series(10, 13) item`;
    await sql`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, status)
      SELECT short_id, id, 'Sender', 'Sender', 'sender@example.test', 'verified'
      FROM mail.mailboxes WHERE id <> ${mailbox}::uuid`;
    await sql`INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind, edit_mode)
      SELECT 'q' || lpad(to_hex(item), 5, '0'), identity.mailbox_id, identity.id, 'system', 'system',
        CASE WHEN item <= 12 THEN 'shared' ELSE 'lock' END
      FROM generate_series(1, 30000) item
      JOIN mail.sender_identities identity
        ON identity.mailbox_id = ('00003267-0000-4000-8000-' || lpad((10 + item % 4)::text, 12, '0'))::uuid`;
    await sql`INSERT INTO mail.message_contents (id, short_id, mailbox_id, message_id, internal_date, content_hash)
      SELECT id, short_id, id, '<control-' || short_id || '@example.test>', '2026-11-13T12:00:00Z', repeat('f', 64)
      FROM mail.mailboxes WHERE id <> ${mailbox}::uuid`;
    await sql`INSERT INTO mail.conversations (id, short_id, mailbox_id, latest_message_at)
      SELECT id, short_id, id, '2026-11-13T12:00:00Z' FROM mail.mailboxes WHERE id <> ${mailbox}::uuid`;
    await sql`UPDATE mail.drafts SET body_markdown = repeat('Draft body. ', 50),
      derived_from_message_id = mailbox_id, derivation_kind = 'edit_as_new', derivation_key = id,
      derivation_request_hash = repeat('a', 64)
      WHERE mailbox_id <> ${mailbox}::uuid AND short_id <= 'q02710'`;
    await sql`UPDATE mail.drafts SET derived_from_message_id = NULL, derivation_kind = NULL, derivation_key = NULL,
      derivation_request_hash = NULL, intent = 'reply', source_message_id = mailbox_id, conversation_id = mailbox_id
      WHERE short_id IN ('q00001', 'q00002', 'q00003', 'q00004')`;
    await sql`ANALYZE mail.drafts`;
  });

  const seedMessages = async () => {
    await sql`INSERT INTO mail.conversations (id, short_id, mailbox_id, latest_message_at)
      SELECT ('00003267-0000-4000-8001-' || lpad(item::text, 12, '0'))::uuid,
        'p' || lpad(to_hex(item), 5, '0'), ${mailbox}::uuid, '2026-11-13T12:00:00Z'
      FROM generate_series(1, 1000) item`;
    await sql`INSERT INTO mail.message_contents (id, short_id, mailbox_id, message_id, internal_date, content_hash)
      SELECT ('00003267-0000-4000-8002-' || lpad(item::text, 12, '0'))::uuid,
        'p' || lpad(to_hex(item), 5, '0'), ${mailbox}::uuid, '<bulk-' || item || '@example.test>',
        '2026-11-13T12:00:00Z', lpad(to_hex(item), 64, '0') FROM generate_series(1, 10000) item`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
      SELECT ('00003267-0000-4000-8001-' || lpad((1 + (item - 1) / 10)::text, 12, '0'))::uuid,
        ('00003267-0000-4000-8002-' || lpad(item::text, 12, '0'))::uuid, item FROM generate_series(1, 10000) item`;
    // Rebuild removes the provider-draft copies that old syncs imported as messages.
    await sql`INSERT INTO mail.draft_provider_snapshots
      (mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id, content_fingerprint)
      SELECT ${mailbox}::uuid, ${projectionDraft}::uuid, item, 'export', 'retired',
        '<bulk-' || item || '@example.test>', lpad(to_hex(item), 64, '0') FROM generate_series(1, 10000) item`;
    await sql`ANALYZE mail.message_contents`;
    await sql`ANALYZE mail.conversation_messages`;
    await sql`ANALYZE mail.draft_provider_snapshots`;
  };

  test("keeps a 10,000-link cascade to nine client statements and indexed draft lookups", async () => {
    const label = "Mail bulk room access";
    await seedMessages();
    const plan = await sql`EXPLAIN (ANALYZE, BUFFERS) SELECT DISTINCT mailbox_id FROM mail.drafts
      WHERE edit_mode = 'shared' AND state = 'draft'
        AND (source_message_id IN ('00003267-0000-4000-8002-000000000001'::uuid, NULL)
          OR derived_from_message_id IN ('00003267-0000-4000-8002-000000000001'::uuid, NULL))`;
    const lookupPlan = JSON.stringify(plan);
    console.info(label, lookupPlan);
    expect(lookupPlan).toContain("BitmapOr");
    expect(lookupPlan).toContain("Bitmap Index Scan on drafts_source_message_idx");
    expect(lookupPlan).toContain("drafts_shared_derived_message_idx");
    expect(lookupPlan).not.toContain("Seq Scan");
    const meter = await meterSql();
    try {
      const start = performance.now();
      let removed: unknown;
      const statements = await meter.during(async () => {
        removed = await executeOperatorAction({
          commandId: "00003267-0000-4000-8000-000000000004",
          mailboxId: mailbox,
          input: { kind: "rebuild_threads", idempotencyKey: "bulk-room-access" },
        });
      });
      console.info(label, `${(performance.now() - start).toFixed(1)} ms`, statements);
      // The client meter cannot see trigger SQL; the plan assertions above guard that work.
      expect(statements).toHaveLength(9);
      expect(removed).toMatchObject({ removedDraftCopies: 10000 });
      expect(
        await sql`SELECT 1 FROM mail.conversation_messages WHERE conversation_id IN
        (SELECT id FROM mail.conversations WHERE mailbox_id = ${mailbox}::uuid)`,
      ).toHaveLength(0);
    } finally {
      await meter.close();
    }
  });
});
