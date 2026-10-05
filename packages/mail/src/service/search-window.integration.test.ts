import { afterAll, beforeAll, expect, test } from "bun:test";
import { encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { RANKED_MATCH_WINDOW, searchMessages } from "./search";

const suite = suiteFor("database", "nats");

// Every message says "routine", in more bodies than make a word common, so a ranked search walks
// the mailbox from its newest message instead of reading every match.
const MESSAGE_COUNT = 10 * RANKED_MATCH_WINDOW + 500;
const RECENT_FAVORITE = 50;
const ARCHIVED_FAVORITE = 3 * RANKED_MATCH_WINDOW;

const uniqueShortIds = (count: number): string[] => {
  const ids = new Set<string>();
  while (ids.size < count) ids.add(newShortId());
  return [...ids];
};

suite("mail search over a word in every message", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let context: MailRequestContext;
  let mailboxId = "";

  beforeAll(async () => {
    await migrate();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-window-${suffix}`}, 'local', 'user', 'Mail Window Test', true)
      RETURNING id
    `;
    context = {
      actor: {
        kind: "user",
        user: {
          id: user!.id,
          uid: `mail-window-${suffix}`,
          provider: "local",
          profile: "user",
          displayName: "Mail Window Test",
          givenName: "Mail",
          sn: "Window",
          mail: `mail-window-${suffix}@example.com`,
          roles: ["admin", "user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user!.id },
      requestId: `mail-window-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Window ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"e".repeat(64)}, 'active')
      RETURNING id
    `;
    const encryptedSecret = await encryptSecret({ kind: "password", password: "window-fixture-secret" });
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, last_verified_at
      ) VALUES (
        ${mailboxId}::uuid, 'Window fixture', 'window@example.com', 'window@example.com',
        'imap.example.com', 993, 'implicit', 'smtp.example.com', 587, 'starttls',
        'password', ${encryptedSecret}, 'window@example.com', '{}'::jsonb, '{}'::jsonb, now()
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
        verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
      ) VALUES (
        ${resource!.id}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${"e".repeat(64)}, 1, now()
      )
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'window-inbox', 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    // Message n is n minutes old. The recent favorite lies inside the ranked window; the archived
    // one ranks higher but is older than the window, and only it says "archive".
    await sql`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash,
        hydration_status, plain_text, normalized_subject
      )
      SELECT
        short_id.value,
        ${mailboxId}::uuid,
        '<window-' || item || '@example.com>',
        CASE
          WHEN item = ${RECENT_FAVORITE} THEN 'Routine routine routine review'
          WHEN item = ${ARCHIVED_FAVORITE} THEN 'Routine routine routine routine routine archive'
          ELSE 'Message ' || item
        END,
        now() - make_interval(mins => item),
        256,
        lpad(to_hex(item::bigint), 64, '0'),
        'complete',
        'A routine update number ' || item,
        'message ' || item
      FROM generate_series(1, ${MESSAGE_COUNT}) AS item
      JOIN jsonb_array_elements_text(${uniqueShortIds(MESSAGE_COUNT)}::jsonb) WITH ORDINALITY AS short_id(value, position)
        ON short_id.position = item
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      SELECT id, 'from', 0, 'Window Sender', 'sender@example.com', 'sender@example.com'
      FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid
    `;
    await sql`
      INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      SELECT id, mailbox_id, 0, to_tsvector('simple'::regconfig, plain_text)
      FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid
    `;
    await sql`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      SELECT ${folder!.id}::uuid, id, 1, row_number() OVER (ORDER BY internal_date, id)
      FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      SELECT id, folder_id, message_id, ARRAY['\\Seen']::text[], ARRAY[]::text[]
      FROM mail.remote_message_refs WHERE folder_id = ${folder!.id}::uuid
    `;
    await sql`ANALYZE mail.message_contents`;
    await sql`ANALYZE mail.message_search_chunks`;
  }, 120_000);

  afterAll(async () => {
    if (mailboxId) {
      await sql`DELETE FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
  }, 120_000);

  const search = (query: string, options: { sort?: "relevance" | "newest"; limit?: number; cursor?: string; timeoutMs?: number } = {}) =>
    searchMessages({
      context,
      mailboxId,
      request: {
        expression: { type: "text", field: "any", query, match: "words" },
        sort: options.sort ?? "relevance",
        limit: options.limit ?? 10,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
      groupByConversation: false,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });

  test("ranks the newest matches of a word in every message", async () => {
    const page = await search("routine");

    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.items).toHaveLength(10);
    expect(page.data.items[0]?.messageId).toBe(`<window-${RECENT_FAVORITE}@example.com>`);
    expect(page.data.items.map((item) => item.messageId)).not.toContain(`<window-${ARCHIVED_FAVORITE}@example.com>`);
  });

  test("still finds an old message through a rarer word", async () => {
    for (const query of ["archive", "routine archive"]) {
      const page = await search(query);

      if (!page.ok) throw new Error(page.error.message);
      expect(page.data.items.map((item) => item.messageId)).toEqual([`<window-${ARCHIVED_FAVORITE}@example.com>`]);
    }
  });

  test("pages the newest matches of a word in every message", async () => {
    const first = await search("routine", { sort: "newest", limit: 3 });
    if (!first.ok) throw new Error(first.error.message);
    const next = await search("routine", { sort: "newest", limit: 3, cursor: first.data.nextCursor ?? undefined });
    if (!next.ok) throw new Error(next.error.message);

    expect([...first.data.items, ...next.data.items].map((item) => item.messageId)).toEqual(
      [1, 2, 3, 4, 5, 6].map((item) => `<window-${item}@example.com>`),
    );
  });

  test("reports a search that runs out of time as too broad, not as an internal error", async () => {
    const page = await search("routine", { timeoutMs: 1 });

    expect(page).toMatchObject({ ok: false, error: { code: "BAD_INPUT", message: "Search query exceeded the execution limit" } });
  });
});
