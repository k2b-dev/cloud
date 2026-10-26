import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens, toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import api from "../api";
import type { FolderRole, SenderDispositionInput } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { DISPOSITION_LIMIT } from "./bulk-disposition";
import { previewIncomingAutomationMatches } from "./incoming-automations";
import { createMailbox } from "./mailboxes";
import { applySenderDisposition } from "./sender-disposition";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
};

const suite = suiteFor("database", "nats", "valkey");

const userFor = (row: { id: string; uid: string }): User => ({
  ...row,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: row.uid,
  sn: "Test",
  displayName: row.uid,
  mail: `${row.uid}@example.test`,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: `sender-disposition-${user.uid}`,
});

suite("sender bulk disposition", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: User[] = [];
  const folders = new Map<string, { id: string; short_id: string }>();
  let mailboxId = "";
  let mailboxShortId = "";
  let ownerContext: MailRequestContext;
  let readerContext: MailRequestContext;
  let writerContext: MailRequestContext;
  let assignedWriterContext: MailRequestContext;
  let verifyToken: ReturnType<typeof spyOn<typeof oauthTokens, "verifyAccessToken">> | undefined;
  let uid = 0;
  let bindingId = "";

  const addMessage = async (folderName: string, sender = "news@cleanup.test", stale = false, deleted = false) => {
    const folder = required(folders.get(folderName));
    uid += 1;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<sender-${uid}-${suffix}@cleanup.test>`}, 'Cleanup', now(), 1, ${new Bun.CryptoHasher("sha256").update(`${suffix}:${uid}`).digest("hex")}, 'complete')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      VALUES (${required(message).id}::uuid, 'from', 0, ${sender}, ${sender.toLowerCase()})
    `;
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid, stale_at)
      VALUES (${folder.id}::uuid, ${required(message).id}::uuid, 1, ${uid}, ${stale ? new Date() : null}) RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, deleted_at)
      VALUES (${required(ref).id}::uuid, ${folder.id}::uuid, ${required(message).id}::uuid, ${deleted ? new Date() : null})
    `;
    return required(ref).id;
  };
  const addCopy = async (refId: string, folderName: string) => {
    const [source] = await sql<{ message_id: string }[]>`SELECT message_id FROM mail.remote_message_refs WHERE id = ${refId}::uuid`;
    const folder = required(folders.get(folderName));
    uid++;
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder.id}::uuid, ${required(source).message_id}::uuid, 1, ${uid}) RETURNING id
    `;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${required(ref).id}::uuid, ${folder.id}::uuid, ${required(source).message_id}::uuid)`;
    return required(ref).id;
  };
  const keepMessage = async (refId: string) => {
    const [ref] = await sql<{ message_id: string }[]>`SELECT message_id FROM mail.remote_message_refs WHERE id = ${refId}::uuid`;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Keep', 'sender', now()) RETURNING id
    `;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${required(conversation).id}::uuid, ${required(ref).message_id}::uuid, 1, 'headers')`;
    await sql`INSERT INTO mail.conversation_keeps (conversation_id, mailbox_id, kept_by_kind, kept_by_id)
      VALUES (${required(conversation).id}::uuid, ${mailboxId}::uuid, 'user', ${required(users[0]).id}::uuid)`;
  };
  const sourcesFor = async (key: string) => {
    const rows = await sql<{ target: { remoteMessageRefId: string; sourceFolderId: string } }[]>`
      SELECT target FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid AND correlation_id = ${key}
    `;
    return rows.map((row) => row.target.remoteMessageRefId).sort();
  };
  const move = (input: Omit<SenderDispositionInput, "idempotencyKey">, idempotencyKey = crypto.randomUUID(), context = ownerContext) =>
    applySenderDisposition({ context, mailboxId, input: { ...input, idempotencyKey } });
  const request = (body: unknown) =>
    api.request(`/mailboxes/${mailboxShortId}/senders/disposition`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    await migrate();
    for (const role of ["owner", "reader", "writer", "assigned-writer"]) {
      const [row] = await sql<{ id: string; uid: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`sender-${role}-${suffix}`}, 'local', 'user', ${role}, false) RETURNING id, uid
      `;
      users.push(userFor(required(row)));
    }
    ownerContext = contextFor(required(users[0]));
    readerContext = contextFor(required(users[1]));
    writerContext = contextFor(required(users[2]));
    assignedWriterContext = contextFor(required(users[3]));
    const mailbox = await createMailbox(ownerContext, { name: `Sender disposition ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = required(mailboxRow).short_id;
    for (const [index, permission] of ["read", "write"].entries()) {
      const access = await grantMailboxAccess({
        context: ownerContext,
        mailboxId,
        principal: { type: "user", userId: required(users[index + 1]).id },
        permission: permission === "read" ? "read" : "write",
      });
      if (!access.ok) throw new Error(access.error.message);
    }
    const assignedAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: required(users[3]).id },
      permission: "write",
      scope: "assigned",
    });
    if (!assignedAccess.ok) throw new Error(assignedAccess.error.message);
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, status)
      VALUES (${mailboxId}::uuid, 'Fixture', 'own@cleanup.test', 'own@cleanup.test', 'imap.example.test', 993, 'implicit',
        'smtp.example.test', 465, 'implicit', 'password', 'fixture-secret', 'active') RETURNING id
    `;
    const scope = "a".repeat(64);
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${scope}, 'active') RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator, verified_scope_fingerprint, verified_secret_revision)
      VALUES (${required(resource).id}::uuid, ${required(connection).id}::uuid, 'active', '{}'::jsonb, ${scope}, 1) RETURNING id
    `;
    bindingId = required(binding).id;
    const definitions: Array<[string, FolderRole]> = [
      ["INBOX", "inbox"],
      ["Custom", "other"],
      ["Archive", "archive"],
      ["Trash", "trash"],
      ["Junk", "junk"],
      ["Sent", "sent"],
      ["Drafts", "drafts"],
      ["Override", "other"],
      ["Inactive", "other"],
      ["Container", "other"],
      ["All Mail", "all"],
    ];
    for (const [name, role] of definitions) {
      const [folder] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status, selectable)
        VALUES (${newShortId()}, ${required(resource).id}::uuid, ${name}, ${name}, ${role}, 'current', ${name !== "Container"}) RETURNING id, short_id
      `;
      folders.set(name, required(folder));
      await sql`
        INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at)
        VALUES (${required(binding).id}::uuid, ${required(folder).id}::uuid, ${name}, 1, 1, ARRAY['read', 'move', 'insert']::text[], now())
      `;
    }
    await sql`UPDATE mail.folders SET discovery_state = 'missing' WHERE id = ${required(folders.get("Inactive")).id}::uuid`;
    await sql`
      INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
      VALUES (${mailboxId}::uuid, 'junk', ${required(folders.get("Override")).id}::uuid)
    `;
    await sql`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, from_address, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Own', 'own@cleanup.test', 'verified')
    `;
    verifyToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token) =>
      token === "owner" ? { kind: "user", payload: {}, user: required(users[0]), scopes: ["read", "write"] } : null,
    );
  });

  afterAll(async () => {
    verifyToken?.mockRestore();
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    for (const user of users) await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
  });

  test("moves inbound domain matches from INBOX and custom folders, excluding protected roles and unavailable placements", async () => {
    const expected = [await addMessage("INBOX"), await addMessage("Custom", "alerts@cleanup.test")];
    const [source] = await sql<
      { message_id: string }[]
    >`SELECT message_id FROM mail.remote_message_refs WHERE id = ${required(expected[0])}::uuid`;
    uid += 1;
    const [copy] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${required(folders.get("INBOX")).id}::uuid, ${required(source).message_id}::uuid, 1, ${uid}) RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${required(copy).id}::uuid, ${required(folders.get("INBOX")).id}::uuid, ${required(source).message_id}::uuid)
    `;
    // A second matching From address must not duplicate a provider-copy target.
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      VALUES (${required(source).message_id}::uuid, 'from', 1, 'another@cleanup.test', 'another@cleanup.test')
    `;
    expected.push(required(copy).id);
    for (const name of ["Archive", "Trash", "Junk", "Sent", "Drafts", "Override", "Inactive"]) await addMessage(name);
    await addMessage("INBOX", "own@cleanup.test");
    await addMessage("INBOX", "news@other.test");
    await addMessage("INBOX", "news@sub.cleanup.test");
    await addMessage("INBOX", "news@cleanup.test", true);
    await addMessage("INBOX", "news@cleanup.test", false, true);
    const key = crypto.randomUUID();
    const first = await move({ match: "domain", value: " CLEANUP.TEST ", destination: "archive" }, key, writerContext);
    expect(first).toEqual({ ok: true, data: { commandCount: 3, truncated: false } });
    const replay = await move({ match: "domain", value: "cleanup.test", destination: "archive" }, key, writerContext);
    expect(replay).toEqual(first);
    const rows = await sql<{ target: { remoteMessageRefId: string; destinationFolderId: string }; idempotency_key: string }[]>`
      SELECT target, idempotency_key FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid AND correlation_id = ${key}
    `;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.target.remoteMessageRefId).sort()).toEqual(expected.sort());
    for (const row of rows) {
      expect(row.target.destinationFolderId).toBe(required(folders.get("Archive")).id);
      expect(row.idempotency_key).toBe(`${key}:${row.target.remoteMessageRefId}`);
    }
  });

  test("rejects own identities, incomplete domains and read-only callers", async () => {
    for (const [match, value] of [
      ["sender", " OWN@CLEANUP.TEST "],
      ["domain", "cleanup"],
    ] as const) {
      const result = await move({ match, value, destination: "trash" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(400);
        if (match === "sender") {
          expect(result.error.message).toBe("Choose an external sender; this address is one of the mailbox's own sender addresses");
        }
      }
    }
    const denied = await move({ match: "domain", value: "cleanup.test", destination: "trash" }, crypto.randomUUID(), readerContext);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);
  });

  test("rejects assigned-only writers without queuing commands", async () => {
    await addMessage("INBOX", "sender@assigned-writer.test");
    const key = crypto.randomUUID();
    const result = await move({ match: "domain", value: "assigned-writer.test", destination: "trash" }, key, assignedWriterContext);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(403);
    expect(await sourcesFor(key)).toEqual([]);
  });

  test("translates public folder IDs, validates the strict destination contract, and supports sender matching", async () => {
    await addMessage("INBOX", "one@api.test");
    const body: SenderDispositionInput = {
      match: "sender",
      value: "ONE@API.TEST",
      folderId: required(folders.get("Custom")).short_id,
      idempotencyKey: crypto.randomUUID(),
    };
    const response = await request(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commandCount: 1, truncated: false });
    for (const invalid of [
      { ...body, destination: "archive" },
      { ...body, folderId: undefined },
      { ...body, extra: true },
      { ...body, idempotencyKey: "not-a-uuid" },
      { ...body, folderId: required(folders.get("Custom")).id },
      { ...body, folderId: required(folders.get("Inactive")).short_id },
      { ...body, folderId: required(folders.get("Container")).short_id },
    ])
      expect((await request(invalid)).status).toBe(400);
    const crossMailbox = await createMailbox(ownerContext, { name: `Other ${suffix}` });
    if (!crossMailbox.ok) throw new Error(crossMailbox.error.message);
    try {
      const [foreignResource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${crossMailbox.data.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${"b".repeat(64)}, 'active') RETURNING id
      `;
      const [foreignFolder] = await sql<{ short_id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role)
        VALUES (${newShortId()}, ${required(foreignResource).id}::uuid, 'Foreign', 'Foreign', 'other') RETURNING short_id
      `;
      expect((await request({ ...body, folderId: required(foreignFolder).short_id })).status).toBe(404);
      const result = await applySenderDisposition({
        context: ownerContext,
        mailboxId: crossMailbox.data.id,
        input: { ...body, folderId: required(folders.get("Custom")).id },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.status).toBe(400);
    } finally {
      const access = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${crossMailbox.data.id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${crossMailbox.data.id}::uuid`;
      for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
  });

  test("bounds the batch and reports truncation", async () => {
    const inbox = required(folders.get("INBOX"));
    // Bulk fixture inserts keep the 501-message boundary test fast.
    const shortIds = Array.from({ length: DISPOSITION_LIMIT + 1 }, () => newShortId());
    await sql`
      WITH messages AS (
        INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
        SELECT short_id, ${mailboxId}::uuid,
          '<bulk-' || ${suffix} || '-' || n || '@bounded.test>', 'Bulk', now(), 1, md5(n::text) || md5(n::text), 'complete'
        FROM unnest(${toPgTextArray(shortIds)}::text[]) WITH ORDINALITY AS seed(short_id, n) RETURNING id
      ), addresses AS (
        INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
        SELECT id, 'from', 0, 'bulk@bounded.test', 'bulk@bounded.test' FROM messages
      ), refs AS (
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        SELECT ${inbox.id}::uuid, id, 1, 10000 + row_number() OVER (ORDER BY id) FROM messages RETURNING id, message_id
      )
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      SELECT id, ${inbox.id}::uuid, message_id FROM refs
    `;
    const result = await move({ match: "sender", value: "bulk@bounded.test", destination: "trash" });
    expect(result).toEqual({ ok: true, data: { commandCount: DISPOSITION_LIMIT, truncated: true } });
  }, 60_000);
  test("only the first From matches both preview and sender moves; missing From matches nothing", async () => {
    const second = await addMessage("INBOX", "first@other.test");
    const missing = await addMessage("INBOX", "second@first-from.test");
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      SELECT message_id, 'from', 1, 'second@first-from.test', 'second@first-from.test'
      FROM mail.remote_message_refs WHERE id = ${second}::uuid`;
    await sql`DELETE FROM mail.message_addresses WHERE message_id =
      (SELECT message_id FROM mail.remote_message_refs WHERE id = ${missing}::uuid)`;
    const preview = await previewIncomingAutomationMatches({
      context: ownerContext,
      mailboxId,
      input: {
        scope: {
          mode: "matching",
          conditions: { mode: "all", items: [{ field: "sender_domain", operator: "is", value: "first-from.test" }] },
        },
      },
    });
    expect(preview.ok && preview.data.messageCount).toBe(0);
    expect(await move({ match: "domain", value: "first-from.test", destination: "archive" })).toEqual({
      ok: true,
      data: { commandCount: 0, truncated: false },
    });
  });

  test("skips kept messages for Trash or configured Junk, but allows Archive", async () => {
    const kept = await addMessage("INBOX", "keep@keep-cleanup.test");
    await keepMessage(kept);
    await addMessage("Custom", "ordinary@keep-cleanup.test");
    expect(await move({ match: "domain", value: "keep-cleanup.test", destination: "trash" })).toEqual({
      ok: true,
      data: { commandCount: 1, truncated: false },
    });
    expect(await move({ match: "domain", value: "keep-cleanup.test", folderId: required(folders.get("Override")).id })).toEqual({
      ok: true,
      data: { commandCount: 1, truncated: false },
    });
    expect(await move({ match: "domain", value: "keep-cleanup.test", destination: "archive" })).toEqual({
      ok: true,
      data: { commandCount: 2, truncated: false },
    });
  });

  test("matches the domain after the last @ in both preview and sender moves", async () => {
    const source = await addMessage("INBOX", "placeholder@other.test");
    await sql`UPDATE mail.message_addresses SET normalized_email = ${'"a@b"@lastat.test'}
      WHERE message_id = (SELECT message_id FROM mail.remote_message_refs WHERE id = ${source}::uuid)`;
    const preview = await previewIncomingAutomationMatches({
      context: ownerContext,
      mailboxId,
      input: {
        scope: {
          mode: "matching",
          conditions: { mode: "all", items: [{ field: "sender_domain", operator: "is", value: "lastat.test" }] },
        },
      },
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.data.messageCount).toBe(1);
    const key = crypto.randomUUID();
    expect(await move({ match: "domain", value: "lastat.test", destination: "trash" }, key)).toEqual({
      ok: true,
      data: { commandCount: 1, truncated: false },
    });
    expect(await sourcesFor(key)).toEqual([source]);
  });

  test("protects provider Junk even when configured as Archive on non-Gmail mailboxes", async () => {
    await addMessage("Junk", "sender@provider-junk.test");
    try {
      await sql`INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
        VALUES (${mailboxId}::uuid, 'archive', ${required(folders.get("Junk")).id}::uuid)`;
      const key = crypto.randomUUID();
      expect(await move({ match: "domain", value: "provider-junk.test", destination: "trash" }, key)).toEqual({
        ok: true,
        data: { commandCount: 0, truncated: false },
      });
      expect(await sourcesFor(key)).toEqual([]);
    } finally {
      await sql`DELETE FROM mail.folder_role_overrides WHERE mailbox_id = ${mailboxId}::uuid AND role = 'archive'`;
    }
  });

  test("rejects unknown folder destinations", async () => {
    const result = await move({ match: "domain", value: "cleanup.test", folderId: crypto.randomUUID() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(400);
    expect(
      (await request({ match: "domain", value: "cleanup.test", folderId: "Unknwn", idempotencyKey: crypto.randomUUID() })).status,
    ).toBe(404);
  });

  test("Gmail uses one Inbox or All Mail source per message, never a label, and skips protected messages", async () => {
    try {
      await sql`UPDATE mail.provider_bindings SET capabilities = '{"gmailExtensions":true}'::jsonb WHERE id = ${bindingId}::uuid`;
      // Exercise the All Mail archive fallback, with no provider or configured Archive.
      await sql`UPDATE mail.folders SET role = 'other' WHERE id = ${required(folders.get("Archive")).id}::uuid`;
      const inbox = await addMessage("INBOX", "one@gmail-cleanup.test");
      await addCopy(inbox, "All Mail");
      await addCopy(inbox, "Custom");
      const archived = await addMessage("All Mail", "archived@gmail-cleanup.test");
      await addCopy(archived, "Custom");
      const labelOnly = await addMessage("Custom", "label@gmail-cleanup.test");
      const inTrash = await addMessage("All Mail", "trash@gmail-cleanup.test");
      await addCopy(inTrash, "Trash");
      const junk = await addMessage("INBOX", "junk@gmail-cleanup.test");
      await addCopy(junk, "Override");
      const sent = await addMessage("INBOX", "sent@gmail-cleanup.test");
      await addCopy(sent, "Sent");
      const drafts = await addMessage("All Mail", "draft@gmail-cleanup.test");
      await addCopy(drafts, "Drafts");
      for (const keyword of ["\\Sent", "\\dRaFt"]) {
        const own = await addMessage("All Mail", "own-label@gmail-cleanup.test");
        await sql`UPDATE mail.message_placements SET keywords = ${toPgTextArray([keyword])}::text[]
          WHERE remote_message_ref_id = ${own}::uuid`;
      }
      const alreadyInFolder = await addMessage("All Mail", "destination@gmail-cleanup.test");
      await addCopy(alreadyInFolder, "Archive");
      const archiveKey = crypto.randomUUID();
      expect(await move({ match: "domain", value: "gmail-cleanup.test", destination: "archive" }, archiveKey)).toEqual({
        ok: true,
        data: { commandCount: 1, truncated: false },
      });
      expect(await sourcesFor(archiveKey)).toEqual([inbox]);
      await sql`INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
        VALUES (${mailboxId}::uuid, 'archive', ${required(folders.get("Sent")).id}::uuid)`;
      const trashKey = crypto.randomUUID();
      expect(await move({ match: "domain", value: "gmail-cleanup.test", destination: "trash" }, trashKey)).toEqual({
        ok: true,
        data: { commandCount: 3, truncated: false },
      });
      expect(await sourcesFor(trashKey)).toEqual([inbox, archived, alreadyInFolder].sort());
      expect(await sourcesFor(trashKey)).not.toContain(labelOnly);
      const folderKey = crypto.randomUUID();
      expect(
        await move({ match: "domain", value: "gmail-cleanup.test", folderId: required(folders.get("Archive")).id }, folderKey),
      ).toEqual({ ok: true, data: { commandCount: 1, truncated: false } });
      expect(await sourcesFor(folderKey)).toEqual([inbox]);
      const inboxKey = crypto.randomUUID();
      expect(await move({ match: "domain", value: "gmail-cleanup.test", folderId: required(folders.get("INBOX")).id }, inboxKey)).toEqual({
        ok: true,
        data: { commandCount: 0, truncated: false },
      });
      expect(await sourcesFor(inboxKey)).toEqual([]);
    } finally {
      await sql`UPDATE mail.provider_bindings SET capabilities = '{}'::jsonb WHERE id = ${bindingId}::uuid`;
      await sql`UPDATE mail.folders SET role = 'archive' WHERE id = ${required(folders.get("Archive")).id}::uuid`;
      await sql`DELETE FROM mail.folder_role_overrides WHERE mailbox_id = ${mailboxId}::uuid AND role = 'archive'`;
    }
  });

  test("Gmail without usable All Mail selects only Inbox copies for Trash and folders", async () => {
    try {
      await sql`UPDATE mail.provider_bindings SET capabilities = '{"gmailExtensions":true}'::jsonb WHERE id = ${bindingId}::uuid`;
      const inbox = await addMessage("INBOX", "incoming@gmail-missing-all.test");
      await addCopy(inbox, "Custom");
      const archived = await addMessage("All Mail", "archived@gmail-missing-all.test");
      await addCopy(archived, "Custom");
      await sql`UPDATE mail.folders SET discovery_state = 'missing' WHERE id = ${required(folders.get("All Mail")).id}::uuid`;
      for (const destination of [{ destination: "trash" }, { folderId: required(folders.get("Archive")).id }] as const) {
        const key = crypto.randomUUID();
        expect(await move({ match: "domain", value: "gmail-missing-all.test", ...destination }, key)).toEqual({
          ok: true,
          data: { commandCount: 1, truncated: false },
        });
        expect(await sourcesFor(key)).toEqual([inbox]);
      }
    } finally {
      await sql`UPDATE mail.provider_bindings SET capabilities = '{}'::jsonb WHERE id = ${bindingId}::uuid`;
      await sql`UPDATE mail.folders SET discovery_state = 'active' WHERE id = ${required(folders.get("All Mail")).id}::uuid`;
    }
  });
});
