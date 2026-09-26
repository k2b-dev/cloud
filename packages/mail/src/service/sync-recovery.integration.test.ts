import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, type ProviderConnectionInput, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { createMailCommand } from "./commands";
import { imapSmtpConnector } from "./connectors";
import { loadImapPushPlan } from "./imap-push-runtime";
import { createMailbox, updateMailbox } from "./mailboxes";
import { executeMaintenanceCommand } from "./maintenance-runtime";
import { createProviderConnection, replaceProviderConnection } from "./provider-connections";
import { claimFence, syncFolderBatch } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");

const EMPTY_INBOX = { uidValidity: "10", uidNext: 1, highestModseq: "1", messages: 0 };
const connectTimeout = () => Object.assign(new Error("Failed to establish connection in required time"), { code: "CONNECT_TIMEOUT" });

const fixtureVerification = (account: string): ConnectorVerification => ({
  authenticatedPrincipal: account,
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
  accounts: [{ id: account, name: account, locator: {}, namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }] }],
});

const connectionInput = (account: string, password: string): ProviderConnectionInput => ({
  name: `Recovery ${account}`,
  email: account,
  username: account,
  imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
  smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
  secret: { kind: "password", password },
});

type SyncFixture = { mailboxId: string; connectionId: string; resourceId: string; bindingId: string; folderId: string; account: string };

