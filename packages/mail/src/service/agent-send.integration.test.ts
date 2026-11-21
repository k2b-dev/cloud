import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { accounts, encryptSecret } from "@k2b/cloud/services";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { draftContentInputSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { createDraft } from "./drafts";
import { createMailbox } from "./mailboxes";

suiteFor("database", "nats")("Mail agent send", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId = "";
  let mailboxId = "";
  let mailboxShortId = "";
  let remoteResourceId = "";
  let inboxFolderId = "";
  let copyFolderId = "";
  let senderIdentityId = "";
  let senderIdentityShortId = "";
  let context: MailRequestContext;

  beforeAll(async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`mail-agent-send-${suffix}`}, 'local', 'user', 'Mail agent send') RETURNING id`;
    if (!row) throw new Error("Missing agent send fixture user");
    userId = row.id;
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing agent send fixture user");
    context = { actor: { kind: "user", user }, accessSubject: { type: "user", userId }, requestId: `agent-send-${suffix}` };
    const mailbox = await createMailbox(context, { name: `Agent send ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [publicMailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = publicMailbox!.short_id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"d".repeat(64)}, 'active')
      RETURNING id
    `;
    if (!resource) throw new Error("Failed to create Mail agent-send remote resource");
    remoteResourceId = resource.id;
    const folders = await sql<{ id: string; stable_key: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES
        (${newShortId()}, ${remoteResourceId}::uuid, ${`agent-send-inbox-${suffix}`}, 'Inbox', 'inbox', 'current'),
        (${newShortId()}, ${remoteResourceId}::uuid, ${`agent-send-copy-${suffix}`}, 'Archive', 'archive', 'current')
      RETURNING id, stable_key
    `;
    inboxFolderId = folders.find((folder) => folder.stable_key === `agent-send-inbox-${suffix}`)?.id ?? "";
    copyFolderId = folders.find((folder) => folder.stable_key === `agent-send-copy-${suffix}`)?.id ?? "";
    if (!inboxFolderId || !copyFolderId) throw new Error("Failed to create Mail agent-send folders");
    // The real send capability requires verified provider and sender bindings.
    const fixtureSecret = await encryptSecret({ kind: "password", password: "fixture-secret" });
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username,
        imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode,
        secret_kind, encrypted_secret, status
      ) VALUES (
        ${mailboxId}::uuid, 'Agent send fixture', 'support@example.test', 'support@example.test',
        'imap.example.test', 993, 'implicit',
        'smtp.example.test', 465, 'implicit',
        'password', ${fixtureSecret}, 'active'
      )
      RETURNING id
    `;
    if (!connection) throw new Error("Failed to create Mail agent-send provider connection");
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator,
        verified_scope_fingerprint, verified_secret_revision
      ) VALUES (
        ${remoteResourceId}::uuid, ${connection.id}::uuid, 'active', '{}'::jsonb,
        ${"d".repeat(64)}, 1
      )
      RETURNING id
    `;
    if (!binding) throw new Error("Failed to create Mail agent-send provider binding");
    for (const folder of [
      { id: inboxFolderId, path: "INBOX" },
      { id: copyFolderId, path: "Archive" },
    ]) {
      await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
        ) VALUES (
          ${binding.id}::uuid, ${folder.id}::uuid, ${folder.path}, 1, 1,
          ARRAY['read', 'insert', 'move']::text[], now()
        )
      `;
    }
    const [identity] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, is_default, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Support', 'Support', 'support@example.test', true, 'verified')
      RETURNING id, short_id
    `;
    if (!identity) throw new Error("Failed to create Mail agent-send sender identity");
    await sql`
      INSERT INTO mail.sender_identity_bindings (
        sender_identity_id, binding_id, provider_principal, verified_at, verified_secret_revision, saves_sent_automatically
      ) VALUES (
        ${identity.id}::uuid, ${binding.id}::uuid, 'support@example.test', now(), 1, true
      )
    `;
    senderIdentityId = identity.id;
    senderIdentityShortId = identity.short_id;
  });

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("direct agent send retains the documented machine authority contract", async () => {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES ('Mail send fixture agent', 'agent') RETURNING id
    `;
    if (!account) throw new Error("Missing agent account");
    try {
      const grant = await grantMailboxAccess({
        context,
        mailboxId,
        principal: { type: "service_account", serviceAccountId: account.id },
        permission: "write",
      });
      if (!grant.ok) throw new Error(grant.error.message);
      const agent: MailRequestContext = {
        requestId: `agent-send-${suffix}`,
        accessSubject: { type: "service_account", serviceAccountId: account.id },
        actor: {
          kind: "service_account",
          delegatedUser: null,
          scopes: ["mail:write"],
          credentialExpiresAt: "2099-01-01T00:00:00.000Z",
          serviceAccount: {
            id: account.id,
            name: "Mail send fixture agent",
            kind: "agent",
            status: "active",
            delegatedUserId: null,
            appId: null,
            resourceType: null,
            resourceId: null,
            createdBy: null,
            createdAt: "2026-10-20T00:00:00.000Z",
          },
        },
      };
      const draft = await createDraft({
        context: agent,
        mailboxId,
        input: {
          ...draftContentInputSchema.parse({
            senderIdentityId: senderIdentityShortId,
            to: [{ address: "agent-recipient@external.test" }],
            subject: "Agent proposal",
            body: "AI_GENERATED_AGENT_PROPOSAL",
            format: "plain",
          }),
          senderIdentityId,
        },
      });
      if (!draft.ok) throw new Error(draft.error.message);
      const [stored] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.drafts WHERE id = ${draft.data.id}::uuid`;
      const capabilityContext = {
        ...agent,
        target: { type: "mail.mailbox", id: mailboxShortId },
        user: null,
        origin: "http" as const,
        requestId: `agent-send-${suffix}`,
        idempotencyKey: `agent-send-${suffix}`,
        signal: new AbortController().signal,
        locale: "en",
      };
      const content = await mailCapabilities.queries["draft.send.review"].run(
        { draftId: stored!.short_id, expectedRevision: draft.data.revision },
        capabilityContext,
      );
      if (!content.ok) throw new Error(content.error.message);
      const review = content.data.data;
      const sent = await mailCapabilities.actions["draft.send"].run(
        {
          draftId: stored!.short_id,
          senderIdentityId: senderIdentityShortId,
          expectedRevision: draft.data.revision,
          expectedContentHash: review.contentHash,
          safetyApproval: {
            revision: review.revision,
            fingerprint: review.fingerprint,
            warningIds: review.warnings.map((warning) => warning.id),
          },
          undoSeconds: 0,
        },
        capabilityContext,
      );
      expect(sent).toMatchObject({ ok: true });
      const submissions = await sql<
        { draft_snapshot: { body: string } }[]
      >`SELECT draft_snapshot FROM mail.outbox_submissions WHERE draft_id = ${draft.data.id}::uuid`;
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.draft_snapshot.body).toBe("AI_GENERATED_AGENT_PROPOSAL");
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
    }
  });
});
