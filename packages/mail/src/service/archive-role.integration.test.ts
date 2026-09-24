import { afterAll, beforeAll, expect, test } from "bun:test";
import { encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { clearFolderRole, resolveRoleFolder, setFolderRole } from "./folders";
import { createMailbox } from "./mailboxes";
import { createConversationTriageCommands } from "./triage";

const suite = suiteFor("database", "nats");

suite("mail archive role", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId = "";
  let context: MailRequestContext;
  let mailboxId = "";
  let bindingId = "";
  let resourceId = "";
  let inboxId = "";
  let allMailId = "";
  let labelId = "";
  let conversationId = "";

  const addFolder = async (name: string, role: string, remotePath: string) => {
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resourceId}::uuid, ${`${remotePath}-${suffix}`}, ${name}, ${role}, 'current')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
      ) VALUES (
        ${bindingId}::uuid, ${folder!.id}::uuid, ${remotePath}, 1, 2,
        ARRAY['read', 'write_flags', 'insert', 'move', 'delete_messages']::text[], now()
      )
    `;
    return folder!.id;
  };
  const setGmail = (enabled: boolean) =>
    sql`UPDATE mail.provider_bindings SET capabilities = ${{ gmailExtensions: enabled }}::jsonb WHERE id = ${bindingId}::uuid`;

  beforeAll(async () => {
    await migrate();
    const uid = `mail-archive-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Archive Owner', false)
      RETURNING id
    `;
    userId = user!.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid,
          provider: "local",
          profile: "user",
          displayName: "Archive Owner",
          givenName: "Archive",
          sn: "Owner",
          mail: `${uid}@example.com`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId },
      requestId: `mail-archive-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Archive role ${suffix}`, description: null });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;

    const scope = "b".repeat(64);
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, last_verified_at
      ) VALUES (
        ${mailboxId}::uuid, 'Gmail', 'owner@gmail.com', 'owner@gmail.com',
        'imap.gmail.com', 993, 'implicit', 'smtp.gmail.com', 587, 'starttls',
        'password', ${await encryptSecret({ kind: "password", password: "archive-fixture-secret" })},
        'owner@gmail.com', '{}'::jsonb, '{}'::jsonb, now()
      ) RETURNING id
    `;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    resourceId = resource!.id;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
        verification_evidence, verified_scope_fingerprint, last_verified_at
      ) VALUES (
        ${resourceId}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${scope}, now()
      ) RETURNING id
    `;
    bindingId = binding!.id;
    inboxId = await addFolder("INBOX", "inbox", "INBOX");
    allMailId = await addFolder("All Mail", "all", "[Gmail]/All Mail");
    labelId = await addFolder("Projects", "other", "Projects");

    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<archive-${suffix}@example.com>`}, 'Archive me', 'archive me',
        now(), 128, ${"c".repeat(64)}, 'complete', 'Archive me')
      RETURNING id
    `;
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxId}::uuid, ${message!.id}::uuid, 1, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${ref!.id}::uuid, ${inboxId}::uuid, ${message!.id}::uuid, ARRAY[]::text[], ARRAY[]::text[])
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Archive me', 'sender@example.com', now(), 'needs_action')
      RETURNING id
    `;
    conversationId = conversation!.id;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversationId}::uuid, ${message!.id}::uuid, 1, 'headers')
    `;
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      const accessIds = access.map((row) => row.access_id);
      if (accessIds.length > 0)
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("keeps the archive role unresolved for IMAP providers without Gmail extensions", async () => {
    await setGmail(false);
    const resolved = await resolveRoleFolder(mailboxId, "archive");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.message).toBe("No archive folder is configured");
  });

  test("archives a Gmail conversation by moving it out of the Inbox to All Mail", async () => {
    await setGmail(true);
    expect(await resolveRoleFolder(mailboxId, "archive")).toEqual({
      ok: true,
      data: { id: allMailId, role: "archive", providerRole: "all", configured: false },
    });

    const archived = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId,
      input: { kind: "move_to_role", sourceFolderId: inboxId, role: "archive", idempotencyKey: `archive-${suffix}` },
    });
    if (!archived.ok) throw new Error(archived.error.message);
    expect(archived.data.commands).toHaveLength(1);
    expect(archived.data.commands[0]).toMatchObject({ kind: "move", state: "queued" });
    const [payload] = await sql<{ source: string; destination: string }[]>`
      SELECT target ->> 'sourceFolderId' AS source, target ->> 'destinationFolderId' AS destination
      FROM mail.commands
      WHERE id = ${archived.data.commands[0]!.id}::uuid
    `;
    expect(payload).toEqual({ source: inboxId, destination: allMailId });
  });

  test("prefers a configured archive folder on Gmail", async () => {
    await setGmail(true);
    const configured = await setFolderRole({ context, mailboxId, folderId: labelId, role: "archive" });
    expect(configured.ok).toBe(true);
    const resolved = await resolveRoleFolder(mailboxId, "archive");
    expect(resolved.ok && resolved.data).toEqual({ id: labelId, role: "archive", providerRole: "other", configured: true });
    expect((await clearFolderRole({ context, mailboxId, role: "archive" })).ok).toBe(true);
  });
});
