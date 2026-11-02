import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { connections, createSql, sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { closePlatformClients, initializeClients } from "../../../cloud/src/runtime/clients";
import { countPostgresRoundTrips } from "../../test/postgres-round-trips";
import { type ConnectorVerification, type ProviderConnectionInput, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { createMailCommand } from "./commands";
import type { ConnectorEnvelope } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { getMailboxOperationalHealth } from "./health";
import { loadImapPushPlan } from "./imap-push-runtime";
import { createMailbox, updateMailbox } from "./mailboxes";
import { executeMaintenanceCommand } from "./maintenance-runtime";
import { getMailboxOperations } from "./operations";
import { createProviderConnection, replaceProviderConnection } from "./provider-connections";
import {
  acquireProviderLease,
  MAIL_PROVIDER_OPERATION_LEASE_MS,
  recordProviderReachable,
  releaseProviderLease,
} from "./provider-operation-lock";
import { claimFence, commitSyncBatch, runSyncFolderJob, syncFolderBatch } from "./sync-runtime";

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

  test("a sync timeout degrades the mailbox only until a sync after the provider answers again synchronizes it", async () => {
    const fixture = await createSyncedMailbox("timeout");
    const before = await transportState(fixture);
    await degradeWithTimeout(fixture);

    // The binding and its credential revision are still valid: push keeps listening and a manual sync queues real work.
    expect(await loadImapPushPlan(fixture.bindingId)).toMatchObject({ bindingId: fixture.bindingId, folderId: fixture.folderId });
    expect(await requestFolderSync(fixture, "degraded-sync")).toEqual({ folderId: fixture.folderId, queued: true });

    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue(EMPTY_INBOX);
    try {
      // The timeout opened the mailbox's provider breaker: the next sync waits instead of connecting,
      // until the breaker's window ends or, as here, IMAP push reaches the provider again.
      await expect(syncFolderBatch(fixture.folderId, async () => undefined)).rejects.toMatchObject({ code: "SYNC_BUSY" });
      expect(status).not.toHaveBeenCalled();
      await recordProviderReachable(fixture.resourceId);
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
    // The provider answered the new connection's verification, so the pause after the timeout no
    // longer holds back the binding's verification that the change requires.
    const verification = await acquireProviderLease({
      resource: fixture.resourceId,
      waiter: "credential-verification",
      priority: "sync",
      ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    });
    expect(verification.lock).not.toBeNull();
    await releaseProviderLease(verification.lock!);
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

  test("a sync that fails after an administrator paused the mailbox leaves it paused", async () => {
    const fixture = await createSyncedMailbox("pause-race");
    // Pausing does not fence a sync that is already talking to the provider.
    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockImplementation(async () => {
      const paused = await updateMailbox({ context: ownerContext, mailboxId: fixture.mailboxId, syncEnabled: false });
      if (!paused.ok) throw new Error(paused.error.message);
      throw connectTimeout();
    });
    try {
      await expect(syncFolderBatch(fixture.folderId, async () => undefined)).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
    } finally {
      status.mockRestore();
    }

    expect(await transportState(fixture)).toMatchObject({
      health: "paused",
      health_reason: "Synchronization paused by a mailbox administrator",
    });
    expect(await requestFolderSync(fixture, "pause-race-sync")).toEqual({
      folderId: fixture.folderId,
      queued: false,
      reason: "Mailbox transport is paused",
    });
  });

  test("a batch the database rejects fails once and waits instead of retrying", async () => {
    const fixture = await createSyncedMailbox("rejected");
    const envelope = (subject: string): ConnectorEnvelope => ({
      remoteRef: { folderStableKey: "INBOX:10", uidValidity: "10", uid: "1", modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId: `<rejected-${suffix}@example.test>`,
      inReplyTo: null,
      references: [],
      subject,
      sentAt: null,
      internalDate: new Date("2026-07-01T10:00:00.000Z"),
      sizeBytes: 42,
      flags: [],
      labels: [],
      addresses: { from: [{ name: null, address: "sender@example.test" }], replyTo: [], to: [], cc: [], bcc: [] },
      mimeStructure: {},
    });
    const runJob = async (subject: string) => {
      const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue({
        ...EMPTY_INBOX,
        uidNext: 2,
        highestModseq: null,
        messages: 1,
      });
      const envelopes = spyOn(imapSmtpConnector, "fetchEnvelopeBatch").mockResolvedValue({
        messages: [envelope(subject)],
        nextHighUid: null,
      });
      const window = spyOn(imapSmtpConnector, "fetchUidWindow").mockResolvedValue([{ uid: 1, modseq: null, flags: [], labels: [] }]);
      const resubmits: { delayMs?: number }[] = [];
      try {
        await runSyncFolderJob({
          input: { folderId: fixture.folderId },
          heartbeat: async () => undefined,
          resubmit: (options) => resubmits.push(options ?? {}),
        });
      } finally {
        status.mockRestore();
        envelopes.mockRestore();
        window.mockRestore();
      }
      const [folder] = await sql<{ sync_status: string }[]>`SELECT sync_status FROM mail.folders WHERE id = ${fixture.folderId}::uuid`;
      return { resubmits, syncStatus: folder?.sync_status };
    };

    // A connector that hands over text Postgres cannot store fails the same way on every attempt.
    expect(await runJob("Re\u0000port")).toEqual({ resubmits: [{ delayMs: 15 * 60_000 }], syncStatus: "degraded" });
    expect(await transportState(fixture)).toMatchObject({ resource_status: "degraded", health: "degraded", binding_state: "active" });

    // The next attempt with storable data resumes the folder.
    expect(await runJob("Report")).toEqual({ resubmits: [], syncStatus: "current" });
    expect(await transportState(fixture)).toMatchObject({ resource_status: "active", health: "active" });
    const runs = await sql<{ state: string; error_code: string | null }[]>`
      SELECT state, error_code FROM mail.sync_runs WHERE remote_resource_id = ${fixture.resourceId}::uuid ORDER BY started_at, id
    `;
    expect(runs).toEqual([
      { state: "failed", error_code: "ERR_POSTGRES_SERVER_ERROR" },
      { state: "completed", error_code: null },
    ]);
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
  test("idle commits skip unchanged metadata while preserving freshness, history and changed-state recovery", async () => {
    const fixture = await createSyncedMailbox("idle-writes");
    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue(EMPTY_INBOX);
    try {
      await syncFolderBatch(fixture.folderId, async () => undefined);
      await syncFolderBatch(fixture.folderId, async () => undefined);
    } finally {
      status.mockRestore();
    }
    const [folder] = await sql<Parameters<typeof commitSyncBatch>[0]["folder"][]>`
      SELECT id AS folder_id, ${fixture.mailboxId}::uuid AS mailbox_id, remote_resource_id,
        0 AS sync_generation, envelope_cursor, role FROM mail.folders WHERE id = ${fixture.folderId}::uuid
    `;
    if (!folder || typeof folder.envelope_cursor === "string") throw new Error("Missing initialized folder cursor");
    const cursor = folder.envelope_cursor;
    await sql`CREATE TABLE mail.idle_write_probe (table_name text, operation text)`;
    await sql
      .unsafe(`CREATE FUNCTION mail.record_idle_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mail.idle_write_probe VALUES (TG_TABLE_NAME, TG_OP); RETURN NEW; END $$`)
      .simple();
    const tables = [
      "remote_resources",
      "sync_runs",
      "folders",
      "binding_folder_refs",
      "provider_bindings",
      "provider_connections",
      "mailboxes",
    ];
    for (const table of tables)
      await sql
        .unsafe(`CREATE TRIGGER idle_write_probe AFTER INSERT OR UPDATE ON mail.${table}
      FOR EACH ROW EXECUTE FUNCTION mail.record_idle_write()`)
        .simple();
    const counter = await countPostgresRoundTrips(connections().database.url);
    const measured = createSql({ url: counter.url, max: 1, tls: false });
    const commit = async (secretRevision = 1, afterClaim?: () => Promise<void>) => {
      const fence = await claimFence(fixture.resourceId, fixture.bindingId, "incremental", fixture.folderId, measured);
      await afterClaim?.();
      return commitSyncBatch({
        db: measured,
        folder,
        folderId: fixture.folderId,
        bindingId: fixture.bindingId,
        secretRevision,
        fence,
        status: EMPTY_INBOX,
        beforeCursor: cursor,
        cursor: structuredClone(cursor),
        uidValidityChanged: false,
        envelopeBatch: null,
        envelopeKind: null,
        flagChanges: [],
        reconcileWindow: null,
      });
    };
    try {
      await measured`SELECT 1`;
      await sql`UPDATE mail.remote_resources SET last_sync_at = '2026-01-01' WHERE id = ${fixture.resourceId}::uuid`;
      await sql`TRUNCATE mail.idle_write_probe`;
      const before = counter.count();
      await commit();
      const statements = counter.count() - before;
      const writes = await sql<{ table_name: string; count: number }[]>`
        SELECT table_name, count(*)::int AS count FROM mail.idle_write_probe GROUP BY table_name ORDER BY table_name
      `;
      console.info("idle sync run", { statements, writes });
      expect(statements).toBe(17); // Includes BEGIN/COMMIT for both fence claim and commit.
      expect(writes).toEqual([
        { table_name: "provider_bindings", count: 1 },
        { table_name: "remote_resources", count: 2 },
        { table_name: "sync_runs", count: 2 },
      ]);
      const health = await getMailboxOperationalHealth(ownerContext, fixture.mailboxId);
      const operations = await getMailboxOperations(ownerContext, fixture.mailboxId);
      const state = await transportState(fixture);
      expect(state.last_sync_at!.getTime()).toBeGreaterThan(new Date("2026-01-01").getTime());
      expect(health.ok).toBe(true);
      expect(operations.ok).toBe(true);
      if (health.ok) expect(JSON.stringify(health.data)).toContain(state.last_sync_at!.toISOString());
      if (operations.ok) expect(JSON.stringify(operations.data)).toContain(state.last_sync_at!.toISOString());
      expect(state.health).toBe("active");
      const [run] = await sql<{ state: string; cursor_after: unknown }[]>`
        SELECT state, cursor_after FROM mail.sync_runs WHERE remote_resource_id = ${fixture.resourceId}::uuid
        ORDER BY started_at DESC LIMIT 1`;
      expect(run?.state).toBe("completed");
      expect(run?.cursor_after).toEqual(cursor);

      // Count a whole warmed idle folder batch as well as the commit seam above.
      const originalUrl = connections().database.url;
      const idleStatus = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue(EMPTY_INBOX);
      try {
        await closePlatformClients();
        connections().database.url = counter.url;
        await initializeClients();
        await sql`TRUNCATE mail.idle_write_probe`;
        const beforeBatch = counter.count();
        const batch = await syncFolderBatch(fixture.folderId, async () => undefined);
        const batchStatements = counter.count() - beforeBatch;
        const batchWrites = await sql<{ table_name: string; count: number }[]>`
          SELECT table_name, count(*)::int AS count FROM mail.idle_write_probe GROUP BY table_name ORDER BY table_name`;
        console.info("whole idle folder batch", { statements: batchStatements, writes: batchWrites });
        expect(batchStatements).toBe(24);
        expect(batch).toMatchObject({ imported: 0, flagsUpdated: 0, removed: 0, hasMore: false });
        expect(batchWrites).toEqual(writes);
      } finally {
        idleStatus.mockRestore();
        await closePlatformClients();
        connections().database.url = originalUrl;
        await initializeClients();
      }

      // A changed provider cursor, error and mailbox health must still write immediately.
      await sql`UPDATE mail.binding_folder_refs SET uid_next = 99 WHERE binding_id = ${fixture.bindingId}::uuid`;
      await sql`UPDATE mail.provider_connections SET last_error_code = 'OLD_FAILURE', last_error_message = 'old' WHERE id = ${fixture.connectionId}::uuid`;
      await sql`UPDATE mail.mailboxes SET health = 'degraded', health_reason = 'old' WHERE id = ${fixture.mailboxId}::uuid`;
      await sql`UPDATE mail.folders SET sync_status = 'syncing' WHERE id = ${fixture.folderId}::uuid`;
      await sql`TRUNCATE mail.idle_write_probe`;
      await commit();
      for (const table of ["binding_folder_refs", "provider_connections", "mailboxes", "folders"]) {
        expect(await sql`SELECT 1 FROM mail.idle_write_probe WHERE table_name = ${table}`).toHaveLength(1);
      }
      expect((await transportState(fixture)).health).toBe("active");
      // FK checks and hydration hold KEY SHARE; idle metadata must remain compatible.
      await measured`SET lock_timeout = '2s'`;
      try {
        await sql.begin(async (locker) => {
          await locker`SELECT id FROM mail.mailboxes WHERE id = ${fixture.mailboxId}::uuid FOR KEY SHARE`;
          await locker`SELECT id FROM mail.provider_connections WHERE id = ${fixture.connectionId}::uuid FOR KEY SHARE`;
          await commit();
        });
      } finally {
        await measured`RESET lock_timeout`;
      }
      await expect(
        commit(1, async () => {
          await sql`UPDATE mail.provider_connections SET secret_revision = 2 WHERE id = ${fixture.connectionId}::uuid`;
        }),
      ).rejects.toMatchObject({ code: "STALE_SYNC_BINDING", message: "Sync credentials changed before commit" });
    } finally {
      await measured.close();
      await counter.close();
      for (const table of tables) await sql.unsafe(`DROP TRIGGER idle_write_probe ON mail.${table}`).simple();
      await sql`DROP FUNCTION mail.record_idle_write()`;
      await sql`DROP TABLE mail.idle_write_probe`;
    }
  });
});