suite("mail sync recovery", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  let userId = "";
  let ownerContext: MailRequestContext;

  const createSyncedMailbox = async (label: string): Promise<SyncFixture> => {
    const account = `${label}-${suffix}@example.test`;
    const mailbox = await createMailbox(ownerContext, { name: `Sync recovery ${label} ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification(account));
    let connectionId = "";
    try {
      const connection = await createProviderConnection({
        context: ownerContext,
        mailboxId: mailbox.data.id,
        input: connectionInput(account, "fixture-secret"),
      });
      if (!connection.ok) throw new Error(connection.error.message);
      connectionId = connection.data.connection.id;
    } finally {
      verify.mockRestore();
    }
    const scope = sha256Json({ account });
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailbox.data.id}::uuid, ${{ accountId: account }}::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
        capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
      ) VALUES (
        ${resource!.id}::uuid, ${connectionId}::uuid, 'active', ${account},
        ${{ accountId: account }}::jsonb, ${fixtureVerification(account).capabilities}::jsonb, '{}'::jsonb,
        '{}'::jsonb, ${scope}, 1, now()
      ) RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'INBOX:10', 'INBOX', 'inbox')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, highest_modseq, effective_rights, rights_source, last_verified_at
      ) VALUES (
        ${binding!.id}::uuid, ${folder!.id}::uuid, 'INBOX', 10, 1, 1, ARRAY['read']::text[], 'acl', now()
      )
    `;
    await sql`UPDATE mail.mailboxes SET health = 'active', health_reason = NULL WHERE id = ${mailbox.data.id}::uuid`;
    return { mailboxId: mailbox.data.id, connectionId, resourceId: resource!.id, bindingId: binding!.id, folderId: folder!.id, account };
  };

  const transportState = async (fixture: SyncFixture) => {
    const [state] = await sql<
      {
        resource_status: string;
        last_sync_at: Date | null;
        health: string;
        health_reason: string | null;
        binding_state: string;
        binding_verified_at: Date | null;
      }[]
    >`
      SELECT
        resource.status AS resource_status,
        resource.last_sync_at,
        mailbox.health,
        mailbox.health_reason,
        binding.state AS binding_state,
        binding.last_verified_at AS binding_verified_at
      FROM mail.remote_resources resource
      JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
      JOIN mail.provider_bindings binding ON binding.remote_resource_id = resource.id
      WHERE resource.id = ${fixture.resourceId}::uuid
    `;
    return state!;
  };

  // Runs a manual `sync folder` request the way the durable maintenance worker does.
  const requestFolderSync = async (fixture: SyncFixture, key: string): Promise<Record<string, unknown>> => {
    const command = await createMailCommand({
      context: ownerContext,
      mailboxId: fixture.mailboxId,
      input: { kind: "sync_folder", folderId: fixture.folderId, idempotencyKey: `${key}-${suffix}` },
      enqueue: false,
    });
    if (!command.ok) throw new Error(command.error.message);
    expect(await executeMaintenanceCommand(command.data.id)).toBe("confirmed");
    const [stored] = await sql<{ result: Record<string, unknown> | string }[]>`
      SELECT result FROM mail.commands WHERE id = ${command.data.id}::uuid
    `;
    return typeof stored?.result === "string" ? JSON.parse(stored.result) : (stored?.result ?? {});
  };

  const degradeWithTimeout = async (fixture: SyncFixture): Promise<void> => {
    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockRejectedValue(connectTimeout());
    try {
      await expect(syncFolderBatch(fixture.folderId, async () => undefined)).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
    } finally {
      status.mockRestore();
    }
    expect(await transportState(fixture)).toMatchObject({
      resource_status: "degraded",
      health: "degraded",
      health_reason: "Failed to establish connection in required time",
      binding_state: "active",
    });
  };

  beforeAll(async () => {
    await migrate();
    const uid = `mail-sync-recovery-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create the sync recovery test user");
    userId = user.id;
    ownerContext = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid,
          provider: "local",
          profile: "user",
          displayName: uid,
          givenName: "Mail",
          sn: "Test",
          mail: `${uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-sync-recovery-${suffix}`,
    };
  });

  afterAll(async () => {
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("a sync timeout degrades the mailbox only until the next attempt synchronizes it", async () => {
    const fixture = await createSyncedMailbox("timeout");
    const before = await transportState(fixture);
    await degradeWithTimeout(fixture);

    // The binding and its credential revision are still valid: push keeps listening and a manual sync queues real work.
    expect(await loadImapPushPlan(fixture.bindingId)).toMatchObject({ bindingId: fixture.bindingId, folderId: fixture.folderId });
    expect(await requestFolderSync(fixture, "degraded-sync")).toEqual({ folderId: fixture.folderId, queued: true });

    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue(EMPTY_INBOX);
    try {
      await expect(syncFolderBatch(fixture.folderId, async () => undefined)).resolves.toMatchObject({ hasMore: false });
      expect(status).toHaveBeenCalledTimes(1);
    } finally {
      status.mockRestore();
    }

    const after = await transportState(fixture);
    expect(after).toMatchObject({ resource_status: "active", health: "active", health_reason: null, binding_state: "active" });
    expect(after.last_sync_at).not.toBeNull();
    // Recovery did not wait for a binding rediscovery.
    expect(after.binding_verified_at).toEqual(before.binding_verified_at);
    const runs = await sql<{ state: string; error_code: string | null }[]>`
      SELECT state, error_code FROM mail.sync_runs WHERE remote_resource_id = ${fixture.resourceId}::uuid ORDER BY started_at, id
    `;
    expect(runs).toEqual([
      { state: "failed", error_code: "CONNECT_TIMEOUT" },
      { state: "completed", error_code: null },
    ]);
  });

  test("a degraded mailbox still waits for a changed credential to be verified again", async () => {
    const fixture = await createSyncedMailbox("credential");
    await degradeWithTimeout(fixture);

    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification(fixture.account));
    try {
      const replaced = await replaceProviderConnection({
        context: ownerContext,
        connectionId: fixture.connectionId,
        input: connectionInput(fixture.account, "rotated-secret"),
      });
      if (!replaced.ok) throw new Error(replaced.error.message);
    } finally {
      verify.mockRestore();
    }
    const reason = "Provider credentials changed; verify the remote resource again";
    expect(await transportState(fixture)).toMatchObject({
      resource_status: "connection_required",
      health: "connection_required",
      health_reason: reason,
      binding_state: "pending",
    });

    // The request names the prerequisite instead of queueing a sync that cannot run, and keeps the reason intact.
    expect(await requestFolderSync(fixture, "credential-sync")).toEqual({
      folderId: fixture.folderId,
      queued: false,
      reason: `Mailbox transport is unavailable: ${reason}`,
    });
    expect(await transportState(fixture)).toMatchObject({ health: "connection_required", health_reason: reason });
    await expect(claimFence(fixture.resourceId, fixture.bindingId, "incremental")).rejects.toMatchObject({
      code: "MAILBOX_TRANSPORT_CHANGED",
    });
    expect(await loadImapPushPlan(fixture.bindingId)).toBeNull();
  });

  test("a degraded mailbox stays paused after an administrator pauses synchronization", async () => {
    const fixture = await createSyncedMailbox("paused");
    await degradeWithTimeout(fixture);
    const paused = await updateMailbox({ context: ownerContext, mailboxId: fixture.mailboxId, syncEnabled: false });
    expect(paused.ok && paused.data.health).toBe("paused");

    expect(await requestFolderSync(fixture, "paused-sync")).toEqual({
      folderId: fixture.folderId,
      queued: false,
      reason: "Mailbox transport is paused",
    });
    await expect(claimFence(fixture.resourceId, fixture.bindingId, "incremental")).rejects.toMatchObject({
      code: "MAILBOX_TRANSPORT_CHANGED",
    });
    expect(await loadImapPushPlan(fixture.bindingId)).toBeNull();
  });
});
