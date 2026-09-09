import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { getConversationViewCounts, listConversations } from "./messages";
import { searchMessages } from "./search";

const enabled = process.env.MAIL_PERFORMANCE_TESTS === "1";
const suite = enabled ? describe : describe.skip;
const requestedMessageCount = Number.parseInt(process.env.MAIL_PERFORMANCE_MESSAGE_COUNT ?? "20000", 10);
const MESSAGE_COUNT = Number.isFinite(requestedMessageCount) ? Math.min(Math.max(requestedMessageCount, 20_000), 100_000) : 20_000;

const uniqueShortIds = (count: number): string[] => {
  const ids = new Set<string>();
  while (ids.size < count) ids.add(newShortId());
  return [...ids];
};

suite("mail large-mailbox performance", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ids: { userId?: string; mailboxId?: string; accessIds: string[] } = { accessIds: [] };
  let context: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-perf-${suffix}`}, 'local', 'user', 'Mail Performance Test', true)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create performance user");
    ids.userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid: `mail-perf-${suffix}`,
          provider: "local",
          profile: "user",
          displayName: "Mail Performance Test",
          givenName: "Mail",
          sn: "Performance",
          mail: `mail-perf-${suffix}@example.com`,
          roles: ["admin", "user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-performance-${suffix}`,
    };

    const mailbox = await createMailbox(context, {
      name: `Performance ${suffix}`,
      description: `Disposable ${MESSAGE_COUNT} message performance fixture`,
    });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    ids.mailboxId = mailbox.data.id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (
        mailbox_id, remote_locator, server_identity, scope_fingerprint, status
      ) VALUES (
        ${mailbox.data.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 'active'
      ) RETURNING id
    `;
    const encryptedSecret = await encryptSecret({ kind: "password", password: "performance-fixture-secret" });
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, last_verified_at
      ) VALUES (
        ${mailbox.data.id}::uuid, 'Performance fixture', 'performance@example.com', 'performance@example.com',
        'imap.example.com', 993, 'implicit', 'smtp.example.com', 587, 'starttls',
        'password', ${encryptedSecret}, 'performance@example.com', '{}'::jsonb, '{}'::jsonb, now()
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
        verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
      ) VALUES (
        ${resource!.id}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 1, now()
      )
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'performance-inbox', 'Inbox', 'inbox', 'current')
      RETURNING id
    `;

    const messageShortIds = uniqueShortIds(MESSAGE_COUNT);
    await sql`
      INSERT INTO mail.message_contents (
        short_id,
        mailbox_id,
        message_id,
        subject,
        internal_date,
        size_bytes,
        content_hash,
        hydration_status,
        plain_text,
        normalized_subject
      )
      SELECT
        short_id.value,
        ${mailbox.data.id}::uuid,
        '<bulk-' || item || '@example.com>',
        CASE WHEN item = 15000 THEN 'Quarterly cobalt invoice' ELSE 'Routine message ' || item END,
        now() - (item::text || ' seconds')::interval,
        512,
        lpad(to_hex(item::bigint), 64, '0'),
        'complete',
        CASE WHEN item = 15000 THEN 'The quarterly cobalt invoice is ready for review' ELSE 'Routine body ' || item END,
        CASE WHEN item = 15000 THEN 'quarterly cobalt invoice' ELSE 'routine message ' || item END
      FROM generate_series(1, ${MESSAGE_COUNT}) AS item
      JOIN jsonb_array_elements_text(${messageShortIds}::jsonb) WITH ORDINALITY AS short_id(value, position)
        ON short_id.position = item
    `;
    await sql`
      INSERT INTO mail.message_addresses (
        message_id, role, position, display_name, email, normalized_email
      )
      SELECT
        mc.id,
        'from',
        0,
        CASE WHEN mc.message_id = '<bulk-15000@example.com>' THEN 'Needle Sender' ELSE 'Bulk Sender' END,
        CASE WHEN mc.message_id = '<bulk-15000@example.com>' THEN 'needle@example.com' ELSE 'bulk@example.com' END,
        CASE WHEN mc.message_id = '<bulk-15000@example.com>' THEN 'needle@example.com' ELSE 'bulk@example.com' END
      FROM mail.message_contents mc
      WHERE mc.mailbox_id = ${mailbox.data.id}::uuid
    `;
    await sql`
      INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      SELECT mc.id, mc.mailbox_id, 0, to_tsvector('simple'::regconfig, mc.plain_text)
      FROM mail.message_contents mc
      WHERE mc.mailbox_id = ${mailbox.data.id}::uuid AND mc.plain_text IS NOT NULL
    `;
    await sql`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      SELECT
        ${folder!.id}::uuid,
        mc.id,
        1,
        row_number() OVER (ORDER BY mc.internal_date, mc.id)
      FROM mail.message_contents mc
      WHERE mc.mailbox_id = ${mailbox.data.id}::uuid
    `;
    await sql`
      INSERT INTO mail.message_placements (
        remote_message_ref_id, folder_id, message_id, flags, keywords
      )
      SELECT rmr.id, rmr.folder_id, rmr.message_id, ARRAY[]::text[], ARRAY[]::text[]
      FROM mail.remote_message_refs rmr
      WHERE rmr.folder_id = ${folder!.id}::uuid
    `;
    const conversationIds = uniqueShortIds(MESSAGE_COUNT);
    const conversationShortIds = Object.fromEntries(
      messageShortIds.map((messageShortId, index) => [messageShortId, conversationIds[index]]),
    );
    await sql`
      INSERT INTO mail.conversations (
        id,
        short_id,
        mailbox_id,
        subject,
        participant_summary,
        latest_inbound_at,
        latest_message_at
      )
      SELECT
        mc.id,
        public_id.conversation_short_id,
        mc.mailbox_id,
        mc.subject,
        'Bulk Sender',
        mc.internal_date,
        mc.internal_date
      FROM mail.message_contents mc
      JOIN jsonb_each_text(${conversationShortIds}::jsonb) AS public_id(message_short_id, conversation_short_id)
        ON public_id.message_short_id = mc.short_id
      WHERE mc.mailbox_id = ${mailbox.data.id}::uuid
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      SELECT
        mc.id,
        mc.id,
        (extract(epoch FROM mc.internal_date) * 1000)::bigint,
        'heuristic'
      FROM mail.message_contents mc
      WHERE mc.mailbox_id = ${mailbox.data.id}::uuid
    `;
    await sql`ANALYZE mail.message_contents`;
    await sql`ANALYZE mail.message_addresses`;
    await sql`ANALYZE mail.message_placements`;
    await sql`ANALYZE mail.conversations`;
    await sql`ANALYZE mail.conversation_messages`;
  }, 120_000);

  afterAll(async () => {
    if (ids.mailboxId) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${ids.mailboxId}::uuid
      `;
      ids.accessIds.push(...access.map((row) => row.access_id));
      await sql`
        DELETE FROM mail.conversation_messages conversation_message
        USING mail.conversations conversation
        WHERE conversation_message.conversation_id = conversation.id
          AND conversation.mailbox_id = ${ids.mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.conversations WHERE mailbox_id = ${ids.mailboxId}::uuid`;
      await sql`
        DELETE FROM mail.message_search_chunks chunk
        USING mail.message_contents message
        WHERE chunk.message_id = message.id AND message.mailbox_id = ${ids.mailboxId}::uuid
      `;
      await sql`
        DELETE FROM mail.message_placements placement
        USING mail.message_contents message
        WHERE placement.message_id = message.id AND message.mailbox_id = ${ids.mailboxId}::uuid
      `;
      await sql`
        DELETE FROM mail.remote_message_refs remote_ref
        USING mail.message_contents message
        WHERE remote_ref.message_id = message.id AND message.mailbox_id = ${ids.mailboxId}::uuid
      `;
      await sql`
        DELETE FROM mail.message_addresses address
        USING mail.message_contents message
        WHERE address.message_id = message.id AND message.mailbox_id = ${ids.mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.message_contents WHERE mailbox_id = ${ids.mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${ids.mailboxId}::uuid`;
    }
    if (ids.accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids.accessIds}::jsonb))`;
    }
    if (ids.userId) await sql`DELETE FROM auth.users WHERE id = ${ids.userId}::uuid`;
  }, 120_000);

  test(`keeps structured indexed search bounded at ${MESSAGE_COUNT.toLocaleString("en-US")} messages`, async () => {
    if (!ids.mailboxId) throw new Error("Performance mailbox is unavailable");
    const durations: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const result = await searchMessages({
        context,
        mailboxId: ids.mailboxId,
        request: {
          expression: {
            type: "and",
            expressions: [
              { type: "text", field: "from", query: "needle@example.com", match: "exact" },
              { type: "text", field: "body", query: "quarterly cobalt", match: "phrase" },
            ],
          },
          sort: "relevance",
          limit: 20,
        },
      });
      durations.push(performance.now() - startedAt);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(1);
        expect(result.data.items[0]?.messageId).toBe("<bulk-15000@example.com>");
      }
    }
    const warmDurations = durations.slice(1);
    const worstWarmMs = Math.max(...warmDurations);
    console.info(`Mail ${MESSAGE_COUNT} structured search: ${warmDurations.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(worstWarmMs).toBeLessThan(500);
  }, 30_000);

  test(`keeps conversation-only saved-view search bounded at ${MESSAGE_COUNT.toLocaleString("en-US")} conversations`, async () => {
    if (!ids.mailboxId) throw new Error("Performance mailbox is unavailable");
    const durations: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const result = await searchMessages({
        context,
        mailboxId: ids.mailboxId,
        request: {
          expression: { type: "work_status", value: "needs_action" },
          sort: "newest",
          limit: 50,
        },
      });
      durations.push(performance.now() - startedAt);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.items).toHaveLength(50);
    }
    const warmDurations = durations.slice(1);
    const worstWarmMs = Math.max(...warmDurations);
    console.info(`Mail ${MESSAGE_COUNT} conversation-only search: ${warmDurations.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(worstWarmMs).toBeLessThan(500);
  }, 30_000);

  test(`keeps unfiltered newest search bounded at ${MESSAGE_COUNT.toLocaleString("en-US")} conversations`, async () => {
    if (!ids.mailboxId) throw new Error("Performance mailbox is unavailable");
    const durations: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const result = await searchMessages({
        context,
        mailboxId: ids.mailboxId,
        request: {
          expression: { type: "all" },
          sort: "newest",
          limit: 50,
        },
      });
      durations.push(performance.now() - startedAt);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.items).toHaveLength(50);
    }
    const warmDurations = durations.slice(1);
    const worstWarmMs = Math.max(...warmDurations);
    console.info(`Mail ${MESSAGE_COUNT} unfiltered search: ${warmDurations.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(worstWarmMs).toBeLessThan(500);
  }, 30_000);

  test(`keeps ordinary quick search bounded at ${MESSAGE_COUNT.toLocaleString("en-US")} messages`, async () => {
    if (!ids.mailboxId) throw new Error("Performance mailbox is unavailable");
    const durations: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const result = await searchMessages({
        context,
        mailboxId: ids.mailboxId,
        request: {
          expression: { type: "text", field: "any", query: "quarterly cobalt", match: "words" },
          sort: "relevance",
          limit: 20,
        },
      });
      durations.push(performance.now() - startedAt);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(1);
        expect(result.data.items[0]?.messageId).toBe("<bulk-15000@example.com>");
      }
    }
    const warmDurations = durations.slice(1);
    const worstWarmMs = Math.max(...warmDurations);
    console.info(`Mail ${MESSAGE_COUNT} quick search: ${warmDurations.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(worstWarmMs).toBeLessThan(500);
  }, 30_000);

  test(`keeps the warm inbox list bounded at ${MESSAGE_COUNT.toLocaleString("en-US")} conversations`, async () => {
    if (!ids.mailboxId) throw new Error("Performance mailbox is unavailable");
    const durations: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const result = await listConversations({
        context,
        mailboxId: ids.mailboxId,
        limit: 50,
      });
      durations.push(performance.now() - startedAt);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(50);
        expect(result.data.items.every((item) => item.messageCount === 1)).toBe(true);
      }
    }
    const warmDurations = durations.slice(1);
    const worstWarmMs = Math.max(...warmDurations);
    console.info(`Mail ${MESSAGE_COUNT} conversation list: ${warmDurations.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(worstWarmMs).toBeLessThan(500);
  }, 30_000);

  test(`keeps collaboration views bounded at ${MESSAGE_COUNT.toLocaleString("en-US")} conversations`, async () => {
    if (!ids.mailboxId) throw new Error("Performance mailbox is unavailable");
    const durations: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const [view, counts] = await Promise.all([
        listConversations({ context, mailboxId: ids.mailboxId, view: "needs_action", limit: 50 }),
        getConversationViewCounts({ context, mailboxId: ids.mailboxId }),
      ]);
      durations.push(performance.now() - startedAt);
      expect(view.ok && view.data.items).toHaveLength(50);
      expect(counts.ok && counts.data.needs_action).toBe(MESSAGE_COUNT);
      expect(counts.ok && counts.data.recently_active).toBe(MESSAGE_COUNT);
    }
    const warmDurations = durations.slice(1);
    const worstWarmMs = Math.max(...warmDurations);
    console.info(`Mail ${MESSAGE_COUNT} collaboration views: ${warmDurations.map((value) => value.toFixed(1)).join(", ")} ms`);
    expect(worstWarmMs).toBeLessThan(500);
  }, 30_000);
});
