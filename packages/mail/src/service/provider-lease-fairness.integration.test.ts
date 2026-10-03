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
import { enqueueMailCommand, runMailboxCommandsJob, startCommandWorkers, stopCommandWorkers } from "./command-runtime";
import { createActorCommand, createMailCommand } from "./commands";
import { type ConnectorEnvelope, imapSmtpConnector, type RemoteMessageState } from "./connectors";
import { createDraft } from "./drafts";
import { createMailbox, updateMailbox } from "./mailboxes";
import { runMaintenanceJob, startMaintenanceRuntime, stopMaintenanceRuntime, submitDueMaintenanceCommands } from "./maintenance-runtime";
import { createProviderConnection } from "./provider-connections";
import { acquireProviderLease, MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex } from "./provider-operation-lock";
import {
  enqueueFolderSync,
  enqueueMailboxHydration,
  FOLDER_SYNC_REQUEST_MS,
  onSyncFolderJobError,
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
// A move takes this much longer per message it carries.
const MOVE_MS_PER_MESSAGE = 5;

type StoredMessage = { messageId: string; subject: string; internalDate: Date };
// `modseq` grows with every change, like HIGHESTMODSEQ on a server with CONDSTORE.
type StoredFolder = { uidValidity: string; nextUid: number; modseq: number; entries: Map<number, StoredMessage> };
type Account = { label: string; condstore: boolean; uidplus: boolean; folders: Map<string, StoredFolder> };

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

/**
 * Runs `mail:sync-folder` job turns until one batch got the provider lease, as `runFolderSyncJob`
 * does; returns the continuation that batch asked for.
 */
const syncFolderTurn = async (
  folderId: string,
  input: SyncFolderJobInput = { folderId },
): Promise<{ delayMs: number; input: SyncFolderJobInput } | null> => {
  for (let turn = 0; turn < 50; turn += 1) {
    const turnResult: { next: { delayMs: number; input: SyncFolderJobInput } | null } = { next: null };
    await runSyncFolderJob({
      input,
      heartbeat: async () => undefined,
      resubmit: (resubmit) => {
        turnResult.next = { delayMs: resubmit?.delayMs ?? 0, input: resubmit?.input ?? input };
      },
    });
    const { next } = turnResult;
    // A turn that found the lease busy, for example during body downloads, waits a few seconds.
    if (!next || next.delayMs === 0 || next.delayMs > 10_000) return next;
    await Bun.sleep(next.delayMs);
  }
  throw new Error("The folder sync job never got the provider lease");
};

type MaintenanceJobInput = { commandId: string; continuationAttempt?: number } | { mailboxId: string };

/** Runs one turn of a `mail:execute-maintenance-command` job; returns the continuation it asked for. */
const maintenanceTurn = async (input: MaintenanceJobInput): Promise<{ delayMs: number; input: MaintenanceJobInput } | null> => {
  let next: { delayMs: number; input: MaintenanceJobInput } | null = null;
  await runMaintenanceJob({
    input,
    attempt: 1,
    heartbeat: async () => undefined,
    resubmit: (resubmit) => {
      next = { delayMs: resubmit?.delayMs ?? 0, input: resubmit?.input ?? input };
    },
  });
  return next;
};

/** Runs a maintenance job the way its worker does, turn after turn, until it ends. */
const runMaintenanceUntilDone = async (input: MaintenanceJobInput): Promise<void> => {
  let current: MaintenanceJobInput = input;
  for (let turn = 0; turn < 200; turn += 1) {
    const next = await maintenanceTurn(current);
    if (!next) return;
    await Bun.sleep(next.delayMs);
    current = next.input;
  }
  throw new Error("The maintenance job did not finish");
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
  // Every UID MOVE, by mailbox label, with the number of messages it carried.
  const moveSets: Array<{ label: string; uids: number }> = [];
  // Messages the server refuses to move, by Message-ID, and messages another client deletes while a
  // move runs, by Message-ID or, for one of two messages that share it, by subject.
  const refusedMoves = new Set<string>();
  const vanishingMoves = new Set<string>();
  // Messages whose move the server carries out before the connection drops, by Message-ID.
  const droppedMoves = new Set<string>();
  // Runs once right after the next folder STATUS; the batch goes on with that STATUS.
  let afterStatus: ((account: string, path: string) => Promise<void>) | null = null;
  // Accounts whose server times out on STATUS.
  const failingStatus = new Set<string>();
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
  const connect = async (
    label: string,
    options: { condstore?: boolean; firstInboxUid?: number; uidplus?: boolean } = {},
  ): Promise<Mailbox> => {
    const account = `${label}-${suffix}@example.test`;
    const condstore = options.condstore ?? false;
    accounts.set(account, {
      label,
      condstore,
      uidplus: options.uidplus ?? true,
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

  /**
   * Queues one move per message, by default from INBOX to Archive, as a bulk move in the web UI
   * does. With `startTogether` the mailbox's job starts once every move is queued.
   */
  const queueMoves = async (
    mailbox: Mailbox,
    messageIds: string[],
    label: string,
    options: { from?: string; to?: string; startTogether?: boolean } = {},
  ): Promise<string[]> => {
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
        enqueue: !options.startTogether,
        input: {
          kind: "move",
          messageId: message.id,
          sourceFolderId: mailbox.folderId(options.from ?? INBOX),
          destinationFolderId: mailbox.folderId(options.to ?? ARCHIVE),
          idempotencyKey: `${label}-${index}-${suffix}`,
        },
      });
      if (!command.ok) throw new Error(JSON.stringify(command.error));
      commandIds.push(command.data.id);
    }
    if (options.startTogether && commandIds[0]) await enqueueMailCommand(commandIds[0], "move");
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
        if (failingStatus.has(config.username)) throw new Error("Connection timed out");
        const folder = folderOf(config.username, path);
        const status = {
          uidValidity: folder.uidValidity,
          uidNext: folder.nextUid,
          highestModseq: highestModseq(config.username, folder),
          messages: folder.entries.size,
        };
        const hook = afterStatus;
        if (hook) await hook(config.username, path);
        return status;
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
      spyOn(imapSmtpConnector, "getMessageStates").mockImplementation(async (config, messages) => {
        await Bun.sleep(ROUND_TRIP_MS);
        const folder = folderOf(config.username, messages.folderPath);
        const states = new Map<number, RemoteMessageState>();
        for (const uid of messages.uids) {
          const message = folder.entries.get(uid);
          if (message) states.set(uid, { exists: true, flags: [], keywords: [], messageId: message.messageId, modseq: null });
        }
        return states;
      }),
      spyOn(imapSmtpConnector, "moveMessages").mockImplementation(async (config, messages, destinationPath) => {
        const account = accounts.get(config.username)!;
        // Like a server that moves message after message.
        await Bun.sleep(ROUND_TRIP_MS + messages.uids.length * MOVE_MS_PER_MESSAGE);
        moveSets.push({ label: account.label, uids: messages.uids.length });
        const source = folderOf(config.username, messages.folderPath);
        const destinationUids = new Map<number, number>();
        let connectionDrops = false;
        for (const uid of messages.uids) {
          const message = source.entries.get(uid);
          if (message && droppedMoves.has(message.messageId)) connectionDrops = true;
          // Another client deletes this message just before the server takes the move.
          const vanishes = message && (vanishingMoves.has(message.messageId) || vanishingMoves.has(message.subject));
          if (message && vanishes) source.entries.delete(uid);
          if (!message || refusedMoves.has(message.messageId) || vanishes) continue;
          source.entries.delete(uid);
          source.modseq += 1;
          destinationUids.set(uid, store(config.username, destinationPath, message));
        }
        if (connectionDrops) throw new Error("Connection closed");
        const completed = messages.uids.every((uid) => !source.entries.has(uid));
        // Without UIDPLUS the server reports no COPYUID, and imapflow drops it when the server refuses the move.
        if (!account.uidplus || !completed) return { completed, destinationUidValidity: null, destinationUids: new Map() };
        return { completed, destinationUidValidity: folderOf(config.username, destinationPath).uidValidity, destinationUids };
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

    const moves = await queueMoves(busy, backlog, "bulk-move", { startTogether: true });
    await waitFor(async () => (await confirmed(moves)) >= 3, "the bulk move to start");

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

    // New mail for the busy mailbox comes in with each folder sync, not after the backlog. Several
    // rounds, because a sync that only gets in when it happens to try between two turns can be lucky once.
    for (let round = 0; round < 3; round += 1) {
      const [newMail] = deliver(busy, 1, `new-mail-${round}`);
      const windowsBefore = flagWindows.filter((label) => label === "busy").length;
      const syncMs = await runFolderSyncJob(busy.folderId(INBOX));
      expect(await imported(busy, newMail!)).toBe(true);
      expect(flagWindows.filter((label) => label === "busy").length - windowsBefore).toBeGreaterThanOrEqual(5);
      expect(syncMs).toBeLessThan(5_000);
      // The first sync waited for at most the set of moves in progress, not for the backlog.
      if (round === 0) expect(await pending(moves)).toBeGreaterThan(0);
    }

    // The backlog keeps draining after the syncs took their turns.
    await waitFor(async () => (await pending(moves)) === 0, "the bulk move to finish");
    expect(await confirmed(moves)).toBe(300);
  }, 120_000);

  /** The message's commands by Message-ID, with their outcome. */
  const outcomes = async (commandIds: string[]): Promise<Map<string, { state: string; code: string | null }>> => {
    const rows = await sql<{ message_id: string; state: string; code: string | null }[]>`
      SELECT content.message_id, command.state, command.last_error_code AS code
      FROM mail.commands command
      JOIN mail.remote_message_refs ref ON ref.id = (command.target->>'remoteMessageRefId')::uuid
      JOIN mail.message_contents content ON content.id = ref.message_id
      WHERE command.id IN ${sql(commandIds)}
    `;
    return new Map(rows.map((row) => [row.message_id, { state: row.state, code: row.code }]));
  };

  /** How many of the messages have a current placement in the folder. */
  const placedIn = async (mailbox: Mailbox, path: string, messageIds: string[]): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM mail.message_placements placement
      JOIN mail.message_contents content ON content.id = placement.message_id
      WHERE placement.folder_id = ${mailbox.folderId(path)}::uuid
        AND placement.deleted_at IS NULL
        AND content.message_id IN ${sql(messageIds)}
    `;
    return row?.count ?? 0;
  };

  test("300 moves drain in a handful of set moves with one command each, and moving them back works", async () => {
    const mailbox = await connect("sets");
    const messageIds = await deliverAndSync(mailbox, 300, "set");
    const sets = () => moveSets.filter((entry) => entry.label === "sets").map((entry) => entry.uids);

    const moves = await queueMoves(mailbox, messageIds, "set-move", { startTogether: true });
    await waitFor(async () => (await confirmed(moves)) === 300, "the moves to Archive");
    expect(sets()).toEqual([50, 50, 50, 50, 50, 50]);
    // Every message keeps its own command and its own execution activity.
    const [activity] = await sql<{ commands: number; events: number }[]>`
      SELECT count(DISTINCT command_id)::int AS commands, count(*)::int AS events
      FROM mail.activity_events
      WHERE command_id IN ${sql(moves)} AND action = 'command.execute'
    `;
    expect(activity).toEqual({ commands: 300, events: 300 });
    // COPYUID tells each message's new UID, so Archive shows them without waiting for its folder sync.
    expect(await placedIn(mailbox, ARCHIVE, messageIds)).toBe(300);
    expect(await placedIn(mailbox, INBOX, messageIds)).toBe(0);

    // Moving messages back, as an undo does, finds each one at its new place.
    const undone = messageIds.slice(0, 100);
    const back = await queueMoves(mailbox, undone, "set-back", { from: ARCHIVE, to: INBOX, startTogether: true });
    await waitFor(async () => (await confirmed(back)) === 100, "the moves back to INBOX");
    expect(await placedIn(mailbox, INBOX, undone)).toBe(100);
    expect(await placedIn(mailbox, ARCHIVE, messageIds)).toBe(200);
    expect(folderOf(mailbox.account, INBOX).entries.size).toBe(100);
  }, 120_000);

  test("a set move that partly fails proves each moved message and leaves the others where they are", async () => {
    const mailbox = await connect("partial");
    const messageIds = await deliverAndSync(mailbox, 7, "partial");
    const [gone, refusedFirst, refusedSecond, vanished, ...movable] = messageIds;
    // One message disappeared from the server before its turn, the server refuses to move two
    // others, and another client deletes one while the move runs.
    const inbox = folderOf(mailbox.account, INBOX);
    for (const [uid, message] of inbox.entries) if (message.messageId === gone) inbox.entries.delete(uid);
    refusedMoves.add(refusedFirst!);
    refusedMoves.add(refusedSecond!);
    vanishingMoves.add(vanished!);
    try {
      const moves = await queueMoves(mailbox, messageIds, "partial-move", { startTogether: true });
      await waitFor(async () => (await pending(moves)) === 0, "the partly failing moves");
      const results = await outcomes(moves);
      expect(results.get(gone!)).toEqual({ state: "failed", code: "REMOTE_MESSAGE_MISSING" });
      expect(results.get(refusedFirst!)).toEqual({ state: "needs_attention", code: "REMOTE_MOVE_FAILED" });
      expect(results.get(refusedSecond!)).toEqual({ state: "needs_attention", code: "REMOTE_MOVE_FAILED" });
      // The refused MOVE reported no new UIDs, so each message gone from the source is looked up in
      // the destination: the moved ones are found, the deleted one is not.
      for (const messageId of movable) expect(results.get(messageId)).toEqual({ state: "reconciled", code: null });
      expect(results.get(vanished!)).toEqual({ state: "needs_attention", code: "AMBIGUOUS_MUTATION" });
      // One UID MOVE carried the six messages the server still had.
      expect(moveSets.filter((entry) => entry.label === "partial").map((entry) => entry.uids)).toEqual([6]);
      expect(await placedIn(mailbox, INBOX, [refusedFirst!, refusedSecond!])).toBe(2);
      await runFolderSyncJob(mailbox.folderId(ARCHIVE));
      expect(await placedIn(mailbox, ARCHIVE, movable)).toBe(3);
    } finally {
      refusedMoves.clear();
      vanishingMoves.clear();
    }
  }, 60_000);

  test("two messages with the same Message-ID move in separate sets, so an unclear move proves each on its own", async () => {
    const mailbox = await connect("same-id");
    // A mailing list copy and a direct copy of one mail: two messages that share their Message-ID.
    const messageId = `<same-id-${suffix}@example.test>`;
    store(mailbox.account, INBOX, { messageId, subject: "direct copy", internalDate: new Date(Date.UTC(2026, 0, 2)) });
    store(mailbox.account, INBOX, { messageId, subject: "list copy", internalDate: new Date(Date.UTC(2026, 0, 1)) });
    await deliverAndSync(mailbox, 0, "same-id");
    // The server moves the direct copy, another client deletes the list copy, and the connection
    // drops before either move is confirmed.
    vanishingMoves.add("list copy");
    droppedMoves.add(messageId);
    try {
      // One move per message, newest first: the direct copy, then the list copy.
      const [directMove, listMove] = await queueMoves(mailbox, [messageId, messageId], "same-id-move", { startTogether: true });
      const moves = [directMove!, listMove!];
      await waitFor(async () => (await pending(moves)) === 0, "the unclear moves");
      expect(moveSets.filter((entry) => entry.label === "same-id").map((entry) => entry.uids)).toEqual([1, 1]);
      const rows = await sql<{ id: string; state: string; code: string | null }[]>`
        SELECT id, state, last_error_code AS code FROM mail.commands WHERE id IN ${sql(moves)}
      `;
      const outcome = new Map(rows.map((row) => [row.id, { state: row.state, code: row.code }]));
      // The direct copy is found in Archive. The list copy is not, although Archive has a message with its Message-ID.
      expect(outcome.get(directMove!)).toEqual({ state: "reconciled", code: null });
      expect(outcome.get(listMove!)).toEqual({ state: "needs_attention", code: "AMBIGUOUS_MUTATION" });
      expect(folderOf(mailbox.account, ARCHIVE).entries.size).toBe(1);
    } finally {
      vanishingMoves.clear();
      droppedMoves.clear();
    }
  }, 60_000);

  test("without UIDPLUS, moved messages appear in the destination with its next folder sync", async () => {
    const mailbox = await connect("no-uidplus", { uidplus: false });
    await sql`
      UPDATE mail.provider_bindings SET capabilities = capabilities || '{"uidplus": false}'::jsonb WHERE id = ${mailbox.bindingId}::uuid
    `;
    const messageIds = await deliverAndSync(mailbox, 3, "no-uidplus");
    const moves = await queueMoves(mailbox, messageIds, "no-uidplus-move", { startTogether: true });
    await waitFor(async () => (await confirmed(moves)) === 3, "the moves without UIDPLUS");
    expect(moveSets.filter((entry) => entry.label === "no-uidplus").map((entry) => entry.uids)).toEqual([3]);
    // Without COPYUID the new UIDs are unknown, so the destination's folder sync places the messages.
    expect(await placedIn(mailbox, INBOX, messageIds)).toBe(0);
    expect(await placedIn(mailbox, ARCHIVE, messageIds)).toBe(0);
    await runFolderSyncJob(mailbox.folderId(ARCHIVE));
    expect(await placedIn(mailbox, ARCHIVE, messageIds)).toBe(3);
  }, 60_000);

  test("without MOVE and UIDPLUS, every move of a set fails before the provider changes anything", async () => {
    const mailbox = await connect("unsafe");
    await sql`
      UPDATE mail.provider_bindings
      SET capabilities = capabilities || '{"move": false, "uidplus": false}'::jsonb
      WHERE id = ${mailbox.bindingId}::uuid
    `;
    const messageIds = await deliverAndSync(mailbox, 3, "unsafe");
    const moves = await queueMoves(mailbox, messageIds, "unsafe-move", { startTogether: true });
    await waitFor(async () => (await pending(moves)) === 0, "the refused moves");
    const rows = await sql<{ state: string; code: string | null; effect: Date | null }[]>`
      SELECT state, last_error_code AS code, provider_effect_started_at AS effect FROM mail.commands WHERE id IN ${sql(moves)}
    `;
    expect(rows).toEqual(Array.from({ length: 3 }, () => ({ state: "failed", code: "SAFE_MOVE_UNSUPPORTED", effect: null })));
    expect(moveSets.filter((entry) => entry.label === "unsafe")).toEqual([]);
    expect(await placedIn(mailbox, INBOX, messageIds)).toBe(3);
  }, 60_000);

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
    // Four sets of moves, so the sync can only go before the last ones by going first.
    const backlog = await deliverAndSync(mailbox, 200, "requested-backlog");
    for (let index = 0; index < 2_000; index += 1) {
      store(mailbox.account, ARCHIVE, {
        messageId: `<requested-archived-${index}-${suffix}@example.test>`,
        subject: `Archived ${index}`,
        internalDate: new Date(Date.UTC(2025, 0, 1) + index * 60_000),
      });
    }
    // Archive's job has started importing old mail; its next batch would be background work.
    expect((await syncFolderBatch(mailbox.folderId(ARCHIVE), async () => undefined)).hasMore).toBe(true);
    const moves = await queueMoves(mailbox, backlog, "requested-move", { startTogether: true });
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

  /**
   * A sync command as `cld mail sync --wait` creates it, or without `wait` as `cld mail sync` and
   * Sync now in Mail settings do, run by the test.
   */
  const requestSync = async (mailbox: Mailbox, key: string, options: { path?: string; wait?: boolean } = {}): Promise<string> => {
    const wait = options.wait ?? true;
    const command = await createMailCommand({
      context,
      mailboxId: mailbox.mailboxId,
      input: options.path
        ? { kind: "sync_folder", folderId: mailbox.folderId(options.path), wait, idempotencyKey: `${key}-${suffix}` }
        : { kind: "sync_mailbox", wait, idempotencyKey: `${key}-${suffix}` },
      enqueue: false,
    });
    if (!command.ok) throw new Error(JSON.stringify(command.error));
    return command.data.id;
  };

  /** A waited sync after its first turn queued the folder syncs and handed the wait to its mailbox's checker. */
  const startWaitedSync = async (mailbox: Mailbox, key: string, path?: string): Promise<string> => {
    const commandId = await requestSync(mailbox, key, { path });
    expect(await maintenanceTurn({ commandId })).toBeNull();
    expect((await commandOutcome(commandId)).state).toBe("executing");
    return commandId;
  };

  /** One turn of the mailbox's sync checker; returns its continuation while a sync still waits. */
  const checkTurn = (mailbox: Mailbox) => maintenanceTurn({ mailboxId: mailbox.mailboxId });
  const stillWaiting = (mailbox: Mailbox) => ({ delayMs: 1_000, input: { mailboxId: mailbox.mailboxId } });

  const commandOutcome = async (commandId: string): Promise<{ state: string; code: string | null; result: unknown }> => {
    const [row] = await sql<{ state: string; code: string | null; result: unknown }[]>`
      SELECT state, last_error_code AS code, result FROM mail.commands WHERE id = ${commandId}::uuid
    `;
    return { state: row!.state, code: row!.code, result: typeof row!.result === "string" ? JSON.parse(row!.result) : row!.result };
  };

  test("a waited mailbox sync finishes once every folder brought in its new mail, while a backfill and body downloads go on", async () => {
    await ensureHydrationRuntime();
    const mailbox = await connect("waited");
    // 200 bodies to download, and ten envelope batches of old mail in Archive.
    await deliverAndSync(mailbox, 200, "waited-bodies");
    for (let index = 0; index < 2_000; index += 1) {
      store(mailbox.account, ARCHIVE, {
        messageId: `<waited-archived-${index}-${suffix}@example.test>`,
        subject: `Archived ${index}`,
        internalDate: new Date(Date.UTC(2025, 0, 1) + index * 60_000),
      });
    }
    await enqueueMailboxHydration(mailbox.mailboxId);
    await waitFor(async () => downloads.filter((label) => label === "waited").length >= 2, "hydration to start");
    let backfillDone = false;
    const backfill = runFolderSyncJob(mailbox.folderId(ARCHIVE)).then(() => {
      backfillDone = true;
    });
    await waitFor(async () => {
      const [count] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM mail.message_contents WHERE mailbox_id = ${mailbox.mailboxId}::uuid
      `;
      return (count?.count ?? 0) >= 400;
    }, "the Archive backfill to start");

    const [newMail] = deliver(mailbox, 1, "waited-new");
    const sentMessageId = `<waited-sent-${suffix}@example.test>`;
    store(mailbox.account, SENT, { messageId: sentMessageId, subject: "Sent elsewhere", internalDate: new Date() });
    // Queueing the folder syncs does not finish the command: it waits for them.
    const commandId = await startWaitedSync(mailbox, "waited-sync");
    expect(await commandOutcome(commandId)).toMatchObject({ state: "executing", result: { queuedFolders: 3 } });
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));

    // The worker runs the queued INBOX and Sent jobs; Archive's request joined its running backfill.
    await Promise.all([
      runMaintenanceUntilDone({ mailboxId: mailbox.mailboxId }),
      runFolderSyncJob(mailbox.folderId(INBOX)),
      runFolderSyncJob(mailbox.folderId(SENT)),
    ]);
    expect(await commandOutcome(commandId)).toEqual({ state: "confirmed", code: null, result: { queuedFolders: 3 } });
    expect(await imported(mailbox, newMail!)).toBe(true);
    expect(await imported(mailbox, sentMessageId)).toBe(true);
    // The sync took its turns ahead of the backlog: most old mail and many bodies are still to come.
    expect(backfillDone).toBe(false);
    const [backlog] = await sql<{ archived: number; unhydrated: number }[]>`
      SELECT
        count(*) FILTER (WHERE message_id LIKE ${`<waited-archived-%`})::int AS archived,
        count(*) FILTER (WHERE message_id LIKE ${`<waited-bodies-%`} AND hydration_status <> 'complete')::int AS unhydrated
      FROM mail.message_contents
      WHERE mailbox_id = ${mailbox.mailboxId}::uuid
    `;
    expect(backlog?.archived).toBeLessThan(1_200);
    expect(backlog?.unhydrated).toBeGreaterThan(50);
    await backfill;
  }, 120_000);

  test("a sync requested while a folder's last batch runs gets a batch of its own", async () => {
    await ensureHydrationRuntime();
    const mailbox = await connect("late-request");
    const lateMail: string[] = [];
    // The mail arrives and its sync is requested after the running batch checked the folder.
    afterStatus = async (account, path) => {
      if (account !== mailbox.account || path !== INBOX) return;
      afterStatus = null;
      lateMail.push(...deliver(mailbox, 1, "late-request"));
      await enqueueFolderSync(mailbox.folderId(INBOX));
    };
    try {
      await runFolderSyncJob(mailbox.folderId(INBOX));
    } finally {
      afterStatus = null;
    }
    expect(lateMail).toHaveLength(1);
    expect(await imported(mailbox, lateMail[0]!)).toBe(true);
  }, 60_000);

  test("a waited sync does not finish with an import that started before the request", async () => {
    await ensureHydrationRuntime();
    const mailbox = await connect("sweeping");
    const inbox = mailbox.folderId(INBOX);
    // 300 new messages take two envelope batches; the first one ran before the request.
    deliver(mailbox, 300, "sweeping");
    expect((await syncFolderBatch(inbox, async () => undefined)).syncPending).toBe(true);
    const [lateMail] = deliver(mailbox, 1, "sweeping-late");
    const commandId = await startWaitedSync(mailbox, "sweeping-sync", INBOX);

    // The next batch ends that import at the UID it started with, below the late mail, and goes on.
    const continuation = await syncFolderTurn(inbox);
    expect(continuation).toEqual({ delayMs: 0, input: { folderId: inbox, backfill: false } });
    expect(await imported(mailbox, lateMail!)).toBe(false);
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));

    await runFolderSyncJob(inbox, { input: continuation!.input });
    expect(await imported(mailbox, lateMail!)).toBe(true);
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(commandId)).toMatchObject({ state: "confirmed", code: null });
  }, 60_000);

  test("a waited sync on a CONDSTORE server finishes once Mail holds the changes made before the request", async () => {
    await ensureHydrationRuntime();
    // High UIDs, so one check of every message's flags takes two batches.
    const mailbox = await connect("modseq", { condstore: true, firstInboxUid: 9_000 });
    const inbox = mailbox.folderId(INBOX);
    deliver(mailbox, 2, "modseq");
    await runFolderSyncJob(inbox);
    // New mail changes the folder; the flag check that follows is half done before the request.
    deliver(mailbox, 1, "modseq-checked");
    expect(await syncFolderTurn(inbox)).toEqual({ delayMs: 0, input: { folderId: inbox, backfill: false } });
    const [lateMail] = deliver(mailbox, 1, "modseq-late");
    const commandId = await startWaitedSync(mailbox, "modseq-sync", INBOX);

    // The next batch brings in the late mail and ends the flag check that started before it.
    expect(await syncFolderTurn(inbox)).toBeNull();
    expect(await imported(mailbox, lateMail!)).toBe(true);
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));

    // The next scheduled sync checks the flags again and finishes the request.
    await runFolderSyncJob(inbox);
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(commandId)).toMatchObject({ state: "confirmed", code: null });
  }, 60_000);

  test("a waited sync ends when its request runs out, fails once a folder's sync gives up, and waits again when retried", async () => {
    await ensureHydrationRuntime();
    const mailbox = await connect("failing");
    const inbox = mailbox.folderId(INBOX);

    // A request whose folder sync never ran ends once the request runs out.
    const expiring = await startWaitedSync(mailbox, "expiring-sync", SENT);
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));
    await sql`
      UPDATE mail.commands
      SET started_at = now() - (${FOLDER_SYNC_REQUEST_MS + 1_000}::int * interval '1 millisecond')
      WHERE id = ${expiring}::uuid
    `;
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(expiring)).toMatchObject({ state: "failed", code: "SYNC_TIMEOUT" });

    // An earlier sync of INBOX gave up.
    await sql`UPDATE mail.folders SET sync_status = 'degraded' WHERE id = ${inbox}::uuid`;
    const failing = await startWaitedSync(mailbox, "failing-sync");

    // A failed attempt with retries left keeps the command waiting, also in a degraded folder.
    failingStatus.add(mailbox.account);
    try {
      await expect(syncFolderTurn(inbox)).rejects.toThrow("Connection timed out");
    } finally {
      failingStatus.delete(mailbox.account);
    }
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));

    // Mail that Postgres cannot store fails the same way on every attempt, so the job gives up. That
    // ends the wait while Archive and Sent have not synced yet.
    const unstorable = store(mailbox.account, INBOX, {
      messageId: `<failing-unstorable-${suffix}@example.test>`,
      subject: "Re\u0000port",
      internalDate: new Date(),
    });
    expect(await syncFolderTurn(inbox)).toEqual({ delayMs: 15 * 60_000, input: { folderId: inbox } });
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(failing)).toMatchObject({ state: "failed", code: "SYNC_FAILED" });

    // A retry waits for a sync of its own instead of ending on the runs of the failed attempt.
    const retry = await createMailCommand({
      context,
      mailboxId: mailbox.mailboxId,
      input: { kind: "retry_command", commandId: failing, idempotencyKey: `failing-retry-${suffix}` },
      enqueue: false,
    });
    if (!retry.ok) throw new Error(JSON.stringify(retry.error));
    expect(await maintenanceTurn({ commandId: retry.data.id })).toBeNull();
    expect(await maintenanceTurn({ commandId: failing })).toBeNull();
    expect(await commandOutcome(failing)).toMatchObject({ state: "executing", result: { queuedFolders: 3 } });
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));
    folderOf(mailbox.account, INBOX).entries.delete(unstorable);
    await Promise.all([runFolderSyncJob(inbox), runFolderSyncJob(mailbox.folderId(ARCHIVE)), runFolderSyncJob(mailbox.folderId(SENT))]);
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(failing)).toEqual({ state: "confirmed", code: null, result: { queuedFolders: 3 } });
  }, 60_000);

  test("a waited sync fails once a folder's job gives up after the request, also on a batch that started before it or never reached the provider", async () => {
    await ensureHydrationRuntime();
    const mailbox = await connect("gave-up");
    const inbox = mailbox.folderId(INBOX);
    const archive = mailbox.folderId(ARCHIVE);

    // The request comes while a batch runs that then stops on mail Postgres cannot store.
    store(mailbox.account, INBOX, {
      messageId: `<gave-up-unstorable-${suffix}@example.test>`,
      subject: "Re\u0000port",
      internalDate: new Date(),
    });
    const late: { commandId?: string } = {};
    afterStatus = async (account, path) => {
      if (account !== mailbox.account || path !== INBOX) return;
      afterStatus = null;
      late.commandId = await startWaitedSync(mailbox, "gave-up-late", INBOX);
    };
    try {
      expect(await syncFolderTurn(inbox)).toEqual({ delayMs: 15 * 60_000, input: { folderId: inbox } });
    } finally {
      afterStatus = null;
    }
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(late.commandId!)).toMatchObject({ state: "failed", code: "SYNC_FAILED" });

    // No binding may read Archive any more, so its job fails before it records a run and gives up
    // after its last attempt. That ends a waited mailbox sync while INBOX and Sent have not synced.
    await sql`UPDATE mail.binding_folder_refs SET effective_rights = '{}' WHERE folder_id = ${archive}::uuid`;
    const commandId = await startWaitedSync(mailbox, "gave-up-unreadable");
    const failure = await runSyncFolderJob({
      input: { folderId: archive },
      heartbeat: async () => undefined,
      resubmit: () => undefined,
    }).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure).toMatchObject({ code: "NO_SYNC_BINDING" });
    expect(await onSyncFolderJobError({ context: { input: { folderId: archive }, attempt: 4 }, error: failure! })).toEqual({
      action: "retry",
    });
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));
    expect(await onSyncFolderJobError({ context: { input: { folderId: archive }, attempt: 5 }, error: failure! })).toMatchObject({
      action: "dead_letter",
    });
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(commandId)).toMatchObject({ state: "failed", code: "SYNC_FAILED", result: { queuedFolders: 3 } });
  }, 60_000);

  test("a waited sync whose mailbox is paused meanwhile ends with the reason, like a request that finds it paused", async () => {
    const mailbox = await connect("paused");
    const commandId = await startWaitedSync(mailbox, "paused-sync");
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));

    const paused = await updateMailbox({ context, mailboxId: mailbox.mailboxId, syncEnabled: false });
    if (!paused.ok) throw new Error(JSON.stringify(paused.error));
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(commandId)).toEqual({
      state: "confirmed",
      code: null,
      result: { queuedFolders: 3, reason: "Mailbox transport is paused" },
    });
  }, 60_000);

  test("a sync that does not ask to wait is confirmed once its folder syncs are queued", async () => {
    const mailbox = await connect("unwaited");
    const mailboxSync = await requestSync(mailbox, "unwaited-sync", { wait: false });
    expect(await maintenanceTurn({ commandId: mailboxSync })).toBeNull();
    expect(await commandOutcome(mailboxSync)).toEqual({ state: "confirmed", code: null, result: { queuedFolders: 3 } });
    const folderSync = await requestSync(mailbox, "unwaited-folder-sync", { path: INBOX, wait: false });
    expect(await maintenanceTurn({ commandId: folderSync })).toBeNull();
    expect(await commandOutcome(folderSync)).toEqual({
      state: "confirmed",
      code: null,
      result: { folderId: mailbox.folderId(INBOX), queued: true },
    });
    // Nothing waits, so the mailbox's checker has nothing to do.
    expect(await checkTurn(mailbox)).toBeNull();
  }, 60_000);

  test("waited syncs of one mailbox share its checker, and each waits for a batch after its own request", async () => {
    const mailbox = await connect("shared-check");
    const inbox = mailbox.folderId(INBOX);
    const first = await startWaitedSync(mailbox, "shared-first", INBOX);
    await runFolderSyncJob(inbox);
    // Mail arrives and a second sync is requested after that batch started, so it does not count.
    const [lateMail] = deliver(mailbox, 1, "shared-late");
    const second = await startWaitedSync(mailbox, "shared-second", INBOX);

    // One turn of the checker ends the first request and keeps waiting for the second.
    expect(await checkTurn(mailbox)).toEqual(stillWaiting(mailbox));
    expect(await commandOutcome(first)).toMatchObject({ state: "confirmed", code: null });
    expect(await commandOutcome(second)).toMatchObject({ state: "executing" });

    await runFolderSyncJob(inbox);
    expect(await imported(mailbox, lateMail!)).toBe(true);
    expect(await checkTurn(mailbox)).toBeNull();
    expect(await commandOutcome(second)).toEqual({
      state: "confirmed",
      code: null,
      result: { folderId: inbox, queued: true },
    });
  }, 60_000);

  test("the mailbox's checker job ends its waiting syncs on its own", async () => {
    const mailbox = await connect("checker-job");
    await startMaintenanceRuntime();
    try {
      const mailboxSync = await startWaitedSync(mailbox, "checker-job-mailbox");
      const folderSync = await startWaitedSync(mailbox, "checker-job-folder", INBOX);
      await Promise.all([INBOX, ARCHIVE, SENT].map((path) => runFolderSyncJob(mailbox.folderId(path))));
      await waitFor(
        async () => (await commandOutcome(mailboxSync)).state !== "executing" && (await commandOutcome(folderSync)).state !== "executing",
        "the checker to end both syncs",
        15_000,
      );
      expect(await commandOutcome(mailboxSync)).toMatchObject({ state: "confirmed", code: null });
      expect(await commandOutcome(folderSync)).toMatchObject({ state: "confirmed", code: null });
    } finally {
      await stopMaintenanceRuntime();
    }
  }, 60_000);

  test("the commands-due schedule starts a missing checker and leaves a waiting sync to it instead of running it anew", async () => {
    const mailbox = await connect("away");
    // No maintenance worker runs, so the two requests wait without a checker.
    const synced = await startWaitedSync(mailbox, "away-synced", INBOX);
    const expired = await startWaitedSync(mailbox, "away-expired", SENT);
    await runFolderSyncJob(mailbox.folderId(INBOX));
    // The workers were away for longer than a request counts.
    await sql`
      UPDATE mail.commands
      SET
        started_at = now() - (${FOLDER_SYNC_REQUEST_MS + 60_000}::int * interval '1 millisecond'),
        worker_heartbeat_at = now() - (${FOLDER_SYNC_REQUEST_MS + 60_000}::int * interval '1 millisecond')
      WHERE id = ${expired}::uuid
    `;
    await startMaintenanceRuntime();
    try {
      await submitDueMaintenanceCommands();
      await waitFor(
        async () => (await commandOutcome(synced)).state !== "executing" && (await commandOutcome(expired)).state !== "executing",
        "the checker to end both syncs",
        15_000,
      );
      expect(await commandOutcome(synced)).toMatchObject({ state: "confirmed", code: null });
      // Run anew, the request would have waited again for a sync of Sent.
      expect(await commandOutcome(expired)).toMatchObject({ state: "failed", code: "SYNC_TIMEOUT" });
    } finally {
      await stopMaintenanceRuntime();
    }
  }, 60_000);

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
    type Resubmitted = { delayMs: number; input?: MaintenanceJobInput };
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
