import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { toPgUuidArray } from "@k2b/cloud/services/postgres";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { type ConnectorEnvelope, imapSmtpConnector } from "./connectors";
import { createMailbox } from "./mailboxes";
import { createProviderConnection } from "./provider-connections";
import { mailProviderOperationMutex } from "./provider-operation-lock";
import { enqueueMessageHydration, startHydrationRuntime, stopHydrationRuntime, syncFolderBatch } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");

const noHeartbeat = async (): Promise<void> => undefined;

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

const waitFor = async (ready: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for message hydration");
    await Bun.sleep(20);
  }
};

const sourceFor = (messageId: string): string =>
  [
    `Message-ID: <${messageId}@hydration.test>`,
    "From: sender@example.test",
    "To: owner@example.test",
    "Subject: Hydration scheduling",
    `Date: ${new Date().toUTCString()}`,
    "",
    `Body of ${messageId}`,
  ].join("\r\n");

type SyncFixture = { label: string; account: string; mailboxId: string; resourceId: string; folderId: string };

suite("mail body hydration scheduling", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  let userId = "";
  let ownerContext: MailRequestContext;
  // The provider's INBOX per account, and the mailbox label of every source download in call order.
  const inboxes = new Map<string, ConnectorEnvelope[]>();
  const labels = new Map<string, string>();
  // Messages the provider expunged after their envelope was imported: FETCH returns no source.
  const expunged = new Set<string>();
  const downloads: string[] = [];
  let downloadGate: Promise<void> = Promise.resolve();
  const spies: Array<{ mockRestore(): void }> = [];

  const createSyncedMailbox = async (label: string): Promise<SyncFixture> => {
    const account = `${label}-${suffix}@example.test`;
    const mailbox = await createMailbox(ownerContext, { name: `Hydration ${label} ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification(account));
    let connectionId = "";
    try {
      const connection = await createProviderConnection({
        context: ownerContext,
        mailboxId: mailbox.data.id,
        input: {
          name: `Hydration ${label}`,
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
    inboxes.set(account, []);
    labels.set(account, label);
    const fixture = { label, account, mailboxId: mailbox.data.id, resourceId: resource!.id, folderId: folder!.id };
    // The first sync of the empty INBOX records its cursor, so later messages arrive as new mail.
    await syncFolderBatch(fixture.folderId, noHeartbeat);
    return fixture;
  };

  // Delivers new messages to the provider INBOX and runs one folder sync, which imports their envelopes.
  const deliver = async (fixture: SyncFixture, count: number): Promise<void> => {
    const inbox = inboxes.get(fixture.account)!;
    for (let index = 0; index < count; index += 1) {
      const uid = inbox.length + 1;
      inbox.push({
        remoteRef: { folderStableKey: fixture.folderId, uidValidity: "10", uid: String(uid), modseq: null },
        providerMessageId: null,
        providerThreadId: null,
        messageId: `<${fixture.label}-${uid}-${suffix}@example.test>`,
        inReplyTo: null,
        references: [],
        subject: `${fixture.label} ${uid}`,
        sentAt: new Date(),
        internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 60_000),
        sizeBytes: 256,
        flags: [],
        labels: [],
        addresses: {
          from: [{ name: null, address: "sender@example.test" }],
          replyTo: [],
          to: [{ name: null, address: fixture.account }],
          cc: [],
          bcc: [],
        },
        mimeStructure: {},
      });
    }
    await expect(syncFolderBatch(fixture.folderId, noHeartbeat)).resolves.toMatchObject({ imported: count, hasMore: false });
  };

  const unhydrated = async (fixtures: SyncFixture[]): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM mail.message_contents
      WHERE mailbox_id = ANY(${toPgUuidArray(fixtures.map((fixture) => fixture.mailboxId))}::uuid[])
        AND hydration_status <> 'complete'
    `;
    return row?.count ?? 0;
  };

  beforeAll(async () => {
    await migrate();
    const uid = `mail-hydration-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create the hydration test user");
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
      requestId: `mail-hydration-${suffix}`,
    };

    spies.push(
      spyOn(imapSmtpConnector, "getFolderStatus").mockImplementation(async (config) => {
        const messages = inboxes.get(config.username)?.length ?? 0;
        return { uidValidity: "10", uidNext: messages + 1, highestModseq: "1", messages };
      }),
      spyOn(imapSmtpConnector, "fetchEnvelopeBatch").mockImplementation(async (config, request) => {
        const lowUid = request.lowUid ?? 1;
        const messages = (inboxes.get(config.username) ?? [])
          .filter((message) => Number(message.remoteRef.uid) >= lowUid && Number(message.remoteRef.uid) <= request.highUid)
          .toReversed()
          .slice(0, request.limit);
        return { messages, nextHighUid: null };
      }),
      spyOn(imapSmtpConnector, "downloadSourceBatch").mockImplementation(async (config, _folderPath, requests, consume) => {
        downloads.push(labels.get(config.username) ?? config.username);
        await downloadGate;
        for (const request of requests) {
          if (expunged.has(request.key)) continue;
          const source = sourceFor(request.key);
          await consume({ ...request, expectedSize: Buffer.byteLength(source), stream: Readable.from([source]) });
        }
      }),
    );
    await startHydrationRuntime();
  });

  afterAll(async () => {
    await stopHydrationRuntime();
    for (const spy of spies) spy.mockRestore();
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("new mail in a small mailbox waits for one batch of another mailbox's backlog, not for the whole backlog", async () => {
    const blocker = await createSyncedMailbox("blocker");
    const big = await createSyncedMailbox("big");
    const small = await createSyncedMailbox("small");
    // The blocker's message is not imported by a sync, so only the explicit request below queues it.
    const [blockerMessage] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (
        ${newShortId()}, ${blocker.mailboxId}::uuid, ${`<blocker-${suffix}@example.test>`}, 'Blocker', now(), 256,
        ${sha256Json({ fixture: "hydration-blocker", suffix })}, 'envelope'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${blocker.folderId}::uuid, ${blockerMessage!.id}::uuid, 10, 1)
    `;
    let openGate = (): void => undefined;
    downloadGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    downloads.length = 0;
    try {
      // The single hydration worker slot stays busy with the blocker until every mailbox has queued its work.
      await enqueueMessageHydration(blockerMessage!.id);
      // 60 bodies are three source batches of 20.
      await deliver(big, 60);
      await deliver(small, 1);
    } finally {
      openGate();
    }
    await waitFor(async () => (await unhydrated([blocker, big, small])) === 0);
    // Mailboxes take turns one batch at a time: the small mailbox's new message follows the big mailbox's first batch.
    expect(downloads).toEqual(["blocker", "big", "small", "big", "big"]);
  });

  test("hydration of new mail starts after the folder sync that imported it released the provider lease", async () => {
    const fixture = await createSyncedMailbox("new-mail");
    const mutex = mailProviderOperationMutex();
    const acquire = mutex.acquire.bind(mutex);
    const outcomes: string[] = [];
    const acquisitions = spyOn(mutex, "acquire").mockImplementation(async (options) => {
      const lock = await acquire(options);
      if (options.resource === fixture.resourceId) outcomes.push(lock ? "acquired" : "busy");
      return lock;
    });
    try {
      // One folder sync imports several new messages at once, as after a push notification for a burst of mail.
      await deliver(fixture, 10);
      await waitFor(async () => (await unhydrated([fixture])) === 0);
    } finally {
      acquisitions.mockRestore();
    }
    // The folder sync, then one hydration batch; a hydration that found the sync still holding the lease would wait 5-30 s.
    expect(outcomes).toEqual(["acquired", "acquired"]);
  });

  test("a message the provider no longer has neither fails nor holds back the rest of its mailbox", async () => {
    const fixture = await createSyncedMailbox("expunged");
    let openGate = (): void => undefined;
    downloadGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    try {
      await deliver(fixture, 3);
      // Another client expunges the newest message before its body is fetched.
      const [newest] = await sql<{ id: string }[]>`
        SELECT id FROM mail.message_contents WHERE mailbox_id = ${fixture.mailboxId}::uuid ORDER BY internal_date DESC LIMIT 1
      `;
      expunged.add(newest!.id);
    } finally {
      openGate();
    }
    // Folder reconciliation, which owns retiring the vanished reference, is asked to cover its UID.
    const reconcileRequested = async (): Promise<boolean> => {
      const [folder] = await sql<{ reconcile_next_low: string | null }[]>`
        SELECT envelope_cursor ->> 'reconcileNextLow' AS reconcile_next_low FROM mail.folders WHERE id = ${fixture.folderId}::uuid
      `;
      return folder?.reconcile_next_low === "1";
    };
    await waitFor(async () => (await unhydrated([fixture])) === 1 && (await reconcileRequested()));
    const states = await sql<{ hydration_status: string; hydration_attempt: number }[]>`
      SELECT hydration_status, hydration_attempt
      FROM mail.message_contents
      WHERE mailbox_id = ${fixture.mailboxId}::uuid
      ORDER BY internal_date DESC
    `;
    expect(states).toEqual([
      { hydration_status: "envelope", hydration_attempt: 0 },
      { hydration_status: "complete", hydration_attempt: 1 },
      { hydration_status: "complete", hydration_attempt: 1 },
    ]);
  });
});
