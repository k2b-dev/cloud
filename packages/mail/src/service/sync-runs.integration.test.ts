import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { imapSmtpConnector } from "./connectors";
import { getMailboxOperationalHealth, listMailboxSyncRuns } from "./health";
import { createMailbox } from "./mailboxes";
import { getMailboxOperations } from "./operations";
import { createProviderConnection } from "./provider-connections";

const suite = suiteFor("database", "nats", "valkey");

suite("mail sync runs", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let ownerContext: MailRequestContext;
  let mailboxId = "";
  let resourceId = "";
  let bindingId = "";

  const createUser = async (label: string): Promise<{ id: string; context: MailRequestContext }> => {
    const uid = `mail-sync-runs-${label}-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create a sync runs test user");
    userIds.push(user.id);
    return {
      id: user.id,
      context: {
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
        requestId: `mail-sync-runs-${label}-${suffix}`,
      },
    };
  };

  const insertFolder = async (name: string, parentId: string | null): Promise<{ id: string; shortId: string }> => {
    const shortId = newShortId();
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, parent_id, stable_key, name)
      VALUES (${shortId}, ${resourceId}::uuid, ${parentId}::uuid, ${`${name}:${suffix}`}, ${name})
      RETURNING id
    `;
    return { id: folder!.id, shortId };
  };

  const insertRun = async (run: { folderId: string; state: string; errorCode?: string; hoursAgo: number }): Promise<void> => {
    await sql`
      INSERT INTO mail.sync_runs (remote_resource_id, binding_id, fence_token, generation, kind, state, stats, error_code, started_at, finished_at)
      VALUES (
        ${resourceId}::uuid, ${bindingId}::uuid, 1, 1, 'incremental', ${run.state}, ${{ folderId: run.folderId }}::jsonb,
        ${run.errorCode ?? null}, now() - ${run.hoursAgo}::double precision * interval '1 hour',
        CASE WHEN ${run.state} = 'running' THEN NULL ELSE now() - ${run.hoursAgo}::double precision * interval '1 hour' END
      )
    `;
  };

  beforeAll(async () => {
    await migrate();
    const owner = await createUser("owner");
    ownerContext = owner.context;
    const mailbox = await createMailbox(ownerContext, { name: `Sync runs ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const account = `sync-runs-${suffix}@example.test`;
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue({
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
    let connectionId = "";
    try {
      const connection = await createProviderConnection({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Sync runs ${account}`,
          email: account,
          username: account,
          imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);
      connectionId = connection.data.connection.id;
    } finally {
      verify.mockRestore();
    }
    const scope = sha256Json({ account });
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, ${{ accountId: account }}::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    resourceId = resource!.id;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
        capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
      ) VALUES (
        ${resourceId}::uuid, ${connectionId}::uuid, 'active', ${account},
        ${{ accountId: account }}::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${scope}, 1, now()
      ) RETURNING id
    `;
    bindingId = binding!.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    for (const userId of userIds) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("status and operator status count failed sync runs of the last 24 hours, not every retained failure", async () => {
    const inbox = await insertFolder("INBOX", null);
    await insertRun({ folderId: inbox.id, state: "failed", errorCode: "CONNECT_TIMEOUT", hoursAgo: 1 });
    await insertRun({ folderId: inbox.id, state: "completed", hoursAgo: 1 });
    // Kept for diagnosis within the 30-day retention, but no longer a current problem.
    await insertRun({ folderId: inbox.id, state: "failed", errorCode: "CONNECT_TIMEOUT", hoursAgo: 72 });
    await insertRun({ folderId: inbox.id, state: "completed", hoursAgo: 72 });

    const health = await getMailboxOperationalHealth(ownerContext, mailboxId);
    expect(health.ok && health.data.sync).toMatchObject({ runningRuns: 0, failedRuns: 1 });

    const operations = await getMailboxOperations(ownerContext, mailboxId);
    expect(operations.ok && operations.data.sync.states).toEqual({ completed: 1, failed: 1 });
  });

  test("sync runs list failures newest first with folder path and error code, page by page, for mailbox readers only", async () => {
    await sql`DELETE FROM mail.sync_runs WHERE remote_resource_id = ${resourceId}::uuid`;
    const projects = await insertFolder("Projects", null);
    const archive = await insertFolder("Archive", projects.id);
    await insertRun({ folderId: archive.id, state: "failed", errorCode: "CONNECT_TIMEOUT", hoursAgo: 3 });
    await insertRun({ folderId: projects.id, state: "completed", hoursAgo: 2 });
    await insertRun({ folderId: projects.id, state: "failed", errorCode: "SYNC_JOB_LEASE_LOST", hoursAgo: 1 });
    // Two failures in the same microsecond still page without a gap or a repeat.
    await sql`
      INSERT INTO mail.sync_runs (remote_resource_id, binding_id, fence_token, generation, kind, state, stats, error_code, started_at, finished_at)
      SELECT ${resourceId}::uuid, ${bindingId}::uuid, 1, 1, 'incremental', 'failed', ${{ folderId: archive.id }}::jsonb,
        'MAIL_SYNC_FAILED', at, at
      FROM (SELECT now() - interval '30 minutes' AS at) moment, generate_series(1, 2)
    `;

    const first = await listMailboxSyncRuns({ context: ownerContext, mailboxId, state: "failed", limit: 2 });
    expect(first.ok && first.data.items).toMatchObject([
      { kind: "incremental", state: "failed", errorCode: "MAIL_SYNC_FAILED", folderId: archive.shortId, folderPath: "Projects / Archive" },
      { kind: "incremental", state: "failed", errorCode: "MAIL_SYNC_FAILED", folderId: archive.shortId, folderPath: "Projects / Archive" },
    ]);
    expect(first.ok && first.data.nextCursor).toBeString();

    // One run per page splits the two failures of the same microsecond.
    const pages: Array<{ errorCode: string | null; folderPath: string | null; startedAt: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await listMailboxSyncRuns({ context: ownerContext, mailboxId, state: "failed", limit: 1, cursor });
      if (!page.ok) throw new Error(page.error.message);
      pages.push(...page.data.items);
      cursor = page.data.nextCursor ?? undefined;
    } while (cursor && pages.length < 10);
    expect(pages.map(({ errorCode, folderPath }) => ({ errorCode, folderPath }))).toEqual([
      { errorCode: "MAIL_SYNC_FAILED", folderPath: "Projects / Archive" },
      { errorCode: "MAIL_SYNC_FAILED", folderPath: "Projects / Archive" },
      { errorCode: "SYNC_JOB_LEASE_LOST", folderPath: "Projects" },
      { errorCode: "CONNECT_TIMEOUT", folderPath: "Projects / Archive" },
    ]);
    expect(pages.map((run) => run.startedAt)).toEqual(
      pages
        .map((run) => run.startedAt)
        .toSorted()
        .toReversed(),
    );

    const all = await listMailboxSyncRuns({ context: ownerContext, mailboxId });
    expect(all.ok && all.data.items.map((run) => run.state)).toEqual(["failed", "failed", "failed", "completed", "failed"]);
    const completed = await listMailboxSyncRuns({ context: ownerContext, mailboxId, state: "completed" });
    expect(completed.ok && completed.data.items.map(({ state, folderPath }) => ({ state, folderPath }))).toEqual([
      { state: "completed", folderPath: "Projects" },
    ]);
    const cancelled = await listMailboxSyncRuns({ context: ownerContext, mailboxId, state: "cancelled" });
    expect(cancelled.ok && cancelled.data).toEqual({ items: [], nextCursor: null });

    const badCursor = await listMailboxSyncRuns({ context: ownerContext, mailboxId, cursor: "not-a-cursor" });
    expect(!badCursor.ok && badCursor.error.code).toBe("BAD_INPUT");

    const stranger = await createUser("stranger");
    const denied = await listMailboxSyncRuns({ context: stranger.context, mailboxId });
    expect(!denied.ok && denied.error.code).toBe("FORBIDDEN");

    const assigned = await createUser("assigned");
    const grant = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: assigned.id },
      permission: "read",
      scope: "assigned",
    });
    expect(grant.ok).toBe(true);
    const assignedOnly = await listMailboxSyncRuns({ context: assigned.context, mailboxId });
    expect(!assignedOnly.ok && assignedOnly.error.code).toBe("FORBIDDEN");

    const reader = await createUser("reader");
    expect(
      (await grantMailboxAccess({ context: ownerContext, mailboxId, principal: { type: "user", userId: reader.id }, permission: "read" }))
        .ok,
    ).toBe(true);
    const readable = await listMailboxSyncRuns({ context: reader.context, mailboxId, state: "failed" });
    expect(readable.ok && readable.data.items).toHaveLength(4);
  });
});
