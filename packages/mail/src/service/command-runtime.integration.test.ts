import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { executeMutationCommand } from "./command-runtime";
import { createActorCommand } from "./commands";
import { imapSmtpConnector } from "./connectors";
import { createMailbox } from "./mailboxes";
import { createProviderConnection } from "./provider-connections";
import { MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex } from "./provider-operation-lock";

const suite = suiteFor("database", "nats");

const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: "Mail",
      sn: "Test",
      mail: `${user.uid}@example.com`,
      roles: ["admin", "user"],
      memberofGroupIds: [],
      memberofGroups: [],
      admin: true,
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-command-runtime-${user.uid}`,
});

const FOLDER_RIGHTS = ["read", "write_flags", "insert", "move", "delete_messages"];

const remoteFolder = (path: string, uidValidity: string, role: "inbox" | "archive") => ({
  stableKey: `${path}:${uidValidity}`,
  path,
  name: path,
  delimiter: "/",
  parentPath: null,
  role,
  subscribed: true,
  selectable: true,
  uidValidity,
  uidNext: "1",
  highestModseq: "1",
  rights: FOLDER_RIGHTS,
  rightsSource: "acl" as const,
});

/** A provider that supports neither MOVE nor UIDPLUS cannot remove the source of a move. */
const fixtureVerification = (): ConnectorVerification => ({
  authenticatedPrincipal: "runtime@example.com",
  serverIdentity: { serverInfo: { name: "fixture" } },
  capabilities: {
    idle: true,
    condstore: false,
    qresync: false,
    move: false,
    uidplus: false,
    namespace: true,
    listExtended: true,
    specialUse: true,
    acl: true,
    notify: false,
    quota: false,
    gmailExtensions: false,
  },
  limits: unavailableProviderLimitSnapshot(),
  accounts: [
    {
      id: "runtime@example.com",
      name: "Runtime fixture",
      locator: {},
      namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }],
    },
  ],
});

suite("mail command runtime provider safety", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let mailboxId = "";
  let bindingId = "";
  let inboxFolderId = "";
  let archiveFolderId = "";
  let adminContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const uid = `mail-command-runtime-${suffix}`;
    const [admin] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, true)
      RETURNING id, uid
    `;
    if (!admin) throw new Error("Failed to create the command runtime test user");
    userIds.push(admin.id);
    adminContext = contextFor(admin);

    const mailbox = await createMailbox(adminContext, { name: `Runtime ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;

    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockResolvedValue([
      remoteFolder("INBOX", "10", "inbox"),
      remoteFolder("Archive", "20", "archive"),
    ]);
    try {
      const connection = await createProviderConnection({
        context: adminContext,
        mailboxId,
        input: {
          name: `Runtime fixture ${suffix}`,
          email: "runtime@example.com",
          username: "runtime@example.com",
          imap: { host: "imap.example.com", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.com", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);

      const serverKey = sha256Json({
        host: "imap.example.com",
        port: 993,
        tlsMode: "implicit",
        serverInfo: { name: "fixture" },
      });
      const folders = [remoteFolder("INBOX", "10", "inbox"), remoteFolder("Archive", "20", "archive")];
      const evidence = {
        version: 1,
        serverKey,
        accountId: "runtime@example.com",
        namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }],
        folders: folders.map((folder) => ({
          relativePath: folder.path,
          parentRelativePath: null,
          name: folder.name,
          role: folder.role,
          remotePath: folder.path,
          delimiter: folder.delimiter,
          selectable: folder.selectable,
          subscribed: folder.subscribed,
          uidValidity: folder.uidValidity,
          uidNext: folder.uidNext,
          highestModseq: folder.highestModseq,
          rights: folder.rights,
          rightsSource: folder.rightsSource,
        })),
      };
      const scope = sha256Json(evidence);
      const [resource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (
          mailbox_id, remote_locator, server_identity, scope_fingerprint, status, discovery_generation
        )
        VALUES (${mailboxId}::uuid, ${{ accountId: "runtime@example.com" }}::jsonb, '{}'::jsonb, ${scope}, 'active', 0)
        RETURNING id
      `;
      const [binding] = await sql<{ id: string }[]>`
        INSERT INTO mail.provider_bindings (
          remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
          capabilities, rights, verification_evidence, verified_scope_fingerprint,
          verified_secret_revision, last_verified_at
        )
        VALUES (
          ${resource!.id}::uuid, ${connection.data.connection.id}::uuid, 'active', 'runtime@example.com',
          ${{ accountId: "runtime@example.com" }}::jsonb,
          ${fixtureVerification().capabilities}::jsonb, '{}'::jsonb,
          ${evidence}::jsonb, ${scope}, 1, now()
        )
        RETURNING id
      `;
      bindingId = binding!.id;
      await rediscoverProviderBinding({ bindingId });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }

    const [inbox] = await sql<{ id: string }[]>`
      SELECT folder.id
      FROM mail.folders folder
      JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
      WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path = 'INBOX'
    `;
    const [archive] = await sql<{ id: string }[]>`
      SELECT folder.id
      FROM mail.folders folder
      JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
      WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path = 'Archive'
    `;
    if (!inbox || !archive) throw new Error("Failed to discover the command runtime fixture folders");
    inboxFolderId = inbox.id;
    archiveFolderId = archive.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      if (access.length > 0) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((item) => item.access_id)}::jsonb))
        `;
      }
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("refuses a move when the provider cannot remove the source", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<unsafe-move-${suffix}@example.com>`},
        'Unsafe move',
        now(),
        1,
        ${sha256Json({ fixture: "unsafe-move", suffix })},
        'complete'
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxFolderId}::uuid, ${message!.id}::uuid, 10, 424242)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${remoteRef!.id}::uuid, ${inboxFolderId}::uuid, ${message!.id}::uuid)
    `;

    const providerState = spyOn(imapSmtpConnector, "getMessageState").mockResolvedValue({
      exists: true,
      flags: [],
      keywords: [],
      messageId: `<unsafe-move-${suffix}@example.com>`,
      modseq: "1",
    });
    const move = spyOn(imapSmtpConnector, "move").mockRejectedValue(new Error("an unsafe move reached the provider"));
    const copy = spyOn(imapSmtpConnector, "copy").mockRejectedValue(new Error("an unsafe move reached the provider"));
    try {
      const command = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "move",
          messageId: message!.id,
          sourceFolderId: inboxFolderId,
          destinationFolderId: archiveFolderId,
          idempotencyKey: `unsafe-move-${suffix}`,
        },
      });
      expect(command.ok).toBe(true);
      if (!command.ok) return;
      const outcome = await executeMutationCommand(command.data.id);
      expect(move).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      const [state] = await sql<{ state: string; last_error_code: string | null; provider_effect_started_at: Date | null }[]>`
        SELECT state, last_error_code, provider_effect_started_at FROM mail.commands WHERE id = ${command.data.id}::uuid
      `;
      expect({ outcome, code: state?.last_error_code }).toEqual({ outcome: "failed", code: "SAFE_MOVE_UNSUPPORTED" });
      expect(state?.provider_effect_started_at).toBeNull();
      const [placement] = await sql<{ folder_id: string; deleted_at: Date | null; stale_at: Date | null }[]>`
        SELECT placement.folder_id, placement.deleted_at, ref.stale_at
        FROM mail.message_placements placement
        JOIN mail.remote_message_refs ref ON ref.id = placement.remote_message_ref_id
        WHERE placement.remote_message_ref_id = ${remoteRef!.id}::uuid
      `;
      expect(placement).toEqual({ folder_id: inboxFolderId, deleted_at: null, stale_at: null });
    } finally {
      copy.mockRestore();
      move.mockRestore();
      providerState.mockRestore();
    }
  }, 15_000);
  test("keeps an ambiguous command ambiguous when the remote resource is busy", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<busy-requeue-${suffix}@example.com>`},
        'Busy requeue',
        now(),
        1,
        ${sha256Json({ fixture: "busy-requeue", suffix })},
        'complete'
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxFolderId}::uuid, ${message!.id}::uuid, 10, 424243)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${remoteRef!.id}::uuid, ${inboxFolderId}::uuid, ${message!.id}::uuid)
    `;
    const [ambiguous] = await sql<{ id: string }[]>`
      INSERT INTO mail.commands (
        mailbox_id, kind, state, actor_kind, actor_id, idempotency_key, request_hash,
        target, payload, selected_binding_id, selected_secret_revision, rights_snapshot,
        attempt, access_subject_kind, access_subject_id, credential_scopes
      ) VALUES (
        ${mailboxId}::uuid, 'set_flags', 'ambiguous', 'user', ${userIds[0]}::uuid,
        ${`busy-requeue-${suffix}`}, ${sha256Json({ fixture: "busy-requeue-command", suffix })},
        ${{ remoteMessageRefId: remoteRef!.id, folderId: inboxFolderId }}::jsonb,
        ${{ flags: ["\\Seen"] }}::jsonb,
        ${bindingId}::uuid, 1, ${{ folders: { [inboxFolderId]: ["write_flags"] } }}::jsonb,
        1, 'user', ${userIds[0]}::uuid, ARRAY[]::text[]
      ) RETURNING id
    `;
    const [resource] = await sql<{ id: string }[]>`
      SELECT remote_resource_id AS id FROM mail.provider_bindings WHERE id = ${bindingId}::uuid
    `;
    const held = await mailProviderOperationMutex().acquire({
      resource: resource!.id,
      ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    });
    expect(held).not.toBeNull();
    if (!held) return;
    try {
      // A requeue that never reached the provider must not turn reconciliation into a fresh replay.
      expect(await executeMutationCommand(ambiguous!.id)).toBe("ambiguous");
      const [state] = await sql<{ state: string; attempt: number; last_error_code: string | null }[]>`
        SELECT state, attempt, last_error_code FROM mail.commands WHERE id = ${ambiguous!.id}::uuid
      `;
      expect(state).toEqual({ state: "ambiguous", attempt: 1, last_error_code: "REMOTE_RESOURCE_BUSY" });
    } finally {
      await mailProviderOperationMutex().release(held);
    }
  }, 15_000);
});
