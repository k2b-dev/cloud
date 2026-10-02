import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import type { JobContext } from "@k2b/sync";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, type RemoteFolder, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { runMailboxCommandsJob, startCommandWorkers, stopCommandWorkers } from "./command-runtime";
import { createActorCommand, createMailCommand } from "./commands";
import { type ConnectorEnvelope, imapSmtpConnector } from "./connectors";
import { createDraft } from "./drafts";
import { createMailbox } from "./mailboxes";
import { runMaintenanceJob } from "./maintenance-runtime";
import { createProviderConnection } from "./provider-connections";
import { acquireProviderLease, MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex } from "./provider-operation-lock";
import {
  enqueueFolderSync,
  enqueueMailboxHydration,
  runSyncFolderJob,
  startHydrationRuntime,
  stopHydrationRuntime,
  syncFolderBatch,
} from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");

const INBOX = "INBOX";
const ARCHIVE = "Archive";
const SENT = "Sent";
const FOLDER_RIGHTS = ["read", "write_flags", "insert", "move", "delete_messages"];

// Every provider round trip of this fixture takes this long, like a remote IMAP server.
const ROUND_TRIP_MS = 15;

type StoredMessage = { messageId: string; subject: string; internalDate: Date };
// `modseq` grows with every change, like HIGHESTMODSEQ on a server with CONDSTORE.
type StoredFolder = { uidValidity: string; nextUid: number; modseq: number; entries: Map<number, StoredMessage> };
type Account = { label: string; condstore: boolean; folders: Map<string, StoredFolder> };

type Mailbox = {
  account: string;
  mailboxId: string;
  identityId: string;
  bindingId: string;
  remoteResourceId: string;
  folderId: (path: string) => string;
};

const verification = (account: string, condstore: boolean): ConnectorVerification => ({
  authenticatedPrincipal: account,
  serverIdentity: { serverInfo: { name: "fixture" } },
  capabilities: {
    idle: true,
    condstore,
    qresync: false,
    move: true,
    uidplus: true,
    namespace: true,
    listExtended: true,
    specialUse: true,
    acl: false,
    notify: false,
    quota: false,
    gmailExtensions: false,
  },
  limits: unavailableProviderLimitSnapshot(),
  accounts: [{ id: account, name: account, locator: {}, namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }] }],
});

const sourceOf = (message: StoredMessage): string =>
  [
    `Message-ID: ${message.messageId}`,
    "From: sender@example.test",
    "To: owner@example.test",
    `Subject: ${message.subject}`,
    `Date: ${message.internalDate.toUTCString()}`,
    "",
    `Body of ${message.subject}`,
  ].join("\r\n");

