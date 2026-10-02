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
import {
  enqueueMessageHydration,
  startHydrationRuntime,
  stopHydrationRuntime,
  submitDueHydrationWork,
  syncFolderBatch,
} from "./sync-runtime";

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

// A hydration job that fails retries after 10 s at the earliest. Waiting less proves that new mail
// did not wait for such a retry.
const BEFORE_FIRST_RETRY_MS = 8_000;

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

type SyncFixture = { label: string; account: string; mailboxId: string; resourceId: string; bindingId: string; folderId: string };

type HydrationState = { hydration_status: string; hydration_attempt: number; hydration_error_code: string | null };

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
  // Messages whose source stream breaks off mid-transfer.
  const broken = new Set<string>();
  // Accounts whose next source download fails before the first message.
  const unreachable = new Set<string>();
  const downloads: string[] = [];
  // Every message requested from the provider, in request order.
  const fetched: string[] = [];
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
    const fixture = { label, account, mailboxId: mailbox.data.id, resourceId: resource!.id, bindingId: binding!.id, folderId: folder!.id };
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

  // Holds every source download until `work` has finished, so the test can shape the provider first.
  const withDownloadsHeld = async (work: () => Promise<void>): Promise<void> => {
    let release = (): void => undefined;
    downloadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await work();
    } finally {
      release();
    }
  };

  const newestMessageId = async (fixture: SyncFixture): Promise<string> => {
    const [newest] = await sql<{ id: string }[]>`
      SELECT id FROM mail.message_contents WHERE mailbox_id = ${fixture.mailboxId}::uuid ORDER BY internal_date DESC LIMIT 1
    `;
    return newest!.id;
  };

  const hydrationState = async (messageId: string): Promise<HydrationState | undefined> => {
    const [state] = await sql<HydrationState[]>`
      SELECT hydration_status, hydration_attempt, hydration_error_code FROM mail.message_contents WHERE id = ${messageId}::uuid
    `;
    return state;
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
        if (unreachable.delete(config.username)) {
          throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
        }
        for (const request of requests) {
          fetched.push(request.key);
          if (expunged.has(request.key)) continue;
          const source = sourceFor(request.key);
          const stream = broken.has(request.key)
            ? new Readable({
                read() {
                  this.destroy(Object.assign(new Error("Connection reset while streaming the source"), { code: "ECONNRESET" }));
                },
              })
            : Readable.from([source]);
          await consume({ ...request, expectedSize: Buffer.byteLength(source), stream });
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
    downloads.length = 0;
    // The single hydration worker slot stays busy with the blocker until every mailbox has queued its work.
    await withDownloadsHeld(async () => {
      await enqueueMessageHydration(blockerMessage!.id);
      // 60 bodies are three source batches of 20.
      await deliver(big, 60);
      await deliver(small, 1);
    });
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
    // The folder sync, then one hydration batch; a hydration that found the sync still holding the lease would have to wait and try again.
    expect(outcomes).toEqual(["acquired", "acquired"]);
  });

  test("a message the provider no longer has neither fails nor holds back the rest of its mailbox", async () => {
    const fixture = await createSyncedMailbox("expunged");
    await withDownloadsHeld(async () => {
      await deliver(fixture, 3);
      // Another client expunges the newest message before its body is fetched.
      expunged.add(await newestMessageId(fixture));
    });
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
    // The fetch without a source used one attempt, but the message did not fail.
    expect(states).toEqual([
      { hydration_status: "envelope", hydration_attempt: 1 },
      { hydration_status: "complete", hydration_attempt: 1 },
      { hydration_status: "complete", hydration_attempt: 1 },
    ]);
  });

  test("a body that fails neither holds back the mailbox's next new mail nor is retried back to back", async () => {
    const fixture = await createSyncedMailbox("failing-body");
    const sentinel = await createSyncedMailbox("sentinel-body");
    let failing = "";
    await withDownloadsHeld(async () => {
      await deliver(fixture, 1);
      failing = await newestMessageId(fixture);
      broken.add(failing);
    });
    // The single worker takes jobs in order: once the sentinel's body is in, the failing batch has finished.
    await deliver(sentinel, 1);
    await waitFor(async () => (await unhydrated([sentinel])) === 0);
    await deliver(fixture, 1);
    const fresh = await newestMessageId(fixture);
    await waitFor(async () => (await hydrationState(fresh))?.hydration_status === "complete", BEFORE_FIRST_RETRY_MS);
    // Another sentinel round: a job that queued itself again for the failed body would have run first.
    await deliver(sentinel, 1);
    await waitFor(async () => (await unhydrated([sentinel])) === 0);
    expect(await hydrationState(failing)).toEqual({ hydration_status: "failed", hydration_attempt: 1, hydration_error_code: "ECONNRESET" });
    expect(fetched.filter((messageId) => messageId === failing || messageId === fresh)).toEqual([failing, fresh]);
  });

  test("a batch that fails at the provider does not hold back the next sync's new mail", async () => {
    const fixture = await createSyncedMailbox("provider-failure");
    const sentinel = await createSyncedMailbox("sentinel-provider");
    unreachable.add(fixture.account);
    await deliver(fixture, 1);
    // The single worker takes jobs in order: once the sentinel's body is in, the failed batch has finished.
    await deliver(sentinel, 1);
    await waitFor(async () => (await unhydrated([sentinel])) === 0);
    await deliver(fixture, 1);
    await waitFor(async () => (await unhydrated([fixture])) === 0, BEFORE_FIRST_RETRY_MS);
  });

  test("a message the provider lists but never delivers does not hold back the mailbox's other folders", async () => {
    const fixture = await createSyncedMailbox("phantom");
    // An older missing body in a second folder of the same mailbox.
    const [archive] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role)
      VALUES (${newShortId()}, ${fixture.resourceId}::uuid, 'Archive:10', 'Archive', 'archive')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, highest_modseq, effective_rights, rights_source, last_verified_at
      ) VALUES (
        ${fixture.bindingId}::uuid, ${archive!.id}::uuid, 'Archive', 10, 2, 1, ARRAY['read']::text[], 'acl', now()
      )
    `;
    const [archived] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (
        ${newShortId()}, ${fixture.mailboxId}::uuid, ${`<archived-${suffix}@example.test>`}, 'Archived', '2025-06-01T00:00:00Z', 256,
        ${sha256Json({ fixture: "hydration-archived", suffix })}, 'envelope'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${archive!.id}::uuid, ${archived!.id}::uuid, 10, 1)
    `;
    let phantom = "";
    await withDownloadsHeld(async () => {
      await deliver(fixture, 1);
      // The provider keeps listing the new message but answers its FETCH without a source, and no
      // folder reconciliation runs here that could retire it.
      phantom = await newestMessageId(fixture);
      expunged.add(phantom);
    });
    await waitFor(async () => (await hydrationState(archived!.id))?.hydration_status === "complete");
    expect(await hydrationState(phantom)).toEqual({
      hydration_status: "envelope",
      hydration_attempt: 1,
      hydration_error_code: "MESSAGE_SOURCE_MISSING",
    });
    // Only the `mail:sync-due` tick retries it; the fifth fetch without a source fails it for good.
    await waitFor(async () => {
      if ((await hydrationState(phantom))?.hydration_status === "failed") return true;
      await submitDueHydrationWork();
      return false;
    });
    expect(fetched.filter((messageId) => messageId === phantom)).toHaveLength(5);
    expect(await hydrationState(phantom)).toEqual({
      hydration_status: "failed",
      hydration_attempt: 5,
      hydration_error_code: "MESSAGE_SOURCE_MISSING",
    });
  });
});
