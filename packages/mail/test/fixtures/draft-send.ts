import { sql } from "@k2b/cloud";
import { encryptSecret } from "@k2b/cloud/services";

/** Real send authorization and transport metadata, with no provider worker or external delivery. */
export const prepareDraftSendBinding = async (mailboxId: string, senderId: string): Promise<void> => {
  const secret = await encryptSecret({ kind: "password", password: "draft-send-fixture" });
  const [connection] = await sql<{ id: string }[]>`
    INSERT INTO mail.provider_connections (
      owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
      smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
      authenticated_principal, capabilities, server_identity, last_verified_at
    ) VALUES (
      ${mailboxId}::uuid, 'Draft fixture', 'writer@example.test', 'writer@example.test',
      'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls',
      'password', ${secret}, 'writer@example.test', '{}'::jsonb, '{}'::jsonb, '2026-01-01T00:00:00Z'
    ) RETURNING id
  `;
  if (!connection) throw new Error("Missing draft send connection");
  const fingerprint = "a".repeat(64);
  const [resource] = await sql<{ id: string }[]>`
    INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
    VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active') RETURNING id
  `;
  if (!resource) throw new Error("Missing draft send resource");
  const [binding] = await sql<{ id: string }[]>`
    INSERT INTO mail.provider_bindings (
      remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
      verification_evidence, verified_scope_fingerprint, last_verified_at
    ) VALUES (
      ${resource.id}::uuid, ${connection.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, '{}'::jsonb, ${fingerprint}, '2026-01-01T00:00:00Z'
    ) RETURNING id
  `;
  if (!binding) throw new Error("Missing draft send binding");
  await sql`INSERT INTO mail.sender_identity_bindings
    (sender_identity_id, binding_id, provider_principal, verified_at, saves_sent_automatically)
    VALUES (${senderId}::uuid, ${binding.id}::uuid, 'writer@example.test', '2026-01-01T00:00:00Z', true)`;
};