const waitFor = async (ready: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

type SyncFolderJobInput = { folderId: string; backfill?: boolean };

/**
 * Runs one `mail:sync-folder` job the way its worker does: a resubmitted job runs again after its
 * delay, until it finishes, or with `oneBatch` until one batch got the provider lease. Returns
 * how long that took.
 */
const runFolderSyncJob = async (folderId: string, options: { input?: SyncFolderJobInput; oneBatch?: boolean } = {}): Promise<number> => {
  const startedAt = performance.now();
  let input: SyncFolderJobInput = options.input ?? { folderId };
  for (let run = 0; run < 200; run += 1) {
    let next: number | null = null;
    const ctx: Pick<JobContext<SyncFolderJobInput>, "input" | "heartbeat" | "resubmit"> = {
      input,
      heartbeat: async () => undefined,
      resubmit: (resubmit) => {
        next = resubmit?.delayMs ?? 0;
        if (resubmit?.input) input = resubmit.input;
      },
    };
    await runSyncFolderJob(ctx);
    // A batch that ran continues at once; one that found the provider lease busy waits for its turn.
    if (next === null || (options.oneBatch && next === 0)) return performance.now() - startedAt;
    await Bun.sleep(next);
  }
  throw new Error("The folder sync job did not finish");
};

suite("mail provider lease fairness", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const accounts = new Map<string, Account>();
  const mailboxIds: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  // Every source download in call order, by mailbox label.
  const downloads: string[] = [];
  const sends: string[] = [];
  // Every CHANGEDSINCE flag window, by mailbox label.
  const flagWindows: string[] = [];
  let hydrationStarted = false;
  const ensureHydrationRuntime = async (): Promise<void> => {
    if (hydrationStarted) return;
    hydrationStarted = true;
    await startHydrationRuntime();
  };
  let userId = "";
  let context: MailRequestContext;

  const folderOf = (account: string, path: string): StoredFolder => {
    const folder = accounts.get(account)?.folders.get(path);
    if (!folder) throw Object.assign(new Error(`No folder ${path}`), { responseStatus: "NO" });
    return folder;
  };

  const store = (account: string, path: string, message: StoredMessage): number => {
    const folder = folderOf(account, path);
    const uid = folder.nextUid++;
    folder.entries.set(uid, message);
    folder.modseq += 1;
    return uid;
  };

  const highestModseq = (account: string, folder: StoredFolder): string | null =>
    accounts.get(account)?.condstore ? String(folder.modseq) : null;

  const deliver = (mailbox: Mailbox, count: number, label: string): string[] => {
    const messageIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const messageId = `<${label}-${index}-${suffix}@example.test>`;
      store(mailbox.account, INBOX, {
        messageId,
        subject: `${label} ${index}`,
        internalDate: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
      });
      messageIds.push(messageId);
    }
    return messageIds;
  };

  const envelopeOf = (account: string, path: string, folderStableKey: string, uid: number): ConnectorEnvelope => {
    const folder = folderOf(account, path);
    const message = folder.entries.get(uid)!;
    return {
      remoteRef: { folderStableKey, uidValidity: folder.uidValidity, uid: String(uid), modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId: message.messageId,
      inReplyTo: null,
      references: [],
      subject: message.subject,
      sentAt: message.internalDate,
      internalDate: message.internalDate,
      sizeBytes: Buffer.byteLength(sourceOf(message)),
      flags: [],
      labels: [],
      addresses: {
        from: [{ name: null, address: "sender@example.test" }],
        replyTo: [],
        to: [{ name: null, address: account }],
        cc: [],
        bcc: [],
      },
      mimeStructure: {},
    };
  };

  const remoteFolders = (account: string): RemoteFolder[] =>
    [INBOX, ARCHIVE, SENT].map((path) => {
      const folder = folderOf(account, path);
      return {
        stableKey: `${path}:${folder.uidValidity}`,
        path,
        name: path,
        delimiter: "/",
        parentPath: null,
        role: path === INBOX ? "inbox" : path === SENT ? "sent" : "archive",
        subscribed: true,
        selectable: true,
        uidValidity: folder.uidValidity,
        uidNext: String(folder.nextUid),
        highestModseq: highestModseq(account, folder),
        rights: FOLDER_RIGHTS,
        rightsSource: "select",
      };
    });

  /**
   * A mailbox on its own in-memory IMAP account, with INBOX, Archive, and Sent discovered and INBOX
   * synced. `firstInboxUid` gives INBOX the UID history of an older account.
   */
  const connect = async (label: string, options: { condstore?: boolean; firstInboxUid?: number } = {}): Promise<Mailbox> => {
    const account = `${label}-${suffix}@example.test`;
    const condstore = options.condstore ?? false;
    accounts.set(account, {
      label,
      condstore,
      folders: new Map(
        [INBOX, ARCHIVE, SENT].map((path, index) => [
          path,
          {
            uidValidity: String(10 + index),
            nextUid: path === INBOX ? (options.firstInboxUid ?? 1) : 1,
            modseq: 1,
            entries: new Map(),
          },
        ]),
      ),
    });
    const mailbox = await createMailbox(context, { name: `Lease ${label} ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(verification(account, condstore));
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => remoteFolders(account));
    let bindingId = "";
    try {
      const connection = await createProviderConnection({
        context,
        mailboxId: mailbox.data.id,
        input: {
          name: `Lease ${label}`,
          email: account,
          username: account,
          imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);
      const folders = remoteFolders(account);
      const evidence = {
        version: 1,
        serverKey: sha256Json({ host: "imap.example.test", port: 993, tlsMode: "implicit", serverInfo: { name: "fixture" } }),
        accountId: account,
        namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }],
        folders: folders.map((folder) => ({
          relativePath: folder.path,
          parentRelativePath: folder.parentPath,
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
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status, discovery_generation)
        VALUES (${mailbox.data.id}::uuid, ${{ accountId: account }}::jsonb, '{}'::jsonb, ${scope}, 'active', 0)
        RETURNING id
      `;
      const [binding] = await sql<{ id: string }[]>`
        INSERT INTO mail.provider_bindings (
          remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
          capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
        ) VALUES (
          ${resource!.id}::uuid, ${connection.data.connection.id}::uuid, 'active', ${account},
          ${{ accountId: account }}::jsonb, ${verification(account, condstore).capabilities}::jsonb, '{}'::jsonb,
          ${evidence}::jsonb, ${scope}, 1, now()
        ) RETURNING id
      `;
      bindingId = binding!.id;
      await rediscoverProviderBinding({ bindingId });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
    const folders = await sql<{ id: string; remote_path: string }[]>`
      SELECT folder_id AS id, remote_path FROM mail.binding_folder_refs WHERE binding_id = ${bindingId}::uuid
    `;
    const [remoteResource] = await sql<{ id: string }[]>`
      SELECT id FROM mail.remote_resources WHERE mailbox_id = ${mailbox.data.id}::uuid
    `;
    const folderId = (path: string): string => {
      const found = folders.find((entry) => entry.remote_path === path);
      if (!found) throw new Error(`Folder ${path} was not discovered`);
      return found.id;
    };
    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (
        short_id, mailbox_id, label, display_name, from_address, automation_policy, is_default, status, sent_folder_id
      ) VALUES (
        ${newShortId()}, ${mailbox.data.id}::uuid, 'Owner', 'Owner', ${account}, 'mailbox', true, 'verified', ${folderId(SENT)}::uuid
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.sender_identity_bindings (sender_identity_id, binding_id, provider_principal, verified_at, saves_sent_automatically)
      VALUES (${identity!.id}::uuid, ${bindingId}::uuid, ${account}, now(), false)
    `;
    const connected = {
      account,
      mailboxId: mailbox.data.id,
      identityId: identity!.id,
      bindingId,
      remoteResourceId: remoteResource!.id,
      folderId,
    };
    // The first sync of the empty INBOX records its cursor, so later messages arrive as new mail.
    for (let batch = 0; batch < 20; batch += 1) {
      if (!(await syncFolderBatch(folderId(INBOX), async () => undefined)).hasMore) break;
    }
    return connected;
  };

  /** Delivers messages and imports their envelopes with direct folder syncs. */
  const deliverAndSync = async (mailbox: Mailbox, count: number, label: string): Promise<string[]> => {
    const messageIds = deliver(mailbox, count, label);
    for (let batch = 0; batch < 20; batch += 1) {
      const result = await syncFolderBatch(mailbox.folderId(INBOX), async () => undefined);
      if (!result.hasMore) break;
    }
    return messageIds;
  };

  const imported = async (mailbox: Mailbox, messageId: string): Promise<boolean> => {
    const [message] = await sql<{ id: string }[]>`
      SELECT id FROM mail.message_contents WHERE mailbox_id = ${mailbox.mailboxId}::uuid AND message_id = ${messageId}
    `;
    return Boolean(message);
  };

  /** Queues one move to Archive per message, as a bulk move in the web UI does. */
  const queueMoves = async (mailbox: Mailbox, messageIds: string[], label: string): Promise<string[]> => {
    const messages = await sql<{ id: string }[]>`
      SELECT id FROM mail.message_contents
      WHERE mailbox_id = ${mailbox.mailboxId}::uuid AND message_id IN ${sql(messageIds)}
      ORDER BY internal_date DESC
    `;
    expect(messages).toHaveLength(messageIds.length);
    const commandIds: string[] = [];
    for (const [index, message] of messages.entries()) {
      const command = await createActorCommand({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          kind: "move",
          messageId: message.id,
          sourceFolderId: mailbox.folderId(INBOX),
          destinationFolderId: mailbox.folderId(ARCHIVE),
          idempotencyKey: `${label}-${index}-${suffix}`,
        },
      });
      if (!command.ok) throw new Error(JSON.stringify(command.error));
      commandIds.push(command.data.id);
    }
    return commandIds;
  };

  const commandStates = async (commandIds: string[]): Promise<Record<string, number>> => {
    const rows = await sql<{ state: string; count: number }[]>`
      SELECT state, count(*)::int AS count FROM mail.commands WHERE id IN ${sql(commandIds)} GROUP BY state
    `;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  };

  const pending = async (commandIds: string[]): Promise<number> => {
    const states = await commandStates(commandIds);
    return (states.queued ?? 0) + (states.executing ?? 0) + (states.ambiguous ?? 0);
  };

  const confirmed = async (commandIds: string[]): Promise<number> => (await commandStates(commandIds)).confirmed ?? 0;

  beforeAll(async () => {
    await migrate();
    const uid = `mail-lease-fairness-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create the lease fairness test user");
    userId = user.id;
    context = {
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
      requestId: `mail-lease-fairness-${suffix}`,
    };

    spies.push(
      spyOn(imapSmtpConnector, "getFolderStatus").mockImplementation(async (config, path) => {
        await Bun.sleep(ROUND_TRIP_MS);
        const folder = folderOf(config.username, path);
        return {
          uidValidity: folder.uidValidity,
          uidNext: folder.nextUid,
          highestModseq: highestModseq(config.username, folder),
          messages: folder.entries.size,
        };
      }),
      spyOn(imapSmtpConnector, "fetchEnvelopeBatch").mockImplementation(async (config, request) => {
        // Archive holds a large backlog of old mail, and each batch of it takes a while.
        await Bun.sleep(request.folderPath === ARCHIVE ? 20 * ROUND_TRIP_MS : ROUND_TRIP_MS);
        const folder = folderOf(config.username, request.folderPath);
        const low = request.lowUid ?? 1;
        const uids = [...folder.entries.keys()]
          .filter((uid) => (request.uids ? request.uids.includes(uid) : uid >= low && uid <= request.highUid))
          .sort((left, right) => right - left);
        const selected = uids.slice(0, request.limit);
        const remaining = uids.slice(request.limit);
        return {
          messages: selected.map((uid) => envelopeOf(config.username, request.folderPath, request.folderStableKey, uid)),
          nextHighUid: remaining.length > 0 ? remaining[0]! : null,
        };
      }),
      spyOn(imapSmtpConnector, "fetchFlagChanges").mockImplementation(async (config) => {
        await Bun.sleep(ROUND_TRIP_MS);
        flagWindows.push(accounts.get(config.username)?.label ?? config.username);
        return [];
      }),
      spyOn(imapSmtpConnector, "fetchUidWindow").mockImplementation(async (config, path, _uidValidity, low, high) => {
        await Bun.sleep(ROUND_TRIP_MS);
        return [...folderOf(config.username, path).entries.keys()]
          .filter((uid) => uid >= low && uid <= high)
          .sort((left, right) => left - right)
          .map((uid) => ({ uid, modseq: null, flags: [], labels: [] }));
      }),
      spyOn(imapSmtpConnector, "getMessageState").mockImplementation(async (config, target) => {
        await Bun.sleep(ROUND_TRIP_MS);
        const message = folderOf(config.username, target.folderPath).entries.get(target.uid);
        return { exists: Boolean(message), flags: [], keywords: [], messageId: message?.messageId ?? null, modseq: null };
      }),
      spyOn(imapSmtpConnector, "findMessageById").mockImplementation(async (config, path, messageId) => {
        await Bun.sleep(ROUND_TRIP_MS);
        return [...folderOf(config.username, path).entries.entries()]
          .filter(([, message]) => message.messageId.toLowerCase() === messageId.trim().toLowerCase())
          .map(([uid]) => uid);
      }),
      spyOn(imapSmtpConnector, "move").mockImplementation(async (config, target, destinationPath) => {
        await Bun.sleep(ROUND_TRIP_MS);
        const source = folderOf(config.username, target.folderPath);
        const message = source.entries.get(target.uid);
        if (!message) throw Object.assign(new Error("No such message"), { responseStatus: "NO" });
        source.entries.delete(target.uid);
        source.modseq += 1;
        const uid = store(config.username, destinationPath, message);
        return { destinationUidValidity: folderOf(config.username, destinationPath).uidValidity, destinationUid: uid };
      }),
      spyOn(imapSmtpConnector, "downloadSourceBatch").mockImplementation(async (config, path, requests, consume) => {
        downloads.push(accounts.get(config.username)?.label ?? config.username);
        // A batch of bodies takes a while, like a large download.
        await Bun.sleep(20 * ROUND_TRIP_MS);
        for (const request of requests) {
          const message = folderOf(config.username, path).entries.get(request.uid);
          if (!message) continue;
          const source = sourceOf(message);
          await consume({ ...request, expectedSize: Buffer.byteLength(source), stream: Readable.from([source]) });
        }
      }),
      spyOn(imapSmtpConnector, "sendSource").mockImplementation(async (config, request) => {
        await Bun.sleep(ROUND_TRIP_MS);
        sends.push(accounts.get(config.username)?.label ?? config.username);
        return { accepted: request.recipients, rejected: [], response: "250 2.0.0 OK", messageId: request.messageId };
      }),
      spyOn(imapSmtpConnector, "appendSource").mockImplementation(async (config, path, source) => {
        await Bun.sleep(ROUND_TRIP_MS);
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        const messageId = /^Message-ID:\s*(.+)$/im.exec(Buffer.concat(chunks).toString("utf8"))?.[1]?.trim() ?? "";
        const uid = store(config.username, path, { messageId, subject: "Sent", internalDate: new Date() });
        return { uidValidity: folderOf(config.username, path).uidValidity, uid };
      }),
    );
    await startCommandWorkers();
  });

  afterAll(async () => {
    await stopCommandWorkers();
    if (hydrationStarted) await stopHydrationRuntime();
    for (const spy of spies) spy.mockRestore();
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("new mail arrives within one folder sync while a few hundred moves drain, and other mailboxes keep working", async () => {
    // An older account on a server with CONDSTORE: every move raises INBOX's HIGHESTMODSEQ, so each
    // sync also checks flags across five UID windows.
    const busy = await connect("busy", { condstore: true, firstInboxUid: 20_001 });
    const other = await connect("other");
    const backlog = await deliverAndSync(busy, 300, "backlog");
    const [otherMessage] = await deliverAndSync(other, 1, "other");
    const draft = await createDraft({
      context,
      mailboxId: other.mailboxId,
      input: {
        senderIdentityId: other.identityId,
        to: [{ name: "Customer", address: "customer@example.test" }],
        cc: [],
        bcc: [],
        subject: "Meeting on Monday",
        body: "See you on Monday.",
        format: "plain",
        intent: "new",
      },
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft.error));

    const moves = await queueMoves(busy, backlog, "bulk-move");
    await waitFor(async () => (await confirmed(moves)) >= 3, "the bulk move to start");

    // New mail for the busy mailbox comes in with each folder sync, not after the backlog. Several
    // rounds, because a sync that only gets in when it happens to try between two moves can be lucky once.
    for (let round = 0; round < 3; round += 1) {
      const [newMail] = deliver(busy, 1, `new-mail-${round}`);
      const windowsBefore = flagWindows.filter((label) => label === "busy").length;
      const syncMs = await runFolderSyncJob(busy.folderId(INBOX));
      expect(await imported(busy, newMail!)).toBe(true);
      expect(flagWindows.filter((label) => label === "busy").length - windowsBefore).toBeGreaterThanOrEqual(5);
      expect(syncMs).toBeLessThan(5_000);
    }

    // Another mailbox's move and send run while the backlog drains.
    const startedAt = performance.now();
    const [otherMove] = await queueMoves(other, [otherMessage!], "other-move");
    const [current] = await sql<{ revision: number }[]>`SELECT revision::int FROM mail.drafts WHERE id = ${draft.data.id}::uuid`;
    const send = await createActorCommand({
      context,
      mailboxId: other.mailboxId,
      input: {
        kind: "send",
        draftId: draft.data.id,
        expectedDraftRevision: current!.revision,
        senderIdentityId: other.identityId,
        undoSeconds: 0,
        idempotencyKey: `other-send-${suffix}`,
      },
    });
    if (!send.ok) throw new Error(`${send.error.code}: ${send.error.message}`);
    await waitFor(
      async () => (await confirmed([otherMove!])) === 1 && sends.includes("other"),
      "the other mailbox's move and send",
      10_000,
    );
    expect(performance.now() - startedAt).toBeLessThan(5_000);

    // The backlog was still draining all along, and keeps draining after the sync took its turn.
    const remaining = await pending(moves);
    expect(remaining).toBeGreaterThan(200);
    await waitFor(async () => (await pending(moves)) < remaining, "the bulk move to continue");
  }, 120_000);

  test("a folder that backfills old mail holds back neither new mail in another folder nor the mailbox's commands", async () => {
    const mailbox = await connect("backfilling");
    const [toArchive] = await deliverAndSync(mailbox, 1, "to-archive");
    // Ten envelope batches of old mail wait in Archive; its sync goes on batch after batch.
    for (let index = 0; index < 2_000; index += 1) {
      store(mailbox.account, ARCHIVE, {
        messageId: `<archived-${index}-${suffix}@example.test>`,
        subject: `Archived ${index}`,
        internalDate: new Date(Date.UTC(2025, 0, 1) + index * 60_000),
      });
    }
    let backfillDone = false;
    const backfill = runFolderSyncJob(mailbox.folderId(ARCHIVE)).then(() => {
      backfillDone = true;
    });
    await waitFor(async () => {
      const [count] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM mail.message_contents WHERE mailbox_id = ${mailbox.mailboxId}::uuid
        `;
      return (count?.count ?? 0) >= 200;
    }, "the Archive backfill to start");

    const [newMail] = deliver(mailbox, 1, "during-backfill");
    const syncMs = await runFolderSyncJob(mailbox.folderId(INBOX));
    expect(await imported(mailbox, newMail!)).toBe(true);
    expect(syncMs).toBeLessThan(5_000);

    // Older mail is background work: a move goes before the backfill's next batch.
    const startedAt = performance.now();
    const [move] = await queueMoves(mailbox, [toArchive!], "during-backfill-move");
    await waitFor(async () => (await confirmed([move!])) === 1, "the move during the backfill", 10_000);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(backfillDone).toBe(false);
    await backfill;
  }, 120_000);

  test("a mailbox's body hydration cannot keep its folder sync from bringing in new mail", async () => {
    const mailbox = await connect("hydrating");
    // 200 bodies are ten hydration batches; each batch takes a while.
    await deliverAndSync(mailbox, 200, "bodies");
    downloads.length = 0;
    await ensureHydrationRuntime();
    await enqueueMailboxHydration(mailbox.mailboxId);
    await waitFor(async () => downloads.length >= 2, "hydration to start");

    const [newMail] = deliver(mailbox, 1, "during-hydration");
    const syncMs = await runFolderSyncJob(mailbox.folderId(INBOX));
    expect(await imported(mailbox, newMail!)).toBe(true);
    expect(syncMs).toBeLessThan(5_000);
    const [unhydrated] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mail.message_contents
      WHERE mailbox_id = ${mailbox.mailboxId}::uuid AND hydration_status <> 'complete'
    `;
    expect(unhydrated?.count).toBeGreaterThan(20);
    // Hydration takes its turns again once the sync is done.
    const before = downloads.length;
    await waitFor(async () => downloads.length > before, "hydration to continue");
  }, 120_000);

  test("a sync requested for a folder that backfills old mail goes before the mailbox's commands", async () => {
    await ensureHydrationRuntime();
    const mailbox = await connect("requested");
    const backlog = await deliverAndSync(mailbox, 100, "requested-backlog");
    for (let index = 0; index < 2_000; index += 1) {
      store(mailbox.account, ARCHIVE, {
        messageId: `<requested-archived-${index}-${suffix}@example.test>`,
        subject: `Archived ${index}`,
        internalDate: new Date(Date.UTC(2025, 0, 1) + index * 60_000),
      });
    }
    // Archive's job has started importing old mail; its next batch would be background work.
    expect((await syncFolderBatch(mailbox.folderId(ARCHIVE), async () => undefined)).hasMore).toBe(true);
    const moves = await queueMoves(mailbox, backlog, "requested-move");
    await waitFor(async () => (await confirmed(moves)) >= 3, "the moves to start");

    // A requested sync joins that job; its next batch ranks as a folder sync and goes first.
    await enqueueFolderSync(mailbox.folderId(ARCHIVE));
    const batchMs = await runFolderSyncJob(mailbox.folderId(ARCHIVE), {
      input: { folderId: mailbox.folderId(ARCHIVE), backfill: true },
      oneBatch: true,
    });
    expect(batchMs).toBeLessThan(5_000);
    const remaining = await pending(moves);
    expect(remaining).toBeGreaterThan(50);
    await waitFor(async () => (await pending(moves)) < remaining, "the moves to continue");
  }, 120_000);

  test("a waiter that comes back late does not keep a free provider lease from the others and keeps its place", async () => {
    const resource = crypto.randomUUID();
    const take = (waiter: string, priority: "sync" | "command") =>
      acquireProviderLease({ resource, waiter, priority, ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS });
    const held = await mailProviderOperationMutex().acquire({ resource, ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS });
    expect(held).not.toBeNull();
    // A folder sync is next in line, but its job does not come back for a long time.
    expect((await take("late-sync", "sync")).lock).toBeNull();
    const startedAt = performance.now();
    let command = await take("waiting-command", "command");
    expect(command.lock).toBeNull();
    await mailProviderOperationMutex().release(held!);

    // The command keeps trying when it is told to and gets the free lease once the sync is overdue.
    while (!command.lock) {
      await Bun.sleep(command.retryAfterMs);
      command = await take("waiting-command", "command");
    }
    expect(performance.now() - startedAt).toBeLessThan(6_000);

    // Away for longer than ten seconds, the folder sync still goes before a later one.
    await Bun.sleep(Math.max(0, 11_000 - (performance.now() - startedAt)));
    expect((await take("later-sync", "sync")).lock).toBeNull();
    await mailProviderOperationMutex().release(command.lock);
    const back = await take("late-sync", "sync");
    expect(back.lock).not.toBeNull();
    await mailProviderOperationMutex().release(back.lock!);
  }, 30_000);

  test("folder rediscovery from Mail settings waits for its turn on a busy provider lease instead of backing off", async () => {
    const mailbox = await connect("rediscovery");
    const held = await mailProviderOperationMutex().acquire({
      resource: mailbox.remoteResourceId,
      ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    });
    expect(held).not.toBeNull();
    const command = await createMailCommand({
      context,
      mailboxId: mailbox.mailboxId,
      input: { kind: "discover_folders", bindingId: mailbox.bindingId, idempotencyKey: `rediscovery-${suffix}` },
      enqueue: false,
    });
    if (!command.ok) throw new Error(JSON.stringify(command.error));
    const input = { commandId: command.data.id, continuationAttempt: 3 };
    type Resubmitted = { delayMs: number; input?: { commandId: string; continuationAttempt?: number } };
    const runJob = async (): Promise<Resubmitted | null> => {
      let resubmitted: Resubmitted | null = null;
      await runMaintenanceJob({
        input,
        attempt: 1,
        heartbeat: async () => undefined,
        resubmit: (options) => {
          resubmitted = { delayMs: options?.delayMs ?? 0, input: options?.input };
        },
      });
      return resubmitted;
    };

    // Busy: the job tries again when the lease line says, and waiting is not a failed attempt.
    const busy = await runJob();
    expect(busy?.delayMs).toBeLessThanOrEqual(4_500);
    expect(busy?.input).toBeUndefined();
    const [queued] = await sql<{ state: string; last_error_code: string }[]>`
      SELECT state, last_error_code FROM mail.commands WHERE id = ${command.data.id}::uuid
    `;
    expect(queued).toEqual({ state: "queued", last_error_code: "SYNC_BUSY" });

    await mailProviderOperationMutex().release(held!);
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(verification(mailbox.account, false));
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => remoteFolders(mailbox.account));
    try {
      expect(await runJob()).toBeNull();
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
    const [done] = await sql<{ state: string }[]>`SELECT state FROM mail.commands WHERE id = ${command.data.id}::uuid`;
    expect(done?.state).toBe("confirmed");
  }, 60_000);

  test("a mailbox's command job looks once more for new commands before it ends", async () => {
    const mailbox = await connect("idle");
    const runTurn = async (idle: boolean): Promise<{ delayMs: number; input?: unknown } | null> => {
      let resubmitted: { delayMs: number; input?: unknown } | null = null;
      await runMailboxCommandsJob({
        input: { mailboxId: mailbox.mailboxId, idle },
        heartbeat: async () => undefined,
        resubmit: (options) => {
          resubmitted = { delayMs: options?.delayMs ?? 0, input: options?.input };
        },
      });
      return resubmitted;
    };
    expect(await runTurn(false)).toEqual({ delayMs: 2_000, input: { mailboxId: mailbox.mailboxId, idle: true } });
    expect(await runTurn(true)).toBeNull();
  }, 60_000);
});
