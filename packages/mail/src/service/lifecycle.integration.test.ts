import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { lazySync } from "@valentinkolb/cloud";
import { syncOps } from "@valentinkolb/cloud/services";
import type { WorkflowBoundPlan } from "@valentinkolb/cloud/workflows";
import {
  claimWorkflowRun,
  createWorkflow as createKernelWorkflow,
  createWorkflowRun,
  createWorkflowRuntimeRepository,
  finishWorkflowRun,
  publishWorkflowVersion,
} from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, revokeMailboxAccess, updateMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { attachProviderBinding, rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { executeMutationCommand } from "./command-runtime";
import { createActorCommand, createMailCommand, createWorkflowCommand } from "./commands";
import { imapSmtpConnector } from "./connectors";
import { resolveMailExecution } from "./execution";
import {
  clearFolderRole,
  dismissUnavailableFolder,
  listAdminFolders,
  resolveRoleFolder,
  setFolderRole,
  setFolderSidebarVisibility,
} from "./folders";
import { getMailboxOperationalHealth } from "./health";
import { createMailbox, updateMailbox } from "./mailboxes";
import {
  executeMaintenanceCommand,
  startMaintenanceRuntime,
  stopMaintenanceRuntime,
  submitDueMaintenanceCommands,
} from "./maintenance-runtime";
import { getMailboxOperations, getPlatformMailOperations } from "./operations";
import { executeOperatorAction } from "./operator-actions";
import { createProviderConnection } from "./provider-connections";
import {
  createSenderIdentity,
  disableSenderIdentity,
  setupDefaultSender,
  updateSenderIdentity,
  verifySenderIdentity,
} from "./sender-identities";
import {
  deleteSenderIdentityTransport,
  loadSenderIdentityTransportRuntime,
  upsertSenderIdentityTransport,
} from "./sender-identity-transports";
import { claimFence, commitSyncBatch, executeBindingRediscovery, hydrateMessageBatch } from "./sync-runtime";
import { createConversationTriageCommands } from "./triage";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;

const contextFor = (user: { id: string; uid: string; admin: boolean }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: user.uid,
      sn: "Test",
      mail: `${user.uid}@example.com`,
      roles: user.admin ? ["admin", "user"] : ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
      admin: user.admin,
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-lifecycle-${user.uid}`,
});

const fixtureVerification = (): ConnectorVerification => ({
  authenticatedPrincipal: "lifecycle@example.com",
  serverIdentity: { serverInfo: { name: "fixture" } },
  capabilities: {
    idle: true,
    condstore: true,
    qresync: true,
    move: true,
    uidplus: true,
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
      id: "lifecycle@example.com",
      name: "Lifecycle fixture",
      locator: {},
      namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }],
    },
  ],
});

const remoteFolder = (
  path: string,
  uidValidity: string,
  role: "inbox" | "other" = "other",
  rights = ["read", "write_flags", "insert", "move", "delete_messages"],
) => ({
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
  rights,
  rightsSource: "acl" as const,
});

suite("mail lifecycle control plane", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: string[] = [];
  const accessIds: string[] = [];
  let mailboxId = "";
  let mailboxShortId = "";
  let connectionId = "";
  let bindingId = "";
  let inboxFolderId = "";
  let inboxFolderShortId = "";
  let adminContext: MailRequestContext;
  let collaboratorContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const [admin] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-lifecycle-admin-${suffix}`}, 'local', 'user', 'Mail Lifecycle Admin', true)
      RETURNING id, uid
    `;
    const [collaborator] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-lifecycle-user-${suffix}`}, 'local', 'user', 'Mail Lifecycle User', false)
      RETURNING id, uid
    `;
    if (!admin || !collaborator) throw new Error("Failed to create mail lifecycle users");
    users.push(admin.id, collaborator.id);
    adminContext = contextFor({ ...admin, admin: true });
    collaboratorContext = contextFor({ ...collaborator, admin: false });

    const mailbox = await createMailbox(adminContext, {
      name: `Lifecycle ${suffix}`,
    });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mailboxIdentity] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
    `;
    if (!mailboxIdentity) throw new Error("Mailbox public ID was not created");
    mailboxShortId = mailboxIdentity.short_id;
    const readAccess = await grantMailboxAccess({
      context: adminContext,
      mailboxId,
      principal: { type: "user", userId: collaborator.id },
      permission: "read",
    });
    if (!readAccess.ok) throw new Error(readAccess.error.message);
    accessIds.push(readAccess.data.id);

    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    try {
      const connection = await createProviderConnection({
        context: adminContext,
        mailboxId,
        input: {
          name: `Lifecycle fixture ${suffix}`,
          email: "lifecycle@example.com",
          username: "lifecycle@example.com",
          imap: { host: "imap.example.com", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.com", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);
      connectionId = connection.data.connection.id;
    } finally {
      verify.mockRestore();
    }

    const serverKey = sha256Json({
      host: "imap.example.com",
      port: 993,
      tlsMode: "implicit",
      serverInfo: { name: "fixture" },
    });
    const initialFolders = [remoteFolder("INBOX", "10", "inbox"), remoteFolder("Projects", "20")];
    const evidence = {
      version: 1,
      serverKey,
      accountId: "lifecycle@example.com",
      namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }],
      folders: initialFolders.map((folder) => ({
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
      VALUES (${mailboxId}::uuid, ${{
        accountId: "lifecycle@example.com",
      }}::jsonb, '{}'::jsonb, ${scope}, 'active', 0)
      RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
        capabilities, rights, verification_evidence, verified_scope_fingerprint,
        verified_secret_revision, last_verified_at
      )
      VALUES (
        ${resource!.id}::uuid, ${connectionId}::uuid, 'active', 'lifecycle@example.com',
        ${{
          accountId: "lifecycle@example.com",
        }}::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${evidence}::jsonb, ${scope}, 1, now()
      )
      RETURNING id
    `;
    bindingId = binding!.id;
  });

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    }
    if (users.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${users}::jsonb))`;
    }
  });

  test("binding attach waits for the mailbox provider barrier before remote verification", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockResolvedValue([remoteFolder("INBOX", "10", "inbox")]);
    const barrierMutex = lazySync((sync) =>
      sync.mutex({
        id: "mail:remote-resource-sync",
        ttlMs: 30_000,
        retry: { maxAttempts: 1 },
      }),
    );
    const heldBarrier = await barrierMutex().acquire({ resource: `mailbox:${mailboxId}`, ttlMs: 30_000 });
    expect(heldBarrier).not.toBeNull();
    if (!heldBarrier) {
      discover.mockRestore();
      verify.mockRestore();
      return;
    }

    try {
      const attachment = attachProviderBinding({
        context: adminContext,
        mailboxId,
        connectionId,
      });
      try {
        await Bun.sleep(100);
        expect(verify).not.toHaveBeenCalled();
        expect(discover).not.toHaveBeenCalled();
      } finally {
        await barrierMutex().release(heldBarrier);
      }

      const result = await attachment;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFLICT");
      expect(verify).toHaveBeenCalledTimes(1);
      expect(discover).toHaveBeenCalledTimes(1);
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
  }, 15_000);

  test("a disabled sender identity cannot be verified or trigger SMTP", async () => {
    const identity = await createSenderIdentity({
      context: adminContext,
      mailboxId,
      input: {
        label: "Disabled sender",
        displayName: "Disabled sender",
        fromAddress: `disabled-${suffix}@example.com`,
        defaultCc: [],
        authenticationPolicy: { automation: "disabled" },
        isDefault: false,
      },
    });
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(
      (
        await disableSenderIdentity({
          context: adminContext,
          mailboxId,
          senderIdentityId: identity.data.id,
        })
      ).ok,
    ).toBe(true);

    const send = spyOn(imapSmtpConnector, "send").mockRejectedValue(new Error("disabled sender reached SMTP"));
    try {
      const verified = await verifySenderIdentity({
        context: adminContext,
        mailboxId,
        senderIdentityId: identity.data.id,
        bindingId,
        verificationRecipient: `disabled-${suffix}@example.com`,
        savesSentAutomatically: true,
      });
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.error.code).toBe("NOT_FOUND");
      expect(send).not.toHaveBeenCalled();
      const [status] = await sql<{ status: string }[]>`
        SELECT status FROM mail.sender_identities WHERE id = ${identity.data.id}::uuid
      `;
      expect(status?.status).toBe("disabled");
    } finally {
      send.mockRestore();
    }
  });

  test("allows distinct identities to share one From address", async () => {
    const fromAddress = `shared-${suffix}@example.com`;
    const first = await createSenderIdentity({
      context: adminContext,
      mailboxId,
      input: {
        label: "Personal",
        displayName: "Valentin",
        fromAddress,
        defaultCc: [],
        authenticationPolicy: { automation: "disabled" },
        isDefault: false,
      },
    });
    const second = await createSenderIdentity({
      context: adminContext,
      mailboxId,
      input: {
        label: "Organization",
        displayName: "Organization Team",
        fromAddress,
        defaultCc: [{ name: "Archive", address: "archive@example.com" }],
        authenticationPolicy: { automation: "disabled" },
        isDefault: false,
      },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.id).not.toBe(second.data.id);
    expect(second.data).toMatchObject({
      label: "Organization",
      fromAddress,
      defaultCc: [{ name: "Archive", address: "archive@example.com" }],
      defaultSignatureTemplateId: null,
    });
  });

  test("fences custom identity transport updates and never exposes credentials", async () => {
    const identity = await createSenderIdentity({
      context: adminContext,
      mailboxId,
      input: {
        label: "Custom SMTP",
        displayName: "Custom SMTP",
        fromAddress: `custom-smtp-${suffix}@example.com`,
        defaultCc: [],
        authenticationPolicy: { automation: "disabled" },
        isDefault: false,
      },
    });
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;

    const verifySmtp = spyOn(imapSmtpConnector, "verifySmtp").mockResolvedValue({
      dsn: true,
      size: true,
      maxMessageBytes: 25_000_000,
    });
    try {
      const created = await upsertSenderIdentityTransport({
        context: adminContext,
        mailboxId,
        senderIdentityId: identity.data.id,
        input: {
          expectedRevision: 0,
          host: "smtp-a.example.com",
          port: 587,
          tlsMode: "starttls",
          username: "smtp-user",
          secret: { kind: "password", password: "smtp-secret-a" },
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data).toMatchObject({
        mode: "custom",
        host: "smtp-a.example.com",
        revision: 1,
        secret: { kind: "password", isSet: true },
        capabilities: { dsn: true },
      });
      expect(JSON.stringify(created.data)).not.toContain("smtp-secret-a");

      const stale = await upsertSenderIdentityTransport({
        context: adminContext,
        mailboxId,
        senderIdentityId: identity.data.id,
        input: {
          expectedRevision: 0,
          host: "smtp-stale.example.com",
          port: 587,
          tlsMode: "starttls",
          username: "smtp-user",
        },
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

      const updated = await upsertSenderIdentityTransport({
        context: adminContext,
        mailboxId,
        senderIdentityId: identity.data.id,
        input: {
          expectedRevision: 1,
          host: "smtp-b.example.com",
          port: 465,
          tlsMode: "implicit",
          username: "smtp-user",
        },
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.data).toMatchObject({ host: "smtp-b.example.com", port: 465, revision: 2 });

      expect(
        await loadSenderIdentityTransportRuntime({
          mailboxId,
          senderIdentityId: identity.data.id,
          expectedRevision: 1,
        }),
      ).toBeNull();
      const runtime = await loadSenderIdentityTransportRuntime({
        mailboxId,
        senderIdentityId: identity.data.id,
        expectedRevision: 2,
      });
      expect(runtime).toMatchObject({
        revision: 2,
        runtime: {
          username: "smtp-user",
          smtp: { host: "smtp-b.example.com", port: 465, tlsMode: "implicit" },
          secret: { kind: "password", password: "smtp-secret-a" },
        },
      });

      const forbidden = await upsertSenderIdentityTransport({
        context: collaboratorContext,
        mailboxId,
        senderIdentityId: identity.data.id,
        input: {
          expectedRevision: 2,
          host: "smtp-c.example.com",
          port: 587,
          tlsMode: "starttls",
          username: "smtp-user",
        },
      });
      expect(forbidden).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

      expect(
        await deleteSenderIdentityTransport({
          context: adminContext,
          mailboxId,
          senderIdentityId: identity.data.id,
          expectedRevision: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      const removed = await deleteSenderIdentityTransport({
        context: adminContext,
        mailboxId,
        senderIdentityId: identity.data.id,
        expectedRevision: 2,
      });
      expect(removed).toMatchObject({ ok: true, data: { mode: "mailbox", revision: 0 } });
    } finally {
      verifySmtp.mockRestore();
    }
  });

  test("rejects an unavailable default signature without creating a partial identity", async () => {
    const label = `Invalid signature ${suffix}`;
    const created = await createSenderIdentity({
      context: adminContext,
      mailboxId,
      input: {
        label,
        displayName: "Invalid signature",
        fromAddress: `invalid-signature-${suffix}@example.com`,
        defaultCc: [],
        defaultSignatureTemplateId: crypto.randomUUID(),
        authenticationPolicy: { automation: "disabled" },
        isDefault: false,
      },
    });
    expect(created).toMatchObject({
      ok: false,
      error: { status: 400, message: "The selected mailbox signature is not available" },
    });
    const [identity] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.sender_identities
      WHERE mailbox_id = ${mailboxId}::uuid AND label = ${label}
    `;
    expect(identity?.count).toBe(0);
  });

  test("sender automation policy changes preserve provider verification", async () => {
    const identity = await createSenderIdentity({
      context: adminContext,
      mailboxId,
      input: {
        label: "Automation policy sender",
        displayName: "Automation policy sender",
        fromAddress: `automation-${suffix}@example.com`,
        defaultCc: [],
        authenticationPolicy: { automation: "disabled" },
        isDefault: false,
      },
    });
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    await sql`UPDATE mail.sender_identities SET status = 'verified' WHERE id = ${identity.data.id}::uuid`;
    await sql`
      INSERT INTO mail.sender_identity_bindings (
        sender_identity_id, binding_id, provider_principal, verified_at, verified_secret_revision
      )
      SELECT id, ${bindingId}::uuid, ${identity.data.fromAddress}, now(), 1
      FROM mail.sender_identities WHERE id = ${identity.data.id}::uuid
    `;

    const updated = await updateSenderIdentity({
      context: adminContext,
      mailboxId,
      senderIdentityId: identity.data.id,
      input: { authenticationPolicy: { automation: "mailbox" } },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.status).toBe("verified");
    expect(updated.data.authenticationPolicy).toEqual({
      automation: "mailbox",
    });
    const [binding] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at
      FROM mail.sender_identity_bindings
      WHERE sender_identity_id = (SELECT id FROM mail.sender_identities WHERE id = ${identity.data.id}::uuid)
        AND binding_id = ${bindingId}::uuid
    `;
    expect(binding?.revoked_at).toBeNull();

    const rejected = await updateSenderIdentity({
      context: adminContext,
      mailboxId,
      senderIdentityId: identity.data.id,
      input: {
        fromAddress: `changed-${suffix}@example.com`,
        defaultSignatureTemplateId: crypto.randomUUID(),
      },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { status: 400, message: "The selected mailbox signature is not available" },
    });
    const [rolledBack] = await sql<{ from_address: string; status: string; revoked_at: Date | null }[]>`
      SELECT identity.from_address, identity.status, identity_binding.revoked_at
      FROM mail.sender_identities identity
      JOIN mail.sender_identity_bindings identity_binding ON identity_binding.sender_identity_id = identity.id
      WHERE identity.id = ${identity.data.id}::uuid
        AND identity_binding.binding_id = ${bindingId}::uuid
    `;
    expect(rolledBack).toMatchObject({
      from_address: identity.data.fromAddress,
      status: "verified",
      revoked_at: null,
    });
  });

  test("default sender setup preserves receiving and supports both Sent delivery models", async () => {
    const identity = await createSenderIdentity({
      context: adminContext,
      mailboxId,
      input: {
        label: "Provider default sender",
        displayName: "Provider default sender",
        fromAddress: "lifecycle@example.com",
        defaultCc: [],
        authenticationPolicy: { automation: "disabled" },
        isDefault: false,
      },
    });
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    await sql`UPDATE mail.sender_identities SET status = 'verified' WHERE id = ${identity.data.id}::uuid`;
    await sql`
      INSERT INTO mail.sender_identity_bindings (
        sender_identity_id, binding_id, provider_principal, saves_sent_automatically,
        verified_at, verified_secret_revision
      )
      SELECT id, ${bindingId}::uuid, ${identity.data.fromAddress}, true, now(), 1
      FROM mail.sender_identities WHERE id = ${identity.data.id}::uuid
    `;

    const providerManaged = await setupDefaultSender({
      context: adminContext,
      mailboxId,
      input: { bindingId, savesSentAutomatically: true },
    });
    expect(providerManaged.ok).toBe(true);
    if (!providerManaged.ok) return;
    expect(providerManaged.data.status).toBe("verified");
    expect(providerManaged.data.isDefault).toBe(true);
    expect(providerManaged.data.authenticationPolicy).toEqual({
      automation: "disabled",
    });

    const [resource] = await sql<{ id: string }[]>`
      SELECT remote_resource_id AS id
      FROM mail.provider_bindings
      WHERE id = ${bindingId}::uuid
    `;
    const [sentFolder] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.folders (short_id,
        remote_resource_id, stable_key, name, role, selectable, selected_for_sync, sync_status
      )
      VALUES (${newShortId()},
        ${resource!.id}::uuid, ${`sender-sent-${suffix}`}, 'Sent fixture', 'sent', true, true, 'current'
      )
      RETURNING id, short_id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, delimiter, subscribed, effective_rights, rights_source, last_verified_at
      )
      VALUES (
        ${bindingId}::uuid, ${sentFolder!.id}::uuid, 'Sent fixture', '/', true,
        ARRAY['read', 'insert']::text[], 'acl', now()
      )
    `;

    let rejectVerification = false;
    const send = spyOn(imapSmtpConnector, "send").mockImplementation(async (_connection, request) => {
      if (rejectVerification) throw new Error("fixture sender rejection");
      return {
        accepted: request.to.map((recipient) => recipient.address),
        rejected: [],
        response: "250 accepted",
        messageId: request.messageId,
      };
    });
    try {
      const appended = await setupDefaultSender({
        context: adminContext,
        mailboxId,
        input: { bindingId, savesSentAutomatically: false },
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;
      expect(appended.data.id).toBe(identity.data.id);
      expect(appended.data.sentFolderId).toBe(sentFolder!.id);

      await sql`
        UPDATE mail.sender_identity_bindings
        SET saves_sent_automatically = true
        WHERE sender_identity_id = (SELECT id FROM mail.sender_identities WHERE id = ${identity.data.id}::uuid)
          AND binding_id = ${bindingId}::uuid
      `;
      await sql`
        UPDATE mail.binding_folder_refs
        SET effective_rights = ARRAY['read']::text[]
        WHERE binding_id = ${bindingId}::uuid AND folder_id = ${sentFolder!.id}::uuid
      `;
      const missingAppendRight = await setupDefaultSender({
        context: adminContext,
        mailboxId,
        input: { bindingId, savesSentAutomatically: false },
      });
      expect(missingAppendRight).toMatchObject({
        ok: false,
        error: { status: 400, message: "The selected binding cannot append to the configured Sent folder" },
      });
      const [activeBinding] = await sql<{ state: string }[]>`
        SELECT state FROM mail.provider_bindings WHERE id = ${bindingId}::uuid
      `;
      expect(activeBinding?.state).toBe("active");

      const stillProviderManaged = await setupDefaultSender({
        context: adminContext,
        mailboxId,
        input: { bindingId, savesSentAutomatically: true },
      });
      expect(stillProviderManaged.ok).toBe(true);

      await sql`
        UPDATE mail.sender_identity_bindings
        SET saves_sent_automatically = false
        WHERE sender_identity_id = (SELECT id FROM mail.sender_identities WHERE id = ${identity.data.id}::uuid)
          AND binding_id = ${bindingId}::uuid
      `;
      rejectVerification = true;
      const rejected = await setupDefaultSender({
        context: adminContext,
        mailboxId,
        input: { bindingId, savesSentAutomatically: true },
      });
      expect(rejected.ok).toBe(false);
      const [rejectedIdentity] = await sql<{ status: string }[]>`
        SELECT status FROM mail.sender_identities WHERE id = ${identity.data.id}::uuid
      `;
      expect(rejectedIdentity?.status).toBe("rejected");

      rejectVerification = false;
      const retried = await setupDefaultSender({
        context: adminContext,
        mailboxId,
        input: { bindingId, savesSentAutomatically: true },
      });
      expect(retried.ok).toBe(true);
      if (retried.ok) {
        expect(retried.data.id).toBe(identity.data.id);
        expect(retried.data.status).toBe("verified");
      }
    } finally {
      send.mockRestore();
      await sql`DELETE FROM mail.folders WHERE id = ${sentFolder!.id}::uuid`;
    }
  });

  test("rediscovery projects ACL rights and conservatively reconciles rename and removal", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockResolvedValue([
      remoteFolder("INBOX", "10", "inbox"),
      { ...remoteFolder("Projects", "20"), subscribed: false },
    ]);
    try {
      const first = await rediscoverProviderBinding({ bindingId });
      expect(first).toMatchObject({
        discovered: 2,
        missing: 0,
        ambiguous: 0,
        rightsSources: { acl: 2 },
      });
      const [inbox] = await sql<{ id: string; short_id: string }[]>`
        SELECT folder.id, folder.short_id
        FROM mail.folders folder
        JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
        WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path = 'INBOX'
      `;
      inboxFolderId = inbox!.id;
      inboxFolderShortId = inbox!.id;
      const [project] = await sql<{ id: string; show_in_sidebar: boolean; subscribed: boolean }[]>`
        SELECT folder.id, folder.show_in_sidebar, ref.subscribed
        FROM mail.folders folder
        JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
        WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path = 'Projects'
      `;
      expect(project).toMatchObject({
        show_in_sidebar: false,
        subscribed: false,
      });
      const visibleProject = await setFolderSidebarVisibility({
        context: adminContext,
        mailboxId,
        folderId: project!.id,
        showInSidebar: true,
      });
      expect(visibleProject.ok).toBe(true);

      discover.mockResolvedValue([remoteFolder("INBOX", "10", "inbox"), remoteFolder("Clients", "20")]);
      const renamed = await rediscoverProviderBinding({ bindingId });
      expect(renamed.renamed).toBe(1);
      const [renamedProject] = await sql<{ id: string; rights_source: string; namespace_kind: string | null; show_in_sidebar: boolean }[]>`
        SELECT folder.id, ref.rights_source, ref.namespace_kind, folder.show_in_sidebar
        FROM mail.folders folder
        JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
        WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path = 'Clients'
      `;
      expect(renamedProject).toEqual({
        id: project!.id,
        rights_source: "acl",
        namespace_kind: "personal",
        show_in_sidebar: true,
      });

      discover.mockResolvedValue([remoteFolder("INBOX", "10", "inbox"), remoteFolder("Active", "20"), remoteFolder("Clients", "40")]);
      const renamedAndRecreated = await rediscoverProviderBinding({
        bindingId,
      });
      expect(renamedAndRecreated.renamed).toBe(1);
      const recreatedFolders = await sql<{ id: string; remote_path: string; uid_validity: string }[]>`
        SELECT folder.id, ref.remote_path, ref.uid_validity::text
        FROM mail.folders folder
        JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
        WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path IN ('Active', 'Clients')
        ORDER BY ref.uid_validity
      `;
      expect(recreatedFolders[0]).toEqual({
        id: project!.id,
        remote_path: "Active",
        uid_validity: "20",
      });
      expect(recreatedFolders[1]).toMatchObject({
        remote_path: "Clients",
        uid_validity: "40",
      });
      expect(recreatedFolders[1]?.id).not.toBe(project!.id);
      const replacementFolderId = recreatedFolders[1]!.id;

      const [resource] = await sql<{ remote_resource_id: string; discovery_generation: number }[]>`
        SELECT binding.remote_resource_id, resource.discovery_generation
        FROM mail.provider_bindings binding
        JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
        WHERE binding.id = ${bindingId}::uuid
      `;
      const [staleArchive] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id,
          remote_resource_id, stable_key, name, role, selectable, selected_for_sync,
          discovery_generation, discovery_state, missing_since, sync_status
        )
        VALUES (${newShortId()},
          ${resource!.remote_resource_id}::uuid,
          ${sha256Json({ version: 1, relativePath: "Archive" })},
          'Archive',
          'other',
          true,
          true,
          ${resource!.discovery_generation},
          'missing',
          now(),
          'excluded'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, delimiter, uid_validity, uid_next,
          subscribed, effective_rights, rights_source, last_seen_generation, missing_since
        )
        VALUES (
          ${bindingId}::uuid,
          ${staleArchive!.id}::uuid,
          'Archive',
          '/',
          30,
          1,
          true,
          ARRAY[]::text[],
          'unknown',
          ${resource!.discovery_generation},
          now()
        )
      `;
      discover.mockResolvedValue([remoteFolder("INBOX", "10", "inbox"), remoteFolder("Archive", "20"), remoteFolder("Clients", "40")]);
      const conflictedRename = await rediscoverProviderBinding({ bindingId });
      expect(conflictedRename).toMatchObject({ ambiguous: 2, renamed: 0 });
      const [conflictedHealth] = await sql<{ health: string }[]>`
        SELECT health FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
      `;
      expect(conflictedHealth?.health).toBe("degraded");
      const conflictingFolders = await sql<
        {
          id: string;
          discovery_state: string;
          remote_path: string;
          uid_validity: string;
        }[]
      >`
        SELECT folder.id, folder.discovery_state, ref.remote_path, ref.uid_validity::text
        FROM mail.folders folder
        JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id AND ref.binding_id = ${bindingId}::uuid
        WHERE folder.id IN (${project!.id}::uuid, ${staleArchive!.id}::uuid)
        ORDER BY ref.uid_validity
      `;
      expect(conflictingFolders).toEqual([
        {
          id: project!.id,
          discovery_state: "ambiguous",
          remote_path: "Active",
          uid_validity: "20",
        },
        {
          id: staleArchive!.id,
          discovery_state: "ambiguous",
          remote_path: "Archive",
          uid_validity: "30",
        },
      ]);
      await sql`DELETE FROM mail.folders WHERE id = ${staleArchive!.id}::uuid`;

      discover.mockResolvedValue([remoteFolder("INBOX", "10", "inbox"), remoteFolder("Clients", "40")]);
      const removed = await rediscoverProviderBinding({ bindingId });
      expect(removed.missing).toBe(1);
      const [missing] = await sql<
        {
          discovery_state: string;
          selected_for_sync: boolean;
          missing_since: Date | null;
        }[]
      >`
        SELECT discovery_state, selected_for_sync, missing_since
        FROM mail.folders
        WHERE id = ${project!.id}::uuid
      `;
      expect(missing?.discovery_state).toBe("missing");
      expect(missing?.selected_for_sync).toBe(false);
      expect(missing?.missing_since).toBeInstanceOf(Date);
      await sql`DELETE FROM mail.folders WHERE id = ${replacementFolderId}::uuid`;
      discover.mockResolvedValue([remoteFolder("INBOX", "10", "inbox")]);
      await rediscoverProviderBinding({ bindingId });

      await sql`
        UPDATE mail.provider_bindings SET state = 'degraded', last_error_code = 'AUTHENTICATIONFAILED' WHERE id = ${bindingId}::uuid
      `;
      await sql`
        UPDATE mail.provider_connections SET status = 'degraded', last_error_code = 'AUTHENTICATIONFAILED' WHERE id = ${connectionId}::uuid
      `;
      await sql`UPDATE mail.mailboxes SET health = 'auth_required' WHERE id = ${mailboxId}::uuid`;
      await rediscoverProviderBinding({ bindingId });
      const [recovered] = await sql<
        {
          binding_state: string;
          connection_state: string;
          mailbox_health: string;
        }[]
      >`
        SELECT binding.state AS binding_state, connection.status AS connection_state, mailbox.health AS mailbox_health
        FROM mail.provider_bindings binding
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
        JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
        WHERE binding.id = ${bindingId}::uuid
      `;
      expect(recovered).toEqual({
        binding_state: "active",
        connection_state: "active",
        mailbox_health: "bootstrapping",
      });

      discover.mockImplementation(async () => {
        await Bun.sleep(75);
        return [remoteFolder("INBOX", "10", "inbox")];
      });
      const concurrent = await Promise.allSettled([
        executeBindingRediscovery(bindingId, false, async () => undefined),
        executeBindingRediscovery(bindingId, false, async () => undefined),
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = concurrent.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({ code: "SYNC_BUSY" });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
  }, 15_000);

  test("an ACL downgrade disables remote execution for the affected folder", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockResolvedValue([remoteFolder("INBOX", "10", "inbox", [])]);
    try {
      await rediscoverProviderBinding({ bindingId });
      const [inbox] = await sql<
        {
          selected_for_sync: boolean;
          sync_status: string;
          discovery_state: string;
        }[]
      >`
        SELECT selected_for_sync, sync_status, discovery_state
        FROM mail.folders
        WHERE id = ${inboxFolderId}::uuid
      `;
      expect(inbox).toEqual({
        selected_for_sync: false,
        sync_status: "excluded",
        discovery_state: "active",
      });
      const execution = await resolveMailExecution({
        context: adminContext,
        mailboxId,
        operation: "actorMutation",
        folderRequirements: [{ folderId: inboxFolderId, rights: ["write_flags"] }],
      });
      expect(execution.ok).toBe(false);
    } finally {
      discover.mockRestore();
      verify.mockRestore();
      await sql`
        UPDATE mail.folders
        SET selected_for_sync = true, sync_status = 'pending'
        WHERE id = ${inboxFolderId}::uuid
      `;
    }
  });

  test("an in-flight rediscovery cannot overwrite a newer credential revision", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => {
      await Bun.sleep(75);
      return [remoteFolder("INBOX", "10", "inbox")];
    });
    try {
      const rediscovery = rediscoverProviderBinding({ bindingId });
      await Bun.sleep(15);
      await sql.begin(async (tx) => {
        await tx`UPDATE mail.provider_connections SET secret_revision = 2 WHERE id = ${connectionId}::uuid`;
        await tx`
          UPDATE mail.provider_bindings
          SET
            state = 'pending',
            last_error_code = 'CREDENTIAL_REVERIFICATION_REQUIRED',
            last_error_message = 'newer credential revision'
          WHERE id = ${bindingId}::uuid
        `;
      });
      await expect(rediscovery).rejects.toMatchObject({
        code: "CREDENTIAL_REVISION_CHANGED",
      });
      const [binding] = await sql<{ state: string; last_error_code: string; last_error_message: string }[]>`
        SELECT state, last_error_code, last_error_message
        FROM mail.provider_bindings
        WHERE id = ${bindingId}::uuid
      `;
      expect(binding).toEqual({
        state: "pending",
        last_error_code: "CREDENTIAL_REVERIFICATION_REQUIRED",
        last_error_message: "newer credential revision",
      });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
      await sql.begin(async (tx) => {
        await tx`UPDATE mail.provider_connections SET secret_revision = 1 WHERE id = ${connectionId}::uuid`;
        await tx`
          UPDATE mail.provider_bindings
          SET state = 'active', last_error_code = NULL, last_error_message = NULL
          WHERE id = ${bindingId}::uuid
        `;
      });
    }
  });

  test("an in-flight rediscovery cannot reactivate a lifecycle-fenced mailbox", async () => {
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => {
      await Bun.sleep(75);
      return [remoteFolder("INBOX", "10", "inbox")];
    });
    const [resource] = await sql<{ id: string }[]>`
      SELECT remote_resource_id AS id FROM mail.provider_bindings WHERE id = ${bindingId}::uuid
    `;
    try {
      const rediscovery = rediscoverProviderBinding({ bindingId });
      await Bun.sleep(15);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE mail.mailboxes
          SET deleted_at = now(), sync_enabled = false, health = 'paused'
          WHERE id = ${mailboxId}::uuid
        `;
        await tx`
          UPDATE mail.remote_resources
          SET status = 'paused', sync_generation = sync_generation + 1
          WHERE id = ${resource!.id}::uuid
        `;
      });
      await expect(rediscovery).rejects.toMatchObject({
        code: "MAILBOX_TRANSPORT_CHANGED",
      });
      const [state] = await sql<{ status: string }[]>`
        SELECT status FROM mail.remote_resources WHERE id = ${resource!.id}::uuid
      `;
      expect(state?.status).toBe("paused");
    } finally {
      discover.mockRestore();
      verify.mockRestore();
      await sql.begin(async (tx) => {
        await tx`
          UPDATE mail.mailboxes
          SET deleted_at = NULL, sync_enabled = true, health = 'bootstrapping'
          WHERE id = ${mailboxId}::uuid
        `;
        await tx`
          UPDATE mail.remote_resources
          SET status = 'active', last_error_code = NULL, last_error_message = NULL
          WHERE id = ${resource!.id}::uuid
        `;
      });
    }
  });

  test("health remains readable when a mailbox has no active provider", async () => {
    const disconnected = await createMailbox(adminContext, {
      name: `Disconnected health ${suffix}`,
    });
    expect(disconnected.ok).toBe(true);
    if (!disconnected.ok) return;
    const [access] = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${disconnected.data.id}::uuid
    `;
    try {
      const health = await getMailboxOperationalHealth(adminContext, disconnected.data.id);
      expect(health.ok).toBe(true);
      if (health.ok) expect(health.data.bindings.total).toBe(0);
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${disconnected.data.id}::uuid`;
      if (access) await sql`DELETE FROM auth.access WHERE id = ${access.access_id}::uuid`;
    }
  });

  test("a newer sync fence rejects an older worker before commit", async () => {
    const [resource] = await sql<{ id: string }[]>`
      SELECT remote_resource_id AS id FROM mail.provider_bindings WHERE id = ${bindingId}::uuid
    `;
    const selectedFolders = await sql<{ id: string }[]>`
      UPDATE mail.folders
      SET selected_for_sync = false
      WHERE remote_resource_id = ${resource!.id}::uuid AND selected_for_sync = true
      RETURNING id
    `;
    const first = await claimFence(resource!.id, bindingId, "incremental");
    const second = await claimFence(resource!.id, bindingId, "incremental");
    try {
      await expect(
        commitSyncBatch({
          folder: {
            folder_id: inboxFolderId,
            mailbox_id: mailboxId,
            remote_resource_id: resource!.id,
            sync_generation: first.generation,
            envelope_cursor: {},
            role: "inbox",
          },
          folderId: inboxFolderId,
          bindingId,
          secretRevision: 1,
          fence: first,
          status: {
            uidValidity: "10",
            uidNext: 1,
            highestModseq: "1",
            messages: 0,
          },
          beforeCursor: null,
          cursor: {},
          uidValidityChanged: false,
          envelopeBatch: null,
          envelopeKind: null,
          flagChanges: [],
          reconcileWindow: null,
        } as never),
      ).rejects.toMatchObject({ code: "STALE_SYNC_FENCE" });
      const runs = await sql<{ id: string; state: string }[]>`
        SELECT id, state FROM mail.sync_runs WHERE id IN (${first.runId}::uuid, ${second.runId}::uuid) ORDER BY id
      `;
      expect(runs.find((run) => run.id === first.runId)?.state).toBe("stale_fence");
      expect(runs.find((run) => run.id === second.runId)?.state).toBe("running");
      await sql`UPDATE mail.mailboxes SET sync_enabled = false WHERE id = ${mailboxId}::uuid`;
      await expect(claimFence(resource!.id, bindingId, "incremental")).rejects.toMatchObject({ code: "MAILBOX_TRANSPORT_CHANGED" });
    } finally {
      await sql`UPDATE mail.mailboxes SET sync_enabled = true WHERE id = ${mailboxId}::uuid`;
      await sql`
        UPDATE mail.sync_runs SET state = 'completed', finished_at = now() WHERE id = ${second.runId}::uuid AND state = 'running'
      `;
      if (selectedFolders.length > 0) {
        await sql`
          UPDATE mail.folders
          SET selected_for_sync = true
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${selectedFolders.map((folder) => folder.id)}::jsonb))
        `;
      }
    }
  });

  test("a UIDVALIDITY reset retires old placements before the new generation is committed", async () => {
    const [resource] = await sql<{ id: string }[]>`
      SELECT remote_resource_id AS id FROM mail.provider_bindings WHERE id = ${bindingId}::uuid
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id,
        remote_resource_id, stable_key, name, role, selected_for_sync, sync_status, envelope_cursor
      ) VALUES (${newShortId()},
        ${resource!.id}::uuid,
        ${`uidvalidity-${suffix}`},
        'UIDVALIDITY fixture',
        'other',
        false,
        'syncing',
        ${{
          version: 1,
          uidValidity: "51",
          highestSeenUid: 1,
          backfillNextHigh: null,
          backfillComplete: true,
          incrementalTargetHigh: null,
          incrementalNextHigh: null,
          highestModseq: "1",
          flagTargetModseq: null,
          flagNextLow: null,
          flagMaxUid: null,
          reconcileNextLow: null,
          lastFullReconcileAt: null,
        }}::jsonb
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, highest_modseq, effective_rights, last_verified_at
      ) VALUES (
        ${bindingId}::uuid,
        ${folder!.id}::uuid,
        ${`UIDVALIDITY-${suffix}`},
        51,
        2,
        1,
        ARRAY['read']::text[],
        now()
      )
    `;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<uidvalidity-${suffix}@example.com>`},
        'UIDVALIDITY fixture',
        now(),
        1,
        ${`${"d".repeat(56)}${suffix}`},
        'complete'
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 51, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${remoteRef!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid)
    `;

    const fence = await claimFence(resource!.id, bindingId, "incremental");
    const beforeCursor = {
      version: 1 as const,
      uidValidity: "51",
      highestSeenUid: 1,
      backfillNextHigh: null,
      backfillComplete: true,
      incrementalTargetHigh: null,
      incrementalNextHigh: null,
      highestModseq: "1",
      flagTargetModseq: null,
      flagNextLow: null,
      flagMaxUid: null,
      reconcileNextLow: null,
      lastFullReconcileAt: null,
    };
    const cursor = {
      ...beforeCursor,
      uidValidity: "52",
      highestSeenUid: 0,
      highestModseq: "2",
    };

    await commitSyncBatch({
      folder: {
        folder_id: folder!.id,
        mailbox_id: mailboxId,
        remote_resource_id: resource!.id,
        sync_generation: fence.generation,
        envelope_cursor: beforeCursor,
        role: "other",
      },
      folderId: folder!.id,
      bindingId,
      secretRevision: 1,
      fence,
      status: {
        uidValidity: "52",
        uidNext: 1,
        highestModseq: "2",
        messages: 0,
      },
      beforeCursor,
      cursor,
      uidValidityChanged: true,
      envelopeBatch: null,
      envelopeKind: null,
      flagChanges: [],
      reconcileWindow: null,
    });

    const [projection] = await sql<
      {
        stale_at: Date | string | null;
        deleted_at: Date | string | null;
        uid_validity: string;
        run_state: string;
      }[]
    >`
      SELECT
        remote_ref.stale_at,
        placement.deleted_at,
        binding_folder.uid_validity::text AS uid_validity,
        sync_run.state AS run_state
      FROM mail.remote_message_refs remote_ref
      JOIN mail.message_placements placement ON placement.remote_message_ref_id = remote_ref.id
      JOIN mail.binding_folder_refs binding_folder
        ON binding_folder.binding_id = ${bindingId}::uuid AND binding_folder.folder_id = ${folder!.id}::uuid
      JOIN mail.sync_runs sync_run ON sync_run.id = ${fence.runId}::uuid
      WHERE remote_ref.id = ${remoteRef!.id}::uuid
    `;
    expect(projection?.stale_at).not.toBeNull();
    expect(projection?.deleted_at).not.toBeNull();
    expect(projection?.uid_validity).toBe("52");
    expect(projection?.run_state).toBe("completed");
    const [liveInvalidation] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM mail.live_invalidation_outbox
      WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(liveInvalidation?.count).toBeGreaterThan(0);
    await sql`DELETE FROM mail.folders WHERE id = ${folder!.id}::uuid`;
  });

  test("stale maintenance execution is recovered and completed by the durable worker", async () => {
    const command = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "hydrate_missing",
        idempotencyKey: `stale-worker-${suffix}`,
      },
      enqueue: false,
    });
    expect(command.ok).toBe(true);
    if (!command.ok) return;
    await sql`
      UPDATE mail.commands
      SET
        state = 'executing',
        attempt = 1,
        started_at = now() - interval '20 minutes',
        worker_heartbeat_at = now() - interval '20 minutes'
      WHERE id = ${command.data.id}::uuid
    `;
    await startMaintenanceRuntime();
    expect(syncOps.deadLetterStores().some((store) => store.name === "mail:execute-maintenance-command")).toBe(true);
    try {
      const submitted = await submitDueMaintenanceCommands();
      expect(submitted.recovered).toBeGreaterThanOrEqual(1);
      let state = "executing";
      for (let attempt = 0; attempt < 100 && state !== "confirmed"; attempt += 1) {
        await Bun.sleep(20);
        const [row] = await sql<{ state: string }[]>`SELECT state FROM mail.commands WHERE id = ${command.data.id}::uuid`;
        state = row?.state ?? "missing";
      }
      expect(state).toBe("confirmed");
    } finally {
      await stopMaintenanceRuntime();
    }
    expect(syncOps.deadLetterStores().some((store) => store.name === "mail:execute-maintenance-command")).toBe(false);
    await startMaintenanceRuntime();
    await stopMaintenanceRuntime();
  });

  test("maintenance commands are admin-only, idempotent, durable, and expose health", async () => {
    const denied = await createMailCommand({
      context: collaboratorContext,
      mailboxId,
      input: { kind: "sync_mailbox", idempotencyKey: `denied-${suffix}` },
      enqueue: false,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");

    const created = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: { kind: "sync_mailbox", idempotencyKey: `sync-${suffix}` },
      enqueue: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const replay = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: { kind: "sync_mailbox", idempotencyKey: `sync-${suffix}` },
      enqueue: false,
    });
    expect(replay.ok && replay.data.id).toBe(created.data.id);
    expect(
      await executeMaintenanceCommand(created.data.id, undefined, {
        enqueueWork: false,
      }),
    ).toBe("confirmed");
    const [stored] = await sql<{ state: string; result: Record<string, unknown> | string }[]>`
      SELECT state, result FROM mail.commands WHERE id = ${created.data.id}::uuid
    `;
    const result = typeof stored?.result === "string" ? JSON.parse(stored.result) : stored?.result;
    expect(stored?.state).toBe("confirmed");
    expect(result).toEqual({ queuedFolders: 1 });

    const health = await getMailboxOperationalHealth(adminContext, mailboxId);
    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.data.bindings.active).toBe(1);
      expect(health.data.discovery.activeFolders).toBe(1);
      expect(health.data.discovery.missingFolders).toBe(1);
      expect(health.data.bindings.rightsSources["acl"]).toBe(1);
      expect(health.data.commands.states["confirmed"]).toBeGreaterThanOrEqual(1);
    }

    const [pausedMessage] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, hydration_attempt
      )
      VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<paused-${suffix}@example.com>`},
        'Paused hydration',
        now(),
        1,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")},
        'envelope',
        0
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxFolderId}::uuid, ${pausedMessage!.id}::uuid, 10, 999999)
    `;
    await sql`
      UPDATE mail.binding_folder_refs
      SET effective_rights = ARRAY['read']::text[], rights_source = 'acl'
      WHERE binding_id = ${bindingId}::uuid AND folder_id = ${inboxFolderId}::uuid
    `;
    const [hydrationResource] = await sql<{ id: string }[]>`
      SELECT remote_resource_id AS id FROM mail.provider_bindings WHERE id = ${bindingId}::uuid
    `;
    const hydrationMutex = lazySync((sync) =>
      sync.mutex({
        id: "mail:remote-resource-sync",
        ttlMs: 30_000,
        retry: { maxAttempts: 1 },
      }),
    );
    const heldHydrationLock = await hydrationMutex().acquire({ resource: hydrationResource!.id, ttlMs: 30_000 });
    expect(heldHydrationLock).not.toBeNull();
    if (!heldHydrationLock) return;
    const blockedDownload = spyOn(imapSmtpConnector, "downloadSourceBatch").mockRejectedValue(new Error("locked hydration reached IMAP"));
    try {
      await expect(
        hydrateMessageBatch({
          input: { messageId: pausedMessage!.id },
          signal: new AbortController().signal,
          heartbeat: async () => undefined,
        } as never),
      ).rejects.toMatchObject({ code: "SYNC_BUSY" });
      expect(blockedDownload).not.toHaveBeenCalled();
    } finally {
      blockedDownload.mockRestore();
      await hydrationMutex().release(heldHydrationLock);
    }
    const fencedDownload = spyOn(imapSmtpConnector, "downloadSourceBatch").mockImplementation(
      async (_runtime, _folderPath, requests, consume) => {
        await sql`
          UPDATE mail.remote_resources
          SET sync_generation = sync_generation + 1
          WHERE id = ${hydrationResource!.id}::uuid
        `;
        const request = requests[0]!;
        await consume({
          ...request,
          expectedSize: 1,
          stream: Readable.from(["x"]),
        });
      },
    );
    try {
      await expect(
        hydrateMessageBatch({
          input: { messageId: pausedMessage!.id },
          signal: new AbortController().signal,
          heartbeat: async () => undefined,
        } as never),
      ).rejects.toMatchObject({ code: "MAILBOX_TRANSPORT_CHANGED" });
      const [hydrationState] = await sql<{ hydration_status: string }[]>`
        SELECT hydration_status FROM mail.message_contents WHERE id = ${pausedMessage!.id}::uuid
      `;
      expect(hydrationState?.hydration_status).toBe("envelope");
    } finally {
      fencedDownload.mockRestore();
    }
    const paused = await updateMailbox({
      context: adminContext,
      mailboxId,
      syncEnabled: false,
    });
    expect(paused.ok && paused.data.health).toBe("paused");
    const download = spyOn(imapSmtpConnector, "downloadSourceBatch").mockRejectedValue(new Error("paused hydration reached IMAP"));
    try {
      await expect(
        hydrateMessageBatch({
          input: { messageId: pausedMessage!.id },
          signal: new AbortController().signal,
          heartbeat: async () => undefined,
        } as never),
      ).resolves.toEqual({ hydrated: false });
      expect(download).not.toHaveBeenCalled();
    } finally {
      download.mockRestore();
    }
    const failedVerify = spyOn(imapSmtpConnector, "verify").mockRejectedValue(
      Object.assign(new Error("fixture authentication failure"), {
        code: "AUTHENTICATIONFAILED",
      }),
    );
    const failedDiscovery = spyOn(imapSmtpConnector, "discoverFolders").mockRejectedValue(
      Object.assign(new Error("fixture authentication failure"), {
        code: "AUTHENTICATIONFAILED",
      }),
    );
    try {
      await expect(rediscoverProviderBinding({ bindingId })).rejects.toMatchObject({ code: "AUTHENTICATIONFAILED" });
      const [pausedHealth] = await sql<{ health: string }[]>`
        SELECT health FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
      `;
      expect(pausedHealth?.health).toBe("paused");
    } finally {
      failedDiscovery.mockRestore();
      failedVerify.mockRestore();
      await sql`
        UPDATE mail.provider_bindings
        SET state = 'active', last_error_code = NULL, last_error_message = NULL
        WHERE id = ${bindingId}::uuid
      `;
      await sql`
        UPDATE mail.provider_connections
        SET status = 'active', last_error_code = NULL, last_error_message = NULL
        WHERE id = ${connectionId}::uuid
      `;
    }
    const pausedCommand = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: { kind: "sync_mailbox", idempotencyKey: `paused-sync-${suffix}` },
      enqueue: false,
    });
    expect(pausedCommand.ok).toBe(true);
    if (pausedCommand.ok) {
      expect(
        await executeMaintenanceCommand(pausedCommand.data.id, undefined, {
          enqueueWork: false,
        }),
      ).toBe("confirmed");
      const [storedPaused] = await sql<{ result: Record<string, unknown> | string }[]>`
        SELECT result FROM mail.commands WHERE id = ${pausedCommand.data.id}::uuid
      `;
      expect(typeof storedPaused?.result === "string" ? JSON.parse(storedPaused.result) : storedPaused?.result).toEqual({
        queuedFolders: 0,
      });
    }
    const resumed = await updateMailbox({
      context: adminContext,
      mailboxId,
      syncEnabled: true,
    });
    expect(resumed.ok && resumed.data.health).toBe("bootstrapping");
  });

  test("operator projections are admin-only, redacted, durable, and preserve collaboration state", async () => {
    const denied = await getMailboxOperations(collaboratorContext, mailboxId);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");

    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes,
        content_hash, hydration_status, plain_text
      )
      VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<operator-${suffix}@example.com>`},
        'Operator projection fixture',
        'operator projection fixture',
        now(),
        64,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")},
        'complete',
        'Durable projection content'
      )
      RETURNING id
    `;
    if (!message) throw new Error("Operator projection fixture was not created");

    const before = await getMailboxOperations(adminContext, mailboxId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.data.mailboxId).toBe(mailboxShortId);
    expect(before.data.folders.every((folder) => /^[0-9A-Za-z]{6}$/.test(folder.id))).toBe(true);
    expect(before.data.coverage.search.covered).toBeLessThan(before.data.coverage.search.total);
    expect(before.data.coverage.threads.covered).toBeLessThan(before.data.coverage.threads.total);
    expect(JSON.stringify(before.data)).not.toContain("Operator projection fixture");
    expect(JSON.stringify(before.data)).not.toContain("Durable projection content");

    const platform = await getPlatformMailOperations(adminContext, {
      q: `Lifecycle ${suffix}`,
      limit: 10,
    });
    expect(platform.ok).toBe(true);
    if (!platform.ok) return;
    expect(platform.data.mailboxes).toHaveLength(1);
    expect(platform.data.mailboxes[0]).toMatchObject({
      mailboxId: mailboxShortId,
      mailboxName: `Lifecycle ${suffix}`,
      coverage: before.data.coverage,
    });
    expect(JSON.stringify(platform.data)).not.toContain("Operator projection fixture");

    const searchCommand = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "rebuild_search",
        idempotencyKey: `operator-search-${suffix}`,
      },
      enqueue: false,
    });
    expect(searchCommand.ok).toBe(true);
    if (!searchCommand.ok) return;
    const idempotentReplay = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "rebuild_search",
        idempotencyKey: `operator-search-${suffix}`,
      },
      enqueue: false,
    });
    expect(idempotentReplay.ok && idempotentReplay.data.id).toBe(searchCommand.data.id);
    const duplicateRepair = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "rebuild_search",
        idempotencyKey: `operator-search-duplicate-${suffix}`,
      },
      enqueue: false,
    });
    expect(duplicateRepair.ok).toBe(false);
    if (!duplicateRepair.ok) expect(duplicateRepair.error.code).toBe("CONFLICT");
    expect(
      await executeMaintenanceCommand(searchCommand.data.id, undefined, {
        enqueueWork: false,
      }),
    ).toBe("confirmed");

    const threadCommand = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "rebuild_threads",
        idempotencyKey: `operator-threads-${suffix}`,
      },
      enqueue: false,
    });
    expect(threadCommand.ok).toBe(true);
    if (!threadCommand.ok) return;
    expect(
      await executeMaintenanceCommand(threadCommand.data.id, undefined, {
        enqueueWork: false,
      }),
    ).toBe("confirmed");

    const [projected] = await sql<{ chunks: number; conversation_id: string }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.message_search_chunks WHERE message_id = ${message.id}::uuid) AS chunks,
        (SELECT conversation_id::text FROM mail.conversation_messages WHERE message_id = ${message.id}::uuid) AS conversation_id
    `;
    expect(projected?.chunks).toBeGreaterThan(0);
    expect(projected?.conversation_id).toBeTruthy();
    await sql`
      UPDATE mail.conversations SET work_status = 'done'
      WHERE id = ${projected!.conversation_id}::uuid
    `;

    const replay = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "rebuild_threads",
        idempotencyKey: `operator-threads-replay-${suffix}`,
      },
      enqueue: false,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(
      await executeMaintenanceCommand(replay.data.id, undefined, {
        enqueueWork: false,
      }),
    ).toBe("confirmed");
    const [preserved] = await sql<
      {
        conversation_id: string;
        work_status: string;
      }[]
    >`
      SELECT link.conversation_id, conversation.work_status
      FROM mail.conversation_messages link
      JOIN mail.conversations conversation ON conversation.id = link.conversation_id
      WHERE link.message_id = ${message.id}::uuid
    `;
    expect(preserved).toEqual({
      conversation_id: projected!.conversation_id,
      work_status: "done",
    });
  });

  test("operator retry recovery does not execute the same retry twice", async () => {
    const target = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "hydrate_missing",
        idempotencyKey: `operator-retry-target-${suffix}`,
      },
      enqueue: false,
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await sql`
      UPDATE mail.commands
      SET state = 'failed', last_error_code = 'TEST_FAILURE', last_error_message = 'Retry fixture', finished_at = now()
      WHERE id = ${target.data.id}::uuid
    `;
    const input = {
      kind: "retry_command" as const,
      commandId: target.data.id,
      idempotencyKey: `operator-retry-${suffix}`,
    };
    const operator = await createMailCommand({
      context: adminContext,
      mailboxId,
      input,
      enqueue: false,
    });
    expect(operator.ok).toBe(true);
    if (!operator.ok) return;

    expect(
      await executeOperatorAction({
        commandId: operator.data.id,
        mailboxId,
        input,
      }),
    ).toMatchObject({ retried: true });
    await sql`
      UPDATE mail.commands
      SET state = 'failed', last_error_code = 'RETRY_FAILED', last_error_message = 'Retry failed again', finished_at = now()
      WHERE id = ${target.data.id}::uuid
    `;
    expect(
      await executeOperatorAction({
        commandId: operator.data.id,
        mailboxId,
        input,
      }),
    ).toMatchObject({
      retried: true,
      replayed: true,
    });
    const [stored] = await sql<{ state: string }[]>`SELECT state FROM mail.commands WHERE id = ${target.data.id}::uuid`;
    expect(stored?.state).toBe("failed");
  });

  test("folder rebuild retains content while invalidating remote placement and hydration retry resets failures", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, hydration_attempt
      )
      VALUES (${newShortId()}, ${mailboxId}::uuid, '<rebuild@example.com>', 'Rebuild', now(), 1, ${"a".repeat(64)}, 'complete', 0)
      RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxFolderId}::uuid, ${message!.id}::uuid, 10, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${remoteRef!.id}::uuid, ${inboxFolderId}::uuid, ${message!.id}::uuid)
    `;
    const rebuild = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: {
        kind: "rebuild_folder",
        folderId: inboxFolderShortId,
        idempotencyKey: `rebuild-${suffix}`,
      },
      enqueue: false,
    });
    expect(rebuild.ok).toBe(true);
    if (!rebuild.ok) return;
    expect(
      await executeMaintenanceCommand(rebuild.data.id, undefined, {
        enqueueWork: false,
      }),
    ).toBe("confirmed");
    const [rebuilt] = await sql<
      {
        sync_status: string;
        stale: boolean;
        placement_deleted: boolean;
        content_exists: boolean;
      }[]
    >`
      SELECT
        folder.sync_status,
        ref.stale_at IS NOT NULL AS stale,
        placement.deleted_at IS NOT NULL AS placement_deleted,
        EXISTS (SELECT 1 FROM mail.message_contents WHERE id = ${message!.id}::uuid) AS content_exists
      FROM mail.folders folder
      JOIN mail.remote_message_refs ref ON ref.folder_id = folder.id
      JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
      WHERE folder.id = ${inboxFolderId}::uuid AND ref.id = ${remoteRef!.id}::uuid
    `;
    expect(rebuilt).toEqual({
      sync_status: "rebuilding",
      stale: true,
      placement_deleted: true,
      content_exists: true,
    });

    const [failed] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, hydration_attempt
      )
      VALUES (${newShortId()}, ${mailboxId}::uuid, '<hydrate@example.com>', 'Hydrate', now(), 1, ${"b".repeat(64)}, 'failed', 5)
      RETURNING id
    `;
    const hydrate = await createMailCommand({
      context: adminContext,
      mailboxId,
      input: { kind: "hydrate_missing", idempotencyKey: `hydrate-${suffix}` },
      enqueue: false,
    });
    expect(hydrate.ok).toBe(true);
    if (!hydrate.ok) return;
    expect(
      await executeMaintenanceCommand(hydrate.data.id, undefined, {
        enqueueWork: false,
      }),
    ).toBe("confirmed");
    const [hydrated] = await sql<{ hydration_status: string; hydration_attempt: number }[]>`
      SELECT hydration_status, hydration_attempt FROM mail.message_contents WHERE id = ${failed!.id}::uuid
    `;
    expect(hydrated).toEqual({
      hydration_status: "envelope",
      hydration_attempt: 0,
    });
  });

  test("provider folder administration and additive message state stay durable and permission scoped", async () => {
    const denied = await createActorCommand({
      context: collaboratorContext,
      mailboxId,
      input: {
        kind: "create_folder",
        name: `Denied ${suffix}`,
        subscribe: true,
        showInSidebar: true,
        idempotencyKey: `folder-denied-${suffix}`,
      },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");

    const folderRights = ["read", "write_flags", "insert", "move", "delete_messages", "create_children", "delete_folder"];
    let providerFolders = [remoteFolder("INBOX", "10", "inbox", folderRights)];
    let partialCreate = true;
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => providerFolders);
    const create = spyOn(imapSmtpConnector, "createFolder").mockImplementation(async (_runtime, path, subscribe) => {
      providerFolders = [
        {
          ...remoteFolder(path, "90", "other", folderRights),
          subscribed: false,
        },
        ...providerFolders,
      ];
      if (subscribe && partialCreate) {
        partialCreate = false;
        throw Object.assign(new Error("Folder was created before subscription failed"), { code: "REMOTE_CREATE_SUBSCRIBE_PARTIAL" });
      }
    });
    const subscribe = spyOn(imapSmtpConnector, "setFolderSubscription").mockImplementation(async (_runtime, path, subscribed) => {
      providerFolders = providerFolders.map((folder) => (folder.path === path ? { ...folder, subscribed } : folder));
    });
    const rename = spyOn(imapSmtpConnector, "renameFolder").mockImplementation(async (_runtime, path, newPath) => {
      providerFolders = providerFolders.map((folder) =>
        folder.path === path
          ? {
              ...folder,
              stableKey: `${newPath}:${folder.uidValidity}`,
              path: newPath,
              name: newPath,
            }
          : folder,
      );
    });
    const remove = spyOn(imapSmtpConnector, "deleteFolder").mockImplementation(async (_runtime, path) => {
      providerFolders = providerFolders.filter((folder) => folder.path !== path);
    });
    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue({
      uidValidity: "90",
      uidNext: 1,
      highestModseq: "1",
      messages: 0,
    });
    try {
      const nested = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "create_folder",
          name: `Invalid/Nested ${suffix}`,
          subscribe: true,
          showInSidebar: true,
          idempotencyKey: `folder-nested-${suffix}`,
        },
      });
      expect(nested.ok).toBe(true);
      if (!nested.ok) return;
      expect(await executeMutationCommand(nested.data.id)).toBe("failed");
      expect(create).not.toHaveBeenCalled();

      const created = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "create_folder",
          name: `Cloud Ops ${suffix}`,
          subscribe: true,
          showInSidebar: false,
          idempotencyKey: `folder-create-${suffix}`,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(await executeMutationCommand(created.data.id)).toBe("ambiguous");
      expect(await executeMutationCommand(created.data.id)).toBe("reconciled");
      const [projected] = await sql<{ id: string; short_id: string; show_in_sidebar: boolean; subscribed: boolean }[]>`
        SELECT folder.id, folder.short_id, folder.show_in_sidebar, ref.subscribed
        FROM mail.folders folder
        JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
        WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path = ${`Cloud Ops ${suffix}`}
      `;
      expect(projected?.subscribed).toBe(true);
      expect(projected?.show_in_sidebar).toBe(false);

      const deniedVisibility = await setFolderSidebarVisibility({
        context: collaboratorContext,
        mailboxId,
        folderId: projected!.id,
        showInSidebar: true,
      });
      expect(deniedVisibility.ok).toBe(false);
      if (!deniedVisibility.ok) expect(deniedVisibility.error.code).toBe("FORBIDDEN");
      const updatedVisibility = await setFolderSidebarVisibility({
        context: adminContext,
        mailboxId,
        folderId: projected!.id,
        showInSidebar: true,
      });
      expect(updatedVisibility.ok).toBe(true);
      const activeDismissal = await dismissUnavailableFolder({
        context: adminContext,
        mailboxId,
        folderId: projected!.id,
      });
      expect(activeDismissal.ok).toBe(false);
      if (!activeDismissal.ok) expect(activeDismissal.error.code).toBe("CONFLICT");
      const adminFolders = await listAdminFolders(adminContext, mailboxId);
      expect(adminFolders.ok).toBe(true);
      if (!adminFolders.ok) return;
      expect(adminFolders.data.find((folder) => folder.id === projected!.id)).toMatchObject({
        showInSidebar: true,
        subscribed: true,
        canCreateChildren: true,
        canRename: true,
        canDelete: true,
      });
      await sql`
        UPDATE mail.binding_folder_refs
        SET namespace_kind = 'shared', rights_source = 'select'
        WHERE binding_id = ${bindingId}::uuid AND folder_id = ${projected!.id}::uuid
      `;
      const conservativeSharedFolders = await listAdminFolders(adminContext, mailboxId);
      await sql`
        UPDATE mail.binding_folder_refs
        SET namespace_kind = 'personal', rights_source = 'acl'
        WHERE binding_id = ${bindingId}::uuid AND folder_id = ${projected!.id}::uuid
      `;
      expect(conservativeSharedFolders.ok).toBe(true);
      if (!conservativeSharedFolders.ok) return;
      expect(conservativeSharedFolders.data.find((folder) => folder.id === projected!.id)).toMatchObject({
        canCreateChildren: false,
        canRename: false,
        canDelete: false,
      });

      const configuredRole = await setFolderRole({
        context: adminContext,
        mailboxId,
        role: "archive",
        folderId: projected!.id,
      });
      expect(configuredRole.ok && configuredRole.data.configured).toBe(true);
      const resolvedRole = await resolveRoleFolder(mailboxId, "archive");
      expect(resolvedRole.ok && resolvedRole.data.id).toBe(projected!.id);
      expect(
        (
          await clearFolderRole({
            context: adminContext,
            mailboxId,
            role: "archive",
          })
        ).ok,
      ).toBe(true);

      const unsubscribed = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "set_folder_subscription",
          folderId: projected!.id,
          subscribed: false,
          idempotencyKey: `folder-unsubscribe-${suffix}`,
        },
      });
      expect(unsubscribed.ok).toBe(true);
      if (!unsubscribed.ok) return;
      expect(await executeMutationCommand(unsubscribed.data.id)).toBe("confirmed");

      const renamed = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "rename_folder",
          folderId: projected!.id,
          name: `Cloud Renamed ${suffix}`,
          idempotencyKey: `folder-rename-${suffix}`,
        },
      });
      expect(renamed.ok).toBe(true);
      if (!renamed.ok) return;
      expect(await executeMutationCommand(renamed.data.id)).toBe("confirmed");
      const [renamedProjection] = await sql<{ id: string; show_in_sidebar: boolean; subscribed: boolean }[]>`
        SELECT folder.id, folder.show_in_sidebar, ref.subscribed
        FROM mail.folders folder
        JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
        WHERE ref.binding_id = ${bindingId}::uuid AND ref.remote_path = ${`Cloud Renamed ${suffix}`}
      `;
      expect(renamedProjection).toEqual({
        id: projected!.id,
        show_in_sidebar: true,
        subscribed: false,
      });

      const deleted = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "delete_folder",
          folderId: projected!.id,
          idempotencyKey: `folder-delete-${suffix}`,
        },
      });
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) return;
      expect(await executeMutationCommand(deleted.data.id)).toBe("confirmed");
      const [missing] = await sql<{ discovery_state: string }[]>`
        SELECT discovery_state FROM mail.folders WHERE id = ${projected!.id}::uuid
      `;
      expect(missing?.discovery_state).toBe("missing");

      const [historicalMessage] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<dismissed-folder-${suffix}@example.com>`},
          'Dismissed folder history',
          now(),
          1,
          ${"d".repeat(64)},
          'complete'
        )
        RETURNING id
      `;
      const [historicalRef] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${projected!.id}::uuid, ${historicalMessage!.id}::uuid, 90, 123456)
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${historicalRef!.id}::uuid, ${projected!.id}::uuid, ${historicalMessage!.id}::uuid)
      `;

      const deniedDismissal = await dismissUnavailableFolder({
        context: collaboratorContext,
        mailboxId,
        folderId: projected!.id,
      });
      expect(deniedDismissal.ok).toBe(false);
      if (!deniedDismissal.ok) expect(deniedDismissal.error.code).toBe("FORBIDDEN");

      const dismissal = await dismissUnavailableFolder({
        context: adminContext,
        mailboxId,
        folderId: projected!.id,
      });
      expect(dismissal).toEqual(
        expect.objectContaining({
          ok: true,
          data: { folderId: projected!.id, dismissedFolderCount: 1 },
        }),
      );
      const [dismissedProjection] = await sql<
        {
          dismissed: boolean;
          show_in_sidebar: boolean;
          placement_preserved: boolean;
          content_preserved: boolean;
        }[]
      >`
        SELECT
          folder.dismissed_at IS NOT NULL AS dismissed,
          folder.show_in_sidebar,
          EXISTS (
            SELECT 1
            FROM mail.message_placements placement
            WHERE placement.remote_message_ref_id = ${historicalRef!.id}::uuid
          ) AS placement_preserved,
          EXISTS (
            SELECT 1
            FROM mail.message_contents content
            WHERE content.id = ${historicalMessage!.id}::uuid
          ) AS content_preserved
        FROM mail.folders folder
        WHERE folder.id = ${projected!.id}::uuid
      `;
      expect(dismissedProjection).toEqual({
        dismissed: true,
        show_in_sidebar: true,
        placement_preserved: true,
        content_preserved: true,
      });
      const foldersAfterDismissal = await listAdminFolders(adminContext, mailboxId);
      expect(foldersAfterDismissal.ok).toBe(true);
      if (!foldersAfterDismissal.ok) return;
      expect(foldersAfterDismissal.data.some((folder) => folder.id === projected!.id)).toBe(false);

      providerFolders = [
        {
          ...remoteFolder(`Cloud Renamed ${suffix}`, "90", "other", folderRights),
          subscribed: false,
        },
        ...providerFolders,
      ];
      const rediscovered = await rediscoverProviderBinding({ bindingId });
      expect(rediscovered.state).toBe("active");
      const [restoredProjection] = await sql<{ discovery_state: string; dismissed_at: Date | null; show_in_sidebar: boolean }[]>`
        SELECT discovery_state, dismissed_at, show_in_sidebar
        FROM mail.folders
        WHERE id = ${projected!.id}::uuid
      `;
      expect(restoredProjection).toEqual({
        discovery_state: "active",
        dismissed_at: null,
        show_in_sidebar: true,
      });
      const foldersAfterRediscovery = await listAdminFolders(adminContext, mailboxId);
      expect(foldersAfterRediscovery.ok).toBe(true);
      if (!foldersAfterRediscovery.ok) return;
      expect(foldersAfterRediscovery.data.some((folder) => folder.id === projected!.id)).toBe(true);
    } finally {
      status.mockRestore();
      remove.mockRestore();
      rename.mockRestore();
      subscribe.mockRestore();
      create.mockRestore();
      discover.mockRestore();
      verify.mockRestore();
    }

    const [stateFolder] = await sql<{ id: string; short_id: string }[]>`
      SELECT folder.id, folder.short_id
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      WHERE resource.mailbox_id = ${mailboxId}::uuid
        AND folder.role = 'inbox'
        AND folder.discovery_state = 'active'
      ORDER BY folder.id
      LIMIT 1
    `;
    expect(stateFolder).toBeDefined();
    if (!stateFolder) return;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<state-${suffix}@example.com>`},
        'State mutation',
        now(),
        1,
        ${"e".repeat(64)},
        'complete'
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${stateFolder.id}::uuid, ${message!.id}::uuid, 10, 777777)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${remoteRef!.id}::uuid, ${stateFolder.id}::uuid, ${message!.id}::uuid, ARRAY['\\Answered']::text[], ARRAY['Existing']::text[])
    `;
    const providerState = spyOn(imapSmtpConnector, "getMessageState").mockResolvedValue({
      exists: true,
      flags: ["\\Answered"],
      keywords: ["Existing"],
      messageId: `<state-${suffix}@example.com>`,
      modseq: "1",
    });
    let effectCommandId: string | null = null;
    const changeState = spyOn(imapSmtpConnector, "changeMessageState").mockImplementation(async (_runtime, _target, change) => {
      expect(change).toEqual({
        addFlags: ["\\Seen"],
        removeFlags: [],
        addKeywords: ["CloudTest"],
        removeKeywords: [],
      });
      if (!effectCommandId) throw new Error("Provider effect command fixture is unavailable");
      const [effect] = await sql<{ started: boolean; attempt: number | null }[]>`
        SELECT provider_effect_started_at IS NOT NULL AS started, provider_effect_attempt AS attempt
        FROM mail.commands
        WHERE id = ${effectCommandId}::uuid
      `;
      expect(effect).toEqual({ started: true, attempt: 2 });
      return {
        exists: true,
        flags: ["\\Answered", "\\Seen"],
        keywords: ["cloudtest", "Existing"],
        messageId: `<state-${suffix}@example.com>`,
        modseq: "2",
      };
    });
    try {
      const stateMessageId = message!.id;
      const missingPlacement = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "change_message_state",
          messageId: crypto.randomUUID(),
          folderId: stateFolder.id,
          change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
          idempotencyKey: `message-state-missing-${suffix}`,
        },
      });
      expect(missingPlacement).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      const stale = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "change_message_state",
          messageId: stateMessageId,
          folderId: stateFolder.id,
          change: {
            addFlags: ["seen"],
            removeFlags: [],
            addKeywords: ["CloudTest"],
            removeKeywords: [],
          },
          expectedRemoteState: {
            modseq: "1",
            flags: ["answered"],
            keywords: ["Different"],
          },
          idempotencyKey: `message-state-stale-${suffix}`,
        },
      });
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;
      expect(await executeMutationCommand(stale.data.id)).toBe("failed");
      const [staleState] = await sql<{ last_error_code: string | null }[]>`
        SELECT last_error_code FROM mail.commands WHERE id = ${stale.data.id}::uuid
      `;
      expect(staleState?.last_error_code).toBe("REMOTE_STATE_CHANGED");
      expect(changeState).not.toHaveBeenCalled();

      const command = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "change_message_state",
          messageId: stateMessageId,
          folderId: stateFolder.id,
          change: {
            addFlags: ["seen"],
            removeFlags: [],
            addKeywords: ["CloudTest"],
            removeKeywords: [],
          },
          expectedRemoteState: {
            modseq: "1",
            flags: ["answered"],
            keywords: ["Existing"],
          },
          idempotencyKey: `message-state-${suffix}`,
        },
      });
      expect(command.ok).toBe(true);
      if (!command.ok) return;
      providerState.mockClear();
      changeState.mockClear();
      const [resource] = await sql<{ id: string }[]>`
        SELECT remote_resource_id AS id
        FROM mail.provider_bindings
        WHERE id = ${bindingId}::uuid
      `;
      const syncLock = lazySync((sync) =>
        sync.mutex({
          id: "mail:remote-resource-sync",
          ttlMs: 30_000,
          retry: { maxAttempts: 1 },
        }),
      );
      const heldSyncLock = await syncLock().acquire({ resource: resource!.id, ttlMs: 30_000 });
      expect(heldSyncLock).not.toBeNull();
      if (!heldSyncLock) return;
      try {
        expect(await executeMutationCommand(command.data.id)).toBe("queued");
        expect(providerState).not.toHaveBeenCalled();
        expect(changeState).not.toHaveBeenCalled();
        const [blocked] = await sql<{ last_error_code: string | null }[]>`
          SELECT last_error_code FROM mail.commands WHERE id = ${command.data.id}::uuid
        `;
        expect(blocked?.last_error_code).toBe("REMOTE_RESOURCE_BUSY");
      } finally {
        await syncLock().release(heldSyncLock);
      }
      effectCommandId = command.data.id;
      expect(await executeMutationCommand(command.data.id)).toBe("confirmed");
      const [placement] = await sql<{ flags: string[]; keywords: string[] }[]>`
        SELECT flags, keywords FROM mail.message_placements WHERE remote_message_ref_id = ${remoteRef!.id}::uuid
      `;
      expect(placement).toEqual({
        flags: ["\\Answered", "\\Seen"],
        keywords: ["cloudtest", "Existing"],
      });
    } finally {
      changeState.mockRestore();
      providerState.mockRestore();
    }
  }, 15_000);

  test("opposing message mutations execute in accepted order when the later worker starts first", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<ordered-state-${suffix}@example.com>`},
        'Ordered state mutation',
        now(),
        1,
        ${sha256Json({ fixture: "ordered-state", suffix })},
        'complete'
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxFolderId}::uuid, ${message!.id}::uuid, 10, 777778)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${remoteRef!.id}::uuid, ${inboxFolderId}::uuid, ${message!.id}::uuid)
    `;

    const messageShortId = message!.id;
    const createStateCommand = (change: { addFlags: ("answered" | "flagged")[]; removeFlags: ("answered" | "flagged")[] }, key: string) =>
      createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "change_message_state",
          messageId: messageShortId,
          folderId: inboxFolderShortId,
          change: { ...change, addKeywords: [], removeKeywords: [] },
          idempotencyKey: key,
        },
      });
    const first = await createStateCommand({ addFlags: ["flagged"], removeFlags: [] }, `ordered-state-add-${suffix}`);
    const second = await createStateCommand({ addFlags: [], removeFlags: ["flagged"] }, `ordered-state-remove-${suffix}`);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    await sql`
      UPDATE mail.commands
      SET created_at = CASE
        WHEN id = ${first.data.id}::uuid THEN now() - interval '1 second'
        ELSE now()
      END
      WHERE id IN (${first.data.id}::uuid, ${second.data.id}::uuid)
    `;

    let providerFlags: string[] = [];
    const changes: { addFlags: string[]; removeFlags: string[] }[] = [];
    const providerState = spyOn(imapSmtpConnector, "getMessageState").mockImplementation(async () => ({
      exists: true,
      flags: providerFlags,
      keywords: [],
      messageId: `<ordered-state-${suffix}@example.com>`,
      modseq: "1",
    }));
    const changeState = spyOn(imapSmtpConnector, "changeMessageState").mockImplementation(async (_runtime, _target, change) => {
      changes.push({ addFlags: change.addFlags, removeFlags: change.removeFlags });
      providerFlags = providerFlags.filter((flag) => !change.removeFlags.includes(flag));
      providerFlags = [...new Set([...providerFlags, ...change.addFlags])];
      return {
        exists: true,
        flags: providerFlags,
        keywords: [],
        messageId: `<ordered-state-${suffix}@example.com>`,
        modseq: String(changes.length + 1),
      };
    });
    try {
      expect(await executeMutationCommand(second.data.id)).toBe("queued");
      expect(changes).toEqual([]);
      const [waiting] = await sql<{ last_error_code: string | null }[]>`
        SELECT last_error_code FROM mail.commands WHERE id = ${second.data.id}::uuid
      `;
      expect(waiting?.last_error_code).toBe("MESSAGE_MUTATION_PREDECESSOR_ACTIVE");

      expect(await executeMutationCommand(first.data.id)).toBe("confirmed");
      expect(await executeMutationCommand(second.data.id)).toBe("confirmed");
      expect(changes).toEqual([
        { addFlags: ["\\Flagged"], removeFlags: [] },
        { addFlags: [], removeFlags: ["\\Flagged"] },
      ]);
      const [placement] = await sql<{ flags: string[] }[]>`
        SELECT flags FROM mail.message_placements WHERE remote_message_ref_id = ${remoteRef!.id}::uuid
      `;
      expect(placement?.flags).toEqual([]);

      const failed = await createStateCommand({ addFlags: ["answered"], removeFlags: [] }, `ordered-state-failed-${suffix}`);
      const afterFailure = await createStateCommand({ addFlags: [], removeFlags: ["answered"] }, `ordered-state-after-failure-${suffix}`);
      expect(failed.ok).toBe(true);
      expect(afterFailure.ok).toBe(true);
      if (!failed.ok || !afterFailure.ok) return;
      await sql`
        UPDATE mail.commands
        SET state = 'failed', created_at = now() - interval '1 second', finished_at = now(), updated_at = now()
        WHERE id = ${failed.data.id}::uuid
      `;
      expect(await executeMutationCommand(afterFailure.data.id)).toBe("confirmed");
      expect(changes.at(-1)).toEqual({ addFlags: [], removeFlags: ["\\Answered"] });
    } finally {
      changeState.mockRestore();
      providerState.mockRestore();
    }
  });

  test("real command and hydration completion wake kernel dependencies before their deadlines", async () => {
    const [dependencyFolder] = await sql<{ id: string; short_id: string }[]>`
      SELECT folder.id, folder.short_id
      FROM mail.folders folder
      JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
      WHERE ref.binding_id = ${bindingId}::uuid
        AND ref.remote_path = 'INBOX'
        AND ref.missing_since IS NULL
      LIMIT 1
    `;
    if (!dependencyFolder) throw new Error("Dependency wake fixture inbox is unavailable");
    const plan: WorkflowBoundPlan = {
      schemaVersion: 2,
      languageId: "mail",
      languageVersion: 1,
      sourceHash: sha256Json({ fixture: "dependency-wake-source", suffix }),
      manifestHash: sha256Json({ fixture: "dependency-wake-manifest", suffix }),
      catalogHash: sha256Json({ fixture: "dependency-wake-catalog", suffix }),
      actionPolicies: {},
      inputs: [],
      triggers: [],
      steps: [],
      bindings: {},
    };
    const workflow = await createKernelWorkflow({
      appId: "mail",
      scopeId: mailboxId,
      key: `dependency-wake-${suffix}`,
      name: "Dependency wake integration",
      author: { kind: "system" },
    });
    try {
      const version = await publishWorkflowVersion({
        workflowId: workflow.id,
        source: "steps: []\n",
        plan,
        activations: [],
        activate: true,
        author: { kind: "system" },
      });
      let runSequence = 0;
      const park = async (dependency: { kind: string; key: string }): Promise<string> => {
        runSequence += 1;
        const runId = await createWorkflowRun({
          appId: "mail",
          scopeId: mailboxId,
          workflowId: workflow.id,
          workflowVersionId: version.id,
          mode: "execute",
          authorization: {},
          idempotencyKey: `dependency-wake-${suffix}-${runSequence}`,
          occurredAt: new Date(),
        });
        const claim = await claimWorkflowRun({ worker: `mail-dependency-wake-${runSequence}`, runId });
        if (!claim) throw new Error("Workflow dependency run was not claimable");
        const step = {
          runId,
          executionGeneration: claim.executionGeneration,
          mode: "execute" as const,
          workflowId: workflow.id,
          sourceHash: plan.sourceHash,
          idempotencyKey: `dependency-step-${runSequence}`,
          key: "steps.0",
          sourcePath: ["steps", 0],
          iterationPath: [],
          path: ["steps", 0],
          kind: "action" as const,
          action: "mail.test.wait",
        };
        const repository = createWorkflowRuntimeRepository();
        await repository.startStep(step);
        await repository.parkStep(step, {
          ...dependency,
          deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
        expect(await finishWorkflowRun(claim, { state: "waiting" })).toEqual({ state: "finished" });
        return runId;
      };
      const expectWokenBeforeDeadline = async (runId: string): Promise<void> => {
        const [run] = await sql<{ state: string; wake_at: Date | string | null }[]>`
          SELECT state, wake_at
          FROM workflows.run
          WHERE id = ${runId}::uuid
        `;
        expect(run).toEqual({ state: "queued", wake_at: null });
      };

      const [commandMessage] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<dependency-command-${suffix}@example.com>`},
          'Dependency command',
          now(),
          1,
          ${sha256Json({ fixture: "dependency-command", suffix })},
          'complete'
        ) RETURNING id
      `;
      const [commandRef] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${dependencyFolder.id}::uuid, ${commandMessage!.id}::uuid, 10, 990003)
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${commandRef!.id}::uuid, ${dependencyFolder.id}::uuid, ${commandMessage!.id}::uuid)
      `;
      const command = await createActorCommand({
        context: adminContext,
        mailboxId,
        enqueue: false,
        input: {
          kind: "change_message_state",
          messageId: commandMessage!.id,
          folderId: dependencyFolder.id,
          change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
          idempotencyKey: `dependency-command-${suffix}`,
        },
      });
      if (!command.ok) throw new Error(command.error.message);
      const commandRunId = await park({ kind: "mail.command", key: command.data.id });
      const providerState = spyOn(imapSmtpConnector, "getMessageState").mockResolvedValue({
        exists: true,
        flags: [],
        keywords: [],
        messageId: `<dependency-command-${suffix}@example.com>`,
        modseq: "1",
      });
      const changeState = spyOn(imapSmtpConnector, "changeMessageState").mockResolvedValue({
        exists: true,
        flags: ["\\Seen"],
        keywords: [],
        messageId: `<dependency-command-${suffix}@example.com>`,
        modseq: "2",
      });
      try {
        expect(await executeMutationCommand(command.data.id)).toBe("confirmed");
      } finally {
        changeState.mockRestore();
        providerState.mockRestore();
      }
      await expectWokenBeforeDeadline(commandRunId);

      const [hydrationMessage] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<dependency-hydration-${suffix}@example.com>`},
          'Dependency hydration',
          now(),
          256,
          ${sha256Json({ fixture: "dependency-hydration", suffix })},
          'envelope'
        ) RETURNING id
      `;
      await sql`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${dependencyFolder.id}::uuid, ${hydrationMessage!.id}::uuid, 10, 990004)
      `;
      const hydrationRunId = await park({ kind: "mail.hydration", key: hydrationMessage!.id });
      const source = [
        `Message-ID: <dependency-hydration-${suffix}@example.com>`,
        "From: sender@example.com",
        "To: lifecycle@example.com",
        "Subject: Dependency hydration",
        `Date: ${new Date().toUTCString()}`,
        "",
        "Hydrated body",
      ].join("\r\n");
      const download = spyOn(imapSmtpConnector, "downloadSourceBatch").mockImplementation(
        async (_runtime, _folderPath, requests, consume) => {
          const request = requests.find((candidate) => candidate.key === hydrationMessage!.id);
          if (!request) throw new Error("Hydration dependency request is missing");
          await consume({
            ...request,
            expectedSize: Buffer.byteLength(source),
            stream: Readable.from([source]),
          });
        },
      );
      try {
        await expect(
          hydrateMessageBatch({
            input: { messageId: hydrationMessage!.id },
            signal: new AbortController().signal,
            heartbeat: async () => undefined,
          } as never),
        ).resolves.toEqual({ hydrated: true });
      } finally {
        download.mockRestore();
      }
      await expectWokenBeforeDeadline(hydrationRunId);

      const [failedHydrationMessage] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, hydration_attempt
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<dependency-hydration-failed-${suffix}@example.com>`},
          'Terminal dependency hydration',
          now(),
          256,
          ${sha256Json({ fixture: "dependency-hydration-failed", suffix })},
          'failed',
          4
        ) RETURNING id
      `;
      await sql`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${dependencyFolder.id}::uuid, ${failedHydrationMessage!.id}::uuid, 10, 990005)
      `;
      const failedHydrationRunId = await park({ kind: "mail.hydration", key: failedHydrationMessage!.id });
      const failedDownload = spyOn(imapSmtpConnector, "downloadSourceBatch").mockImplementation(
        async (_runtime, _folderPath, requests, consume) => {
          const request = requests.find((candidate) => candidate.key === failedHydrationMessage!.id);
          if (!request) throw new Error("Terminal hydration dependency request is missing");
          await consume({
            ...request,
            expectedSize: Buffer.byteLength(source) + 1,
            stream: Readable.from([source]),
          });
        },
      );
      try {
        await expect(
          hydrateMessageBatch({
            input: { messageId: failedHydrationMessage!.id },
            signal: new AbortController().signal,
            heartbeat: async () => undefined,
          } as never),
        ).rejects.toMatchObject({ code: "MESSAGE_SIZE_MISMATCH" });
      } finally {
        failedDownload.mockRestore();
      }
      const [failedHydration] = await sql<{ hydration_status: string; hydration_attempt: number }[]>`
        SELECT hydration_status, hydration_attempt
        FROM mail.message_contents
        WHERE id = ${failedHydrationMessage!.id}::uuid
      `;
      expect(failedHydration).toEqual({ hydration_status: "failed", hydration_attempt: 5 });
      await expectWokenBeforeDeadline(failedHydrationRunId);
    } finally {
      await sql`DELETE FROM workflows.workflow WHERE id = ${workflow.id}::uuid`;
    }
  }, 15_000);

  test("conversation triage creates its durable child commands atomically", async () => {
    const [conversation] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Atomic triage', 'fixture', now())
      RETURNING id, short_id
    `;
    const contentHashes = [`${"a".repeat(56)}${suffix}`, `${"b".repeat(56)}${suffix}`];
    const refs: string[] = [];
    const messageIds: string[] = [];
    for (const [position, contentHash] of contentHashes.entries()) {
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<atomic-triage-${position}-${suffix}@example.com>`},
          'Atomic triage',
          now(),
          1,
          ${contentHash},
          'complete'
        ) RETURNING id
      `;
      const [remoteRef] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${inboxFolderId}::uuid, ${message!.id}::uuid, 10, ${880000 + position})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${remoteRef!.id}::uuid, ${inboxFolderId}::uuid, ${message!.id}::uuid)
      `;
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
        VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, ${position})
      `;
      refs.push(remoteRef!.id);
      messageIds.push(message!.id);
    }

    const idempotencyKey = `atomic-triage-${suffix}`;
    const conflict = await createActorCommand({
      context: adminContext,
      mailboxId,
      enqueue: false,
      input: {
        kind: "change_message_state",
        messageId: messageIds[1]!,
        folderId: inboxFolderShortId,
        change: {
          addFlags: ["flagged"],
          removeFlags: [],
          addKeywords: [],
          removeKeywords: [],
        },
        idempotencyKey: `${idempotencyKey}:${refs[1]}`,
      },
    });
    expect(conflict.ok).toBe(true);

    const triage = await createConversationTriageCommands({
      context: adminContext,
      mailboxId,
      conversationId: conversation!.id,
      input: {
        kind: "change_state",
        sourceFolderId: inboxFolderShortId,
        change: {
          addFlags: ["seen"],
          removeFlags: [],
          addKeywords: [],
          removeKeywords: [],
        },
        idempotencyKey,
      },
    });
    expect(triage.ok).toBe(false);
    if (!triage.ok) expect(triage.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const [created] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.commands
      WHERE mailbox_id = ${mailboxId}::uuid
        AND idempotency_key = ${`${idempotencyKey}:${refs[0]}`}
    `;
    expect(created?.count).toBe(0);
  });

  test("command idempotency stays actor-bound and rechecks write access on replay", async () => {
    const accessId = accessIds[0]!;
    const promoted = await updateMailboxAccess({
      context: adminContext,
      mailboxId,
      accessId,
      permission: "write",
    });
    expect(promoted.ok).toBe(true);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<command-replay-${suffix}@example.com>`},
        'Command replay',
        now(),
        1,
        ${`${"c".repeat(56)}${suffix}`},
        'complete'
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxFolderId}::uuid, ${message!.id}::uuid, 10, 990001)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${remoteRef!.id}::uuid, ${inboxFolderId}::uuid, ${message!.id}::uuid)
    `;
    const input = {
      kind: "change_message_state" as const,
      messageId: message!.id,
      folderId: inboxFolderShortId,
      change: {
        addFlags: ["seen" as const],
        removeFlags: [],
        addKeywords: [],
        removeKeywords: [],
      },
      idempotencyKey: `actor-bound-${suffix}`,
    };
    const created = await createActorCommand({
      context: adminContext,
      mailboxId,
      input,
      enqueue: false,
    });
    expect(created.ok).toBe(true);
    const foreignReplay = await createActorCommand({
      context: collaboratorContext,
      mailboxId,
      input,
      enqueue: false,
    });
    expect(foreignReplay.ok).toBe(false);
    if (!foreignReplay.ok) expect(foreignReplay.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const ownInput = { ...input, idempotencyKey: `revoked-replay-${suffix}` };
    const own = await createActorCommand({
      context: collaboratorContext,
      mailboxId,
      input: ownInput,
      enqueue: false,
    });
    expect(own.ok).toBe(true);
    const downgraded = await updateMailboxAccess({
      context: adminContext,
      mailboxId,
      accessId,
      permission: "read",
    });
    expect(downgraded.ok).toBe(true);
    const revokedReplay = await createActorCommand({
      context: collaboratorContext,
      mailboxId,
      input: ownInput,
      enqueue: false,
    });
    expect(revokedReplay.ok).toBe(false);
    if (!revokedReplay.ok) expect(revokedReplay.error.code).toBe("FORBIDDEN");
  });

  test("folder provider effects recheck admin permission under the mailbox lock", async () => {
    const accessId = accessIds[0]!;
    expect(
      (
        await updateMailboxAccess({
          context: adminContext,
          mailboxId,
          accessId,
          permission: "admin",
        })
      ).ok,
    ).toBe(true);
    const command = await createActorCommand({
      context: collaboratorContext,
      mailboxId,
      input: {
        kind: "create_folder",
        name: `Revoked effect ${suffix}`,
        subscribe: false,
        showInSidebar: true,
        idempotencyKey: `revoked-provider-effect-${suffix}`,
      },
      enqueue: false,
    });
    expect(command.ok).toBe(true);
    if (!command.ok) return;

    const enteredDiscovery = Promise.withResolvers<void>();
    const releaseDiscovery = Promise.withResolvers<void>();
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => {
      enteredDiscovery.resolve();
      await releaseDiscovery.promise;
      return [remoteFolder("INBOX", "10", "inbox")];
    });
    const create = spyOn(imapSmtpConnector, "createFolder").mockRejectedValue(new Error("revoked command reached provider effect"));
    try {
      const execution = executeMutationCommand(command.data.id);
      await enteredDiscovery.promise;
      expect(
        (
          await updateMailboxAccess({
            context: adminContext,
            mailboxId,
            accessId,
            permission: "write",
          })
        ).ok,
      ).toBe(true);
      releaseDiscovery.resolve();
      expect(await execution).toBe("failed");
      expect(create).not.toHaveBeenCalled();
      const [stored] = await sql<{ last_error_code: string | null }[]>`
        SELECT last_error_code FROM mail.commands WHERE id = ${command.data.id}::uuid
      `;
      expect(stored?.last_error_code).toBe("ACCESS_REVOKED");
    } finally {
      releaseDiscovery.resolve();
      create.mockRestore();
      discover.mockRestore();
      await updateMailboxAccess({
        context: adminContext,
        mailboxId,
        accessId,
        permission: "read",
      });
    }
  }, 15_000);

  test("cancels a workflow command when its kernel execution generation is stale", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<stale-workflow-command-${suffix}@example.com>`},
        'Stale workflow command',
        now(),
        1,
        ${sha256Json({ fixture: "stale-workflow-command", suffix })},
        'complete'
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${inboxFolderId}::uuid, ${message!.id}::uuid, 10, 990002)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${remoteRef!.id}::uuid, ${inboxFolderId}::uuid, ${message!.id}::uuid)
    `;

    const plan: WorkflowBoundPlan = {
      schemaVersion: 2,
      languageId: "mail",
      languageVersion: 1,
      sourceHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      catalogHash: "c".repeat(64),
      actionPolicies: {},
      inputs: [],
      triggers: [],
      steps: [],
      bindings: {},
    };
    const workflow = await createKernelWorkflow({
      appId: "mail",
      scopeId: mailboxId,
      key: `stale-command-${suffix}`,
      name: "Stale command fence",
      author: { kind: "system" },
    });
    try {
      await sql`
        INSERT INTO mail.workflow_profile (id, mailbox_id, enabled)
        VALUES (${workflow.id}::uuid, ${mailboxId}::uuid, true)
      `;
      const version = await publishWorkflowVersion({
        workflowId: workflow.id,
        source: "steps: []\n",
        plan,
        activations: [],
        activate: true,
        author: { kind: "system" },
      });
      const runId = await createWorkflowRun({
        appId: "mail",
        scopeId: mailboxId,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        mode: "execute",
        authorization: {},
        idempotencyKey: `stale-command-${suffix}`,
        occurredAt: new Date(),
      });
      const claim = await claimWorkflowRun({ worker: "mail-stale-command-test", runId });
      if (!claim) throw new Error("Workflow run was not claimable");
      const terminalInput = {
        kind: "change_message_state" as const,
        messageId: message!.id,
        folderId: inboxFolderShortId,
        change: { addFlags: ["seen" as const], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: `terminal-workflow-command-${suffix}`,
        correlationId: runId,
      };
      const terminal = await createWorkflowCommand({
        context: null,
        mailboxId,
        workflowVersionId: version.id,
        input: terminalInput,
        enqueue: false,
        beforeCreate: async () => ({ workflowExecutionGeneration: claim.executionGeneration }),
      });
      if (!terminal.ok) throw new Error(terminal.error.message);
      await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE id = ${terminal.data.id}::uuid`;
      await sql`UPDATE workflows.run SET execution_generation = execution_generation + 1 WHERE id = ${runId}::uuid`;
      const resumedGeneration = claim.executionGeneration + 1;
      const replay = await createWorkflowCommand({
        context: null,
        mailboxId,
        workflowVersionId: version.id,
        input: terminalInput,
        enqueue: false,
        beforeCreate: async () => ({ workflowExecutionGeneration: resumedGeneration }),
      });
      expect(replay.ok && replay.data.id).toBe(terminal.data.id);

      const command = await createWorkflowCommand({
        context: null,
        mailboxId,
        workflowVersionId: version.id,
        input: {
          kind: "change_message_state",
          messageId: message!.id,
          folderId: inboxFolderShortId,
          change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
          idempotencyKey: `stale-workflow-command-${suffix}`,
          correlationId: runId,
        },
        enqueue: false,
        beforeCreate: async () => ({ workflowExecutionGeneration: resumedGeneration }),
      });
      expect(command.ok).toBe(true);
      if (!command.ok) return;
      await sql`UPDATE workflows.run SET execution_generation = execution_generation + 1 WHERE id = ${runId}::uuid`;

      const provider = spyOn(imapSmtpConnector, "changeMessageState").mockRejectedValue(
        new Error("stale workflow command reached provider effect"),
      );
      try {
        expect(await executeMutationCommand(command.data.id)).toBeNull();
        expect(provider).not.toHaveBeenCalled();
        const [stored] = await sql<
          { state: string; last_error_code: string | null; workflow_execution_generation: string | number | null }[]
        >`
          SELECT state, last_error_code, workflow_execution_generation
          FROM mail.commands
          WHERE id = ${command.data.id}::uuid
        `;
        expect(stored?.state).toBe("cancelled");
        expect(stored?.last_error_code).toBe("WORKFLOW_CANCELED");
        expect(Number(stored?.workflow_execution_generation)).toBe(resumedGeneration);
      } finally {
        provider.mockRestore();
      }
    } finally {
      await sql`DELETE FROM workflows.workflow WHERE id = ${workflow.id}::uuid`;
    }
  }, 15_000);

  test("connection creation rechecks admin permission after provider verification", async () => {
    const accessId = accessIds[0]!;
    expect(
      (
        await updateMailboxAccess({
          context: adminContext,
          mailboxId,
          accessId,
          permission: "admin",
        })
      ).ok,
    ).toBe(true);
    const enteredVerification = Promise.withResolvers<void>();
    const releaseVerification = Promise.withResolvers<void>();
    const verify = spyOn(imapSmtpConnector, "verify").mockImplementation(async () => {
      enteredVerification.resolve();
      await releaseVerification.promise;
      return fixtureVerification();
    });
    try {
      const creation = createProviderConnection({
        context: collaboratorContext,
        mailboxId,
        input: {
          name: `Revoked connection ${suffix}`,
          email: `revoked-${suffix}@example.com`,
          username: `revoked-${suffix}@example.com`,
          imap: { host: "imap.example.com", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.com", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "revoked-secret" },
        },
      });
      await enteredVerification.promise;
      expect(
        (
          await updateMailboxAccess({
            context: adminContext,
            mailboxId,
            accessId,
            permission: "read",
          })
        ).ok,
      ).toBe(true);
      releaseVerification.resolve();
      const result = await creation;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
      const [stored] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM mail.provider_connections
        WHERE owner_mailbox_id = ${mailboxId}::uuid AND name = ${`Revoked connection ${suffix}`}
      `;
      expect(stored?.count).toBe(0);
    } finally {
      releaseVerification.resolve();
      verify.mockRestore();
      await updateMailboxAccess({
        context: adminContext,
        mailboxId,
        accessId,
        permission: "read",
      });
    }
  }, 15_000);

  test("execution rechecks administration access after command creation", async () => {
    const access = accessIds[0]!;
    const promoted = await updateMailboxAccess({
      context: adminContext,
      mailboxId,
      accessId: access,
      permission: "admin",
    });
    expect(promoted.ok).toBe(true);
    const command = await createMailCommand({
      context: collaboratorContext,
      mailboxId,
      input: { kind: "hydrate_missing", idempotencyKey: `revoked-${suffix}` },
      enqueue: false,
    });
    expect(command.ok).toBe(true);
    if (!command.ok) return;
    const revoked = await revokeMailboxAccess({
      context: adminContext,
      mailboxId,
      accessId: access,
    });
    expect(revoked.ok).toBe(true);
    expect(
      await executeMaintenanceCommand(command.data.id, undefined, {
        enqueueWork: false,
      }),
    ).toBe("failed");
    const [stored] = await sql<{ state: string; last_error_code: string | null }[]>`
      SELECT state, last_error_code FROM mail.commands WHERE id = ${command.data.id}::uuid
    `;
    expect(stored).toEqual({
      state: "failed",
      last_error_code: "ACCESS_REVOKED",
    });
  });
});
