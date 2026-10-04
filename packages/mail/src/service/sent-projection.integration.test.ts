import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import type { FetchMessageObject, MessageAddressObject } from "imapflow";
import { type AddressObject, simpleParser } from "mailparser";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, type RemoteFolder, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { executeOutboxSubmission, executeOutboxSubmissionWithHeartbeat, recoverStaleExecutions } from "./command-runtime";
import { createActorCommand, createMailCommand } from "./commands";
import { imapSmtpConnector } from "./connectors";
import { mapFetchedEnvelope } from "./connectors/imap-smtp";
import { mergeConversations } from "./conversations";
import {
  enqueueDraftProjectionSnapshot,
  queueDraftProjectionInTransaction,
  startDraftProjectionRuntime,
  stopDraftProjectionRuntime,
  submitDueDraftProjectionWork,
} from "./draft-provider-projection";
import { appendDraftAttachmentUpload, createDraftAttachmentUpload, finalizeDraftAttachmentUpload } from "./draft-uploads";
import { createDraft, discardDraft, updateDraft } from "./drafts";
import { setFolderRole } from "./folders";
import { createMailbox } from "./mailboxes";
import { executeMaintenanceCommand } from "./maintenance-runtime";
import { listConversations, listFolders } from "./messages";
import { OUTBOX_MAX_ATTEMPTS } from "./outbound-delivery";
import { createProviderConnection } from "./provider-connections";
import { enqueueFolderReconciliation, hydrateMessageBatch, ingestEnvelope, syncFolderBatch } from "./sync-runtime";
import { loadMailboxPageData, resolveWorkspaceRequest } from "./workspace";

const suite = suiteFor("database", "nats", "valkey");

const OWNER = "owner@example.test";
const CUSTOMER = "customer@example.test";
const INBOX = "INBOX";
const SENT = "[Gmail]/Sent Mail";
const ALL = "[Gmail]/All Mail";
const DRAFTS = "[Gmail]/Drafts";
const FOLDER_RIGHTS = ["read", "write_flags", "insert", "move", "delete_messages"];

type ProviderKind = "gmail" | "imap";

type StoredMessage = {
  id: string;
  threadId: string;
  source: Buffer;
  messageId: string | null;
  internalDate: Date;
  flags: Map<string, Set<string>>;
};

type StoredFolder = { path: string; uidValidity: string; nextUid: number; entries: Map<number, StoredMessage> };

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

const imapAddresses = (value: AddressObject | AddressObject[] | undefined): MessageAddressObject[] =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((entry) => entry.value)
    .map((entry) => ({ name: entry.name || undefined, address: entry.address }));

/**
 * An in-memory IMAP account. `gmail` behaves like Gmail: an SMTP submission is stored in
 * [Gmail]/Sent Mail, every message is also listed in [Gmail]/All Mail with the same
 * X-GM-MSGID, and deleting a draft removes it everywhere. `imap` stores nothing on submission.
 */
const createProvider = (kind: ProviderKind) => {
  const folders = new Map<string, StoredFolder>();
  let sequence = 0;
  const paths = kind === "gmail" ? [INBOX, SENT, ALL, DRAFTS] : [INBOX, "Sent", "Drafts"];
  for (const [index, path] of paths.entries())
    folders.set(path, { path, uidValidity: String(100 + index), nextUid: 1, entries: new Map() });
  const sentPath = kind === "gmail" ? SENT : "Sent";
  const draftsPath = kind === "gmail" ? DRAFTS : "Drafts";
  const appends: string[] = [];
  // Messages the provider stored but its search does not return yet, like Gmail right after SMTP.
  const unindexed = new Set<StoredMessage>();
  let indexNewMessagesLate = false;
  // Gmail stores what its own SMTP server sends; a mailbox can also send through another server.
  let storeSubmissions = kind === "gmail";
  // Searches that fail once the next SMTP submission went through, like a dropped IMAP connection.
  let searchFailuresAfterSubmission = 0;
  let failingSearches = 0;
  let searchFailureCode = "ECONNRESET";
  // The next SMTP submission fails: before the server received the message, or after it stored it.
  let submissionFailure: { error: Error; afterTransfer: boolean } | null = null;
  let submissions = 0;
  let searches = 0;
  // Recipients the SMTP server refuses at RCPT while it accepts the others.
  const refusedRecipients = new Set<string>();
  // Runs while the next append to the Drafts folder is in flight, before the server stores the message.
  let duringNextDraftAppend: ((source: Buffer) => Promise<void>) | null = null;
  // Runs when the next status of the Drafts folder is read, as a draft export does right before it appends.
  let duringNextDraftsStatus: (() => Promise<void>) | null = null;

  const folder = (path: string): StoredFolder => {
    const found = folders.get(path);
    if (!found) throw Object.assign(new Error(`No folder ${path}`), { responseStatus: "NO" });
    return found;
  };
  const place = (message: StoredMessage, path: string, flags: string[]): number => {
    const target = folder(path);
    const uid = target.nextUid++;
    target.entries.set(uid, message);
    message.flags.set(path, new Set(flags));
    return uid;
  };
  const remove = (message: StoredMessage, path: string): void => {
    const target = folder(path);
    for (const [uid, entry] of target.entries) if (entry === message) target.entries.delete(uid);
    message.flags.delete(path);
  };
  const store = async (
    source: Buffer,
    path: string,
    flags: string[],
    internalDate = new Date(),
  ): Promise<{ message: StoredMessage; uid: number }> => {
    const parsed = await simpleParser(source);
    const parent = parsed.inReplyTo
      ? [...folders.values()].flatMap((entry) => [...entry.entries.values()]).find((entry) => entry.messageId === parsed.inReplyTo)
      : undefined;
    sequence += 1;
    const message: StoredMessage = {
      id: String(9_000_000 + sequence),
      threadId: parent?.threadId ?? String(8_000_000 + sequence),
      source,
      messageId: parsed.messageId ?? null,
      internalDate,
      flags: new Map(),
    };
    const uid = place(message, path, flags);
    if (kind === "gmail" && path !== ALL) place(message, ALL, flags);
    if (indexNewMessagesLate) unindexed.add(message);
    return { message, uid };
  };
  const labelsFor = (message: StoredMessage): string[] => {
    const labels: string[] = [];
    if (message.flags.has(INBOX)) labels.push("\\Inbox");
    if (message.flags.has(sentPath)) labels.push("\\Sent");
    if (message.flags.has(draftsPath)) labels.push("\\Draft");
    return labels;
  };
  const fetchObject = async (path: string, uid: number, message: StoredMessage): Promise<FetchMessageObject> => {
    const parsed = await simpleParser(message.source);
    const headerEnd = message.source.indexOf("\r\n\r\n");
    return {
      seq: uid,
      uid,
      flags: new Set(message.flags.get(path) ?? []),
      emailId: kind === "gmail" ? message.id : undefined,
      threadId: kind === "gmail" ? message.threadId : undefined,
      labels: kind === "gmail" ? new Set(labelsFor(message)) : undefined,
      internalDate: message.internalDate,
      size: message.source.byteLength,
      headers: message.source.subarray(0, headerEnd + 4),
      envelope: {
        date: parsed.date,
        subject: parsed.subject,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        from: imapAddresses(parsed.from),
        sender: imapAddresses(parsed.from),
        replyTo: imapAddresses(parsed.replyTo),
        to: imapAddresses(parsed.to),
        cc: imapAddresses(parsed.cc),
        bcc: imapAddresses(parsed.bcc),
      },
    } as FetchMessageObject;
  };

  const spies = [
    spyOn(imapSmtpConnector, "getFolderStatus").mockImplementation(async (_config, path) => {
      const during = path === draftsPath ? duringNextDraftsStatus : null;
      if (during) {
        duringNextDraftsStatus = null;
        await during();
      }
      const target = folder(path);
      return { uidValidity: target.uidValidity, uidNext: target.nextUid, highestModseq: null, messages: target.entries.size };
    }),
    spyOn(imapSmtpConnector, "fetchEnvelopeBatch").mockImplementation(async (_config, request) => {
      const target = folder(request.folderPath);
      const low = request.lowUid ?? 1;
      const uids = [...target.entries.keys()]
        .filter((uid) => (request.uids ? request.uids.includes(uid) : uid >= low && uid <= request.highUid))
        .sort((left, right) => right - left);
      const selected = uids.slice(0, request.limit);
      const remaining = uids.slice(request.limit);
      const messages = await Promise.all(
        selected.map(async (uid) => mapFetchedEnvelope(await fetchObject(request.folderPath, uid, target.entries.get(uid)!), request)),
      );
      return { messages, nextHighUid: remaining.length > 0 ? remaining[0]! : null };
    }),
    spyOn(imapSmtpConnector, "fetchFlagChanges").mockResolvedValue([]),
    spyOn(imapSmtpConnector, "fetchUidWindow").mockImplementation(async (_config, path, _uidValidity, low, high) =>
      [...folder(path).entries.entries()]
        .filter(([uid]) => uid >= low && uid <= high)
        .map(([uid, message]) => ({
          uid,
          modseq: null,
          flags: [...(message.flags.get(path) ?? [])].sort(),
          labels: kind === "gmail" ? labelsFor(message).sort() : [],
        }))
        .sort((left, right) => left.uid - right.uid),
    ),
    spyOn(imapSmtpConnector, "downloadSourceBatch").mockImplementation(async (_config, path, requests, consume) => {
      for (const request of requests) {
        const message = folder(path).entries.get(request.uid);
        if (!message) continue;
        await consume({ ...request, expectedSize: message.source.byteLength, stream: Readable.from([message.source]) });
      }
    }),
    spyOn(imapSmtpConnector, "sendSource").mockImplementation(async (_config, request) => {
      const failure = submissionFailure;
      submissionFailure = null;
      if (failure && !failure.afterTransfer) throw failure.error;
      const source = await readAll(request.source);
      submissions += 1;
      if (storeSubmissions) await store(source, sentPath, ["\\Seen"]);
      if (failure) throw failure.error;
      failingSearches = searchFailuresAfterSubmission;
      searchFailuresAfterSubmission = 0;
      return {
        accepted: request.recipients.filter((recipient) => !refusedRecipients.has(recipient)),
        rejected: request.recipients.filter((recipient) => refusedRecipients.has(recipient)),
        response: "250 2.0.0 OK",
        messageId: request.messageId,
      };
    }),
    spyOn(imapSmtpConnector, "appendSource").mockImplementation(async (_config, path, source, _length, flags, internalDate) => {
      appends.push(path);
      const bytes = await readAll(source);
      const during = path === draftsPath ? duringNextDraftAppend : null;
      if (during) {
        duringNextDraftAppend = null;
        await during(bytes);
      }
      const stored = await store(bytes, path, flags ?? [], internalDate ?? undefined);
      return { uidValidity: folder(path).uidValidity, uid: stored.uid };
    }),
    spyOn(imapSmtpConnector, "findMessageById").mockImplementation(async (_config, path, messageId) => {
      searches += 1;
      if (failingSearches > 0) {
        failingSearches -= 1;
        throw Object.assign(new Error("Connection failed"), { code: searchFailureCode });
      }
      return [...folder(path).entries.entries()]
        .filter(([, message]) => !unindexed.has(message) && message.messageId?.toLowerCase() === messageId.trim().toLowerCase())
        .map(([uid]) => uid)
        .sort((left, right) => left - right);
    }),
    spyOn(imapSmtpConnector, "getMessageState").mockImplementation(async (_config, target) => {
      const message = folder(target.folderPath).entries.get(target.uid);
      const flags = [...(message?.flags.get(target.folderPath) ?? [])];
      return { exists: Boolean(message), flags, keywords: [], messageId: message?.messageId ?? null, modseq: null };
    }),
    spyOn(imapSmtpConnector, "delete").mockImplementation(async (_config, target) => {
      const message = folder(target.folderPath).entries.get(target.uid);
      if (!message) return;
      // Gmail drops a deleted draft from every label; elsewhere only the folder copy goes.
      if (kind === "gmail" && (target.folderPath === draftsPath || target.folderPath === ALL)) {
        for (const path of [...message.flags.keys()]) remove(message, path);
      } else remove(message, target.folderPath);
    }),
  ];

  return {
    kind,
    paths,
    sentPath,
    draftsPath,
    appends,
    folder,
    deliver: (source: string) => store(Buffer.from(source), INBOX, []),
    // A draft another client saved, without the headers Mail writes into its own drafts.
    saveDraftElsewhere: (source: string) => store(Buffer.from(source), draftsPath, ["\\Draft", "\\Seen"]),
    storeIn: (path: string, source: string, flags: string[]) => store(Buffer.from(source), path, flags),
    // A message another client sent; a message to the own address is delivered to the Inbox too.
    storeSent: async (source: string, alsoInInbox: boolean) => {
      const { message } = await store(Buffer.from(source), sentPath, ["\\Seen"]);
      if (alsoInInbox) place(message, INBOX, []);
    },
    envelope: async (path: string, uid: number, folderStableKey: string) => {
      const message = folder(path).entries.get(uid);
      if (!message) throw new Error(`No message ${uid} in ${path}`);
      const request = { folderPath: path, folderStableKey, uidValidity: folder(path).uidValidity, highUid: uid, limit: 1 };
      return mapFetchedEnvelope(await fetchObject(path, uid, message), request);
    },
    indexNewMessagesLate: () => {
      indexNewMessagesLate = true;
    },
    indexEverything: () => {
      indexNewMessagesLate = false;
      unindexed.clear();
    },
    setStoresSubmissions: (stores: boolean) => {
      storeSubmissions = stores;
    },
    failSearchesAfterSubmission: (count: number) => {
      searchFailuresAfterSubmission = count;
    },
    failNextSearches: (count: number, code: string) => {
      failingSearches = count;
      searchFailureCode = code;
    },
    failNextSubmission: (code: string, afterTransfer: boolean) => {
      submissionFailure = { error: Object.assign(new Error(`SMTP failure ${code}`), { code, command: "CONN" }), afterTransfer };
    },
    refuseRecipient: (address: string) => {
      refusedRecipients.add(address);
    },
    duringNextDraftAppend: (work: (source: Buffer) => Promise<void>) => {
      duringNextDraftAppend = work;
    },
    duringNextDraftsStatus: (work: () => Promise<void>) => {
      duringNextDraftsStatus = work;
    },
    submissions: () => submissions,
    searches: () => searches,
    messagesWithId: (path: string, messageId: string) =>
      [...folder(path).entries.values()].filter((message) => message.messageId?.toLowerCase() === messageId.toLowerCase()),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
};

type Provider = ReturnType<typeof createProvider>;

const verification = (kind: ProviderKind): ConnectorVerification => ({
  authenticatedPrincipal: OWNER,
  serverIdentity: { serverInfo: { name: kind } },
  capabilities: {
    idle: true,
    condstore: false,
    qresync: false,
    move: true,
    uidplus: true,
    namespace: true,
    listExtended: true,
    specialUse: true,
    acl: false,
    notify: false,
    quota: false,
    gmailExtensions: kind === "gmail",
  },
  limits: unavailableProviderLimitSnapshot(),
  accounts: [{ id: OWNER, name: OWNER, locator: {}, namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }] }],
});

const remoteFolders = (provider: Provider): RemoteFolder[] =>
  provider.paths.map((path) => {
    const stored = provider.folder(path);
    const role: RemoteFolder["role"] =
      path === INBOX
        ? "inbox"
        : path === provider.sentPath
          ? "sent"
          : path === provider.draftsPath
            ? "drafts"
            : path === ALL
              ? "all"
              : "other";
    return {
      stableKey: `${path}:${stored.uidValidity}`,
      path,
      name: path.split("/").at(-1) ?? path,
      delimiter: "/",
      parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
      role,
      subscribed: true,
      selectable: true,
      uidValidity: stored.uidValidity,
      uidNext: String(stored.nextUid),
      highestModseq: null,
      rights: FOLDER_RIGHTS,
      rightsSource: "select",
    };
  });

const inboundSource = (suffix: string, subject: string): string =>
  [
    `Message-ID: <inbound-${suffix}@example.test>`,
    `Date: ${new Date(Date.now() - 60_000).toUTCString()}`,
    `From: Customer <${CUSTOMER}>`,
    `To: Owner <${OWNER}>`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Could you send the document?",
  ].join("\r\n");

const waitFor = async (ready: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

/**
 * The draft projection worker this suite runs exports, imports, and retires drafts under the same
 * provider lease as sync and hydration. Their jobs wait out that routine contention instead of
 * failing, and so do the direct calls here.
 */
const whenProviderFree = async <T>(work: () => Promise<T>, timeoutMs = 60_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      const busy = error instanceof Error && "code" in error && error.code === "SYNC_BUSY";
      if (!busy || Date.now() >= deadline) throw error;
      await Bun.sleep(25);
    }
  }
};

suite("mail sent message projection", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  let context: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const uid = `mail-sent-projection-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, true)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create the sent projection test user");
    userIds.push(user.id);
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
          roles: ["admin", "user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-sent-projection-${suffix}`,
    };
    await startDraftProjectionRuntime();
  });

  afterAll(async () => {
    await stopDraftProjectionRuntime();
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    for (const userId of userIds) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  const connect = async (provider: Provider) => {
    const mailbox = await createMailbox(context, { name: `Sent projection ${provider.kind} ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(verification(provider.kind));
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => remoteFolders(provider));
    let bindingId = "";
    try {
      const connection = await createProviderConnection({
        context,
        mailboxId: mailbox.data.id,
        input: {
          name: `Sent projection ${provider.kind}`,
          email: OWNER,
          username: OWNER,
          imap: { host: `imap.${provider.kind}.example.test`, port: 993, tlsMode: "implicit" },
          smtp: { host: `smtp.${provider.kind}.example.test`, port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);
      const folders = remoteFolders(provider);
      const evidence = {
        version: 1,
        serverKey: sha256Json({
          host: `imap.${provider.kind}.example.test`,
          port: 993,
          tlsMode: "implicit",
          serverInfo: { name: provider.kind },
        }),
        accountId: OWNER,
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
        VALUES (${mailbox.data.id}::uuid, ${{ accountId: OWNER }}::jsonb, '{}'::jsonb, ${scope}, 'active', 0)
        RETURNING id
      `;
      const [binding] = await sql<{ id: string }[]>`
        INSERT INTO mail.provider_bindings (
          remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
          capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
        ) VALUES (
          ${resource!.id}::uuid, ${connection.data.connection.id}::uuid, 'active', ${OWNER},
          ${{ accountId: OWNER }}::jsonb, ${verification(provider.kind).capabilities}::jsonb, '{}'::jsonb,
          ${evidence}::jsonb, ${scope}, 1, now()
        ) RETURNING id
      `;
      bindingId = binding!.id;
      await rediscoverProviderBinding({ bindingId });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
    const folders = await sql<{ id: string; remote_path: string; role: string }[]>`
      SELECT folder.id, ref.remote_path, folder.role
      FROM mail.folders folder
      JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id
      WHERE ref.binding_id = ${bindingId}::uuid
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
        ${newShortId()}, ${mailbox.data.id}::uuid, 'Owner', 'Owner', ${OWNER}, 'mailbox', true, 'verified', ${folderId(provider.sentPath)}::uuid
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.sender_identity_bindings (sender_identity_id, binding_id, provider_principal, verified_at, saves_sent_automatically)
      VALUES (${identity!.id}::uuid, ${bindingId}::uuid, ${OWNER}, now(), false)
    `;
    const syncAll = async (): Promise<void> => {
      for (const path of provider.paths) {
        for (let batch = 0; batch < 20; batch += 1) {
          const result = await whenProviderFree(() => syncFolderBatch(folderId(path), async () => undefined));
          if (!result.hasMore) break;
        }
      }
    };
    return { mailboxId: mailbox.data.id, identityId: identity!.id, folderId, syncAll };
  };

  type Connected = Awaited<ReturnType<typeof connect>>;

  // Hydrates every pending body in this process, so no hydration worker races the sync for the provider lease.
  const waitForHydration = async (mailbox: Connected): Promise<void> => {
    for (let batch = 0; batch < 20; batch += 1) {
      const result = await whenProviderFree(() =>
        hydrateMessageBatch({
          input: { mailboxId: mailbox.mailboxId },
          heartbeat: async () => undefined,
          resubmit: () => undefined,
        }),
      );
      if (!result.hydrated) return;
    }
  };

  const waitForDraftExport = (draftId: string, states: string[]) =>
    waitFor(
      async () => {
        const [snapshot] = await sql<{ state: string }[]>`
        SELECT state FROM mail.draft_provider_snapshots
        WHERE draft_id = ${draftId}::uuid AND direction = 'export'
        ORDER BY created_at DESC LIMIT 1
      `;
        return Boolean(snapshot && states.includes(snapshot.state));
      },
      `draft export ${states.join("/")}`,
    );

  const send = async (
    mailbox: Connected,
    draftId: string,
    revision: number,
    key: string,
    expectedState = "sent",
    options: { as?: MailRequestContext } = {},
  ) => {
    const command = await createActorCommand({
      context: options.as ?? context,
      mailboxId: mailbox.mailboxId,
      input: {
        kind: "send",
        draftId,
        expectedDraftRevision: revision,
        senderIdentityId: mailbox.identityId,
        undoSeconds: 0,
        idempotencyKey: `${key}-${suffix}`,
      },
      enqueue: false,
    });
    if (!command.ok) throw new Error(JSON.stringify(command.error));
    const [outbox] = await sql<{ id: string; stable_message_id: string; message_id: string }[]>`
      UPDATE mail.outbox_submissions
      SET scheduled_at = now() - interval '1 second', undo_until = NULL
      WHERE command_id = ${command.data.id}::uuid
      RETURNING id, stable_message_id, message_id
    `;
    expect(await executeOutboxSubmission(outbox!.id)).toBe(expectedState);
    return outbox!;
  };

  const sentProjection = async (mailbox: Connected, stableMessageId: string) => {
    const messages = await sql<{ id: string; sent_at: Date | null; conversation_id: string | null }[]>`
      SELECT message.id, message.sent_at, link.conversation_id
      FROM mail.message_contents message
      LEFT JOIN mail.conversation_messages link ON link.message_id = message.id
      WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid AND lower(message.message_id) = lower(${stableMessageId})
    `;
    const placements = await sql<{ remote_path: string }[]>`
      SELECT ref.remote_path
      FROM mail.message_placements placement
      JOIN mail.message_contents message ON message.id = placement.message_id
      JOIN mail.binding_folder_refs ref ON ref.folder_id = placement.folder_id
      WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid
        AND lower(message.message_id) = lower(${stableMessageId})
        AND placement.deleted_at IS NULL
      ORDER BY ref.remote_path
    `;
    return { messages, placements: placements.map((row) => row.remote_path) };
  };

  const conversationMessages = async (conversationId: string) =>
    sql<{ message_id: string | null; active_placements: number }[]>`
      SELECT
        message.message_id,
        (SELECT count(*)::int FROM mail.message_placements placement WHERE placement.message_id = message.id AND placement.deleted_at IS NULL) AS active_placements
      FROM mail.conversation_messages link
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE link.conversation_id = ${conversationId}::uuid
      ORDER BY message.internal_date, message.id
    `;

  const receive = async (provider: Provider, mailbox: Connected, key: string) => {
    const messageId = `<inbound-${key}-${suffix}@example.test>`;
    await provider.deliver(inboundSource(`${key}-${suffix}`, "Document request"));
    await mailbox.syncAll();
    await waitForHydration(mailbox);
    const [inbound] = await sql<{ id: string; conversation_id: string }[]>`
      SELECT message.id, link.conversation_id
      FROM mail.message_contents message
      JOIN mail.conversation_messages link ON link.message_id = message.id
      WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid AND message.message_id = ${messageId}
    `;
    if (!inbound) throw new Error("The inbound fixture message was not imported");
    return { ...inbound, messageId };
  };

  const replyDraft = async (mailbox: Connected, inbound: { id: string; conversation_id: string }) => {
    const draft = await createDraft({
      context,
      mailboxId: mailbox.mailboxId,
      input: {
        senderIdentityId: mailbox.identityId,
        to: [{ name: "Customer", address: CUSTOMER }],
        cc: [],
        bcc: [],
        subject: "Re: Document request",
        body: "Here it is.",
        format: "plain",
        conversationId: inbound.conversation_id,
        intent: "reply",
        sourceMessageId: inbound.id,
      },
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft.error));
    return draft.data;
  };

  test("a reply sent through Gmail shows in Sent at once and stays one message after the sync", async () => {
    const provider = createProvider("gmail");
    try {
      const mailbox = await connect(provider);
      const inbound = await receive(provider, mailbox, "gmail");
      const draft = await replyDraft(mailbox, inbound);
      await waitForDraftExport(draft.id, ["active"]);
      // Gmail lists the projected draft in All Mail too; the sync must not turn it into a message.
      expect(provider.folder(ALL).entries.size).toBe(2);
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      expect(await conversationMessages(inbound.conversation_id)).toEqual([{ message_id: inbound.messageId, active_placements: 2 }]);

      const outbox = await send(mailbox, draft.id, draft.revision, "gmail-reply");
      // Gmail stored the submission itself; Mail found that copy instead of adding its own.
      expect(provider.appends).toEqual([DRAFTS]);
      expect(provider.messagesWithId(SENT, outbox.stable_message_id)).toHaveLength(1);
      const beforeSync = await sentProjection(mailbox, outbox.stable_message_id);
      expect(beforeSync.placements).toEqual([SENT]);
      expect(beforeSync.messages[0]!.sent_at).not.toBeNull();

      await submitDueDraftProjectionWork();
      await waitForDraftExport(draft.id, ["retired"]);
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      for (const path of provider.paths) await enqueueFolderReconciliation(mailbox.folderId(path), 1);
      await mailbox.syncAll();
      await waitForHydration(mailbox);

      const projection = await sentProjection(mailbox, outbox.stable_message_id);
      expect(projection.messages).toHaveLength(1);
      expect(projection.messages[0]!.id).toBe(outbox.message_id);
      expect(projection.messages[0]!.sent_at).not.toBeNull();
      expect(projection.messages[0]!.conversation_id).toBe(inbound.conversation_id);
      expect(projection.placements).toEqual([ALL, SENT]);
      expect(await conversationMessages(inbound.conversation_id)).toEqual([
        { message_id: inbound.messageId, active_placements: 2 },
        { message_id: outbox.stable_message_id, active_placements: 2 },
      ]);
      const [hydrated] = await sql<{ hydration_status: string }[]>`
        SELECT hydration_status FROM mail.message_contents WHERE id = ${outbox.message_id}::uuid
      `;
      expect(hydrated?.hydration_status).toBe("complete");
    } finally {
      provider.restore();
    }
  });

  test("when Gmail's search lags behind, Mail waits for Gmail's copy instead of adding a second one", async () => {
    const provider = createProvider("gmail");
    try {
      const mailbox = await connect(provider);
      const inbound = await receive(provider, mailbox, "gmail-lag");
      const draft = await replyDraft(mailbox, inbound);
      await waitForDraftExport(draft.id, ["active"]);
      provider.indexNewMessagesLate();
      const outbox = await send(mailbox, draft.id, draft.revision, "gmail-lag", "sent_sync_pending");
      expect(provider.appends.filter((path) => path === SENT)).toEqual([]);

      provider.indexEverything();
      const [mark] = await sql<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
      expect(await executeOutboxSubmission(outbox.id)).toBe("sent");
      expect(provider.appends.filter((path) => path === SENT)).toEqual([]);
      // The later attempt placed the message, so open views of its conversation refresh.
      const [invalidations] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM events.outbox
        WHERE app_id = 'mail' AND created_at >= ${mark!.at}
          AND payload -> 'd' ->> 'conversationId' = (SELECT short_id FROM mail.conversations WHERE id = ${inbound.conversation_id}::uuid)
      `;
      expect(invalidations?.count).toBe(1);
      expect(provider.messagesWithId(SENT, outbox.stable_message_id)).toHaveLength(1);
      const projection = await sentProjection(mailbox, outbox.stable_message_id);
      expect(projection.placements).toEqual([SENT]);
      expect(projection.messages[0]!.sent_at).not.toBeNull();
    } finally {
      provider.restore();
    }
  });

  test("a message sent through a server that keeps no copy is appended to Sent exactly once", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await createDraft({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          senderIdentityId: mailbox.identityId,
          to: [{ name: "Customer", address: CUSTOMER }],
          cc: [],
          bcc: [],
          subject: "Quarterly report",
          body: "The report is ready.",
          format: "plain",
        },
      });
      if (!draft.ok) throw new Error(JSON.stringify(draft.error));
      await waitForDraftExport(draft.data.id, ["active"]);
      const outbox = await send(mailbox, draft.data.id, draft.data.revision, "imap-new");
      expect(provider.appends).toEqual(["Drafts", "Sent"]);
      expect(provider.messagesWithId("Sent", outbox.stable_message_id)).toHaveLength(1);
      expect((await sentProjection(mailbox, outbox.stable_message_id)).placements).toEqual(["Sent"]);

      await submitDueDraftProjectionWork();
      await waitForDraftExport(draft.data.id, ["retired"]);
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      expect(provider.appends).toEqual(["Drafts", "Sent"]);
      const projection = await sentProjection(mailbox, outbox.stable_message_id);
      expect(projection.messages).toHaveLength(1);
      expect(projection.messages[0]!.id).toBe(outbox.message_id);
      expect(projection.messages[0]!.sent_at).not.toBeNull();
      expect(projection.placements).toEqual(["Sent"]);
      expect(await conversationMessages(projection.messages[0]!.conversation_id!)).toEqual([
        { message_id: outbox.stable_message_id, active_placements: 1 },
      ]);
    } finally {
      provider.restore();
    }
  });

  const newDraft = async (mailbox: Connected, subject: string) => {
    const draft = await createDraft({
      context,
      mailboxId: mailbox.mailboxId,
      input: {
        senderIdentityId: mailbox.identityId,
        to: [{ name: "Customer", address: CUSTOMER }],
        cc: [],
        bcc: [],
        subject,
        body: "The report is ready.",
        format: "plain",
      },
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft.error));
    await waitForDraftExport(draft.data.id, ["active"]);
    return draft.data;
  };

  test("a completed append counts as the Sent copy even before the server's search lists it", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Search lag");
      provider.indexNewMessagesLate();
      const outbox = await send(mailbox, draft.id, draft.revision, "imap-lag");
      expect(provider.appends).toEqual(["Drafts", "Sent"]);
      expect((await sentProjection(mailbox, outbox.stable_message_id)).placements).toEqual([]);

      provider.indexEverything();
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      expect(provider.appends).toEqual(["Drafts", "Sent"]);
      const projection = await sentProjection(mailbox, outbox.stable_message_id);
      expect(projection.messages.map((message) => message.id)).toEqual([outbox.message_id]);
      expect(projection.placements).toEqual(["Sent"]);
    } finally {
      provider.restore();
    }
  });

  test("when Gmail keeps no copy of a submission, Mail appends one on the last attempt only", async () => {
    const provider = createProvider("gmail");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Other relay");
      provider.setStoresSubmissions(false);
      const outbox = await send(mailbox, draft.id, draft.revision, "gmail-relay", "sent_sync_pending");
      const states: (string | null)[] = [];
      while (states.at(-1) !== "sent" && states.length < 4) states.push(await executeOutboxSubmission(outbox.id));
      expect(states).toEqual(["sent_sync_pending", "sent_sync_pending", "sent_sync_pending", "sent"]);
      expect(provider.appends.filter((path) => path === SENT)).toEqual([SENT]);
      expect((await sentProjection(mailbox, outbox.stable_message_id)).placements).toEqual([SENT]);
    } finally {
      provider.restore();
    }
  });

  test("a provider that saves sent mail itself gets no second copy and its copy shows in Sent at once", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      await sql`
        UPDATE mail.sender_identity_bindings SET saves_sent_automatically = true
        WHERE sender_identity_id = ${mailbox.identityId}::uuid
      `;
      const draft = await newDraft(mailbox, "Provider copy");
      provider.setStoresSubmissions(true);
      const outbox = await send(mailbox, draft.id, draft.revision, "imap-provider-saves");
      expect(provider.appends).toEqual(["Drafts"]);
      expect(provider.messagesWithId("Sent", outbox.stable_message_id)).toHaveLength(1);
      const projection = await sentProjection(mailbox, outbox.stable_message_id);
      expect(projection.placements).toEqual(["Sent"]);
      expect(projection.messages[0]!.sent_at).not.toBeNull();
    } finally {
      provider.restore();
    }
  });

  test("an IMAP failure after SMTP accepted the message keeps the send confirmed and stores the copy later", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Dropped connection");
      provider.failSearchesAfterSubmission(1);
      const outbox = await send(mailbox, draft.id, draft.revision, "imap-dropped", "sent_sync_pending");
      const [command] = await sql<{ state: string }[]>`
        SELECT command.state
        FROM mail.outbox_submissions outbox
        JOIN mail.commands command ON command.id = outbox.command_id
        WHERE outbox.id = ${outbox.id}::uuid
      `;
      expect(command?.state).toBe("confirmed");
      expect(provider.appends).toEqual(["Drafts"]);

      expect(await executeOutboxSubmission(outbox.id)).toBe("sent");
      expect(provider.appends).toEqual(["Drafts", "Sent"]);
      expect((await sentProjection(mailbox, outbox.stable_message_id)).placements).toEqual(["Sent"]);
    } finally {
      provider.restore();
    }
  });

  const delivery = async (outboxId: string) => {
    const [row] = await sql<{ state: string; last_error_code: string | null; command_state: string; draft_state: string }[]>`
      SELECT outbox.state, outbox.last_error_code, command.state AS command_state, draft.state AS draft_state
      FROM mail.outbox_submissions outbox
      JOIN mail.commands command ON command.id = outbox.command_id
      JOIN mail.drafts draft ON draft.id = outbox.draft_id
      WHERE outbox.id = ${outboxId}::uuid
    `;
    return row;
  };

  const sendRetryNow = async (outboxId: string) => {
    await sql`UPDATE mail.outbox_submissions SET scheduled_at = now() - interval '1 second' WHERE id = ${outboxId}::uuid`;
    return executeOutboxSubmission(outboxId);
  };

  test("a send whose SMTP server cannot be reached is retried, and one that fails otherwise before transfer goes back to drafts", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "SMTP unreachable");
      provider.failNextSubmission("ESOCKET", false);
      const outbox = await send(mailbox, draft.id, draft.revision, "smtp-unreachable", "scheduled");
      expect(await delivery(outbox.id)).toEqual({
        state: "scheduled",
        last_error_code: "OUTBOX_PREDISPATCH_RETRY",
        command_state: "queued",
        draft_state: "scheduled",
      });
      expect(await sendRetryNow(outbox.id)).toBe("sent");
      expect(provider.submissions()).toBe(1);
      expect(provider.messagesWithId("Sent", outbox.stable_message_id)).toHaveLength(1);

      // A worker lease lost while SMTP still connects is retried like the same loss before dispatch.
      const interrupted = await newDraft(mailbox, "Lease lost");
      provider.failNextSubmission("COMMAND_JOB_LEASE_LOST", false);
      const leaseLost = await send(mailbox, interrupted.id, interrupted.revision, "smtp-lease-lost", "scheduled");
      expect(await delivery(leaseLost.id)).toMatchObject({ state: "scheduled", last_error_code: "OUTBOX_PREDISPATCH_RETRY" });
      expect(await sendRetryNow(leaseLost.id)).toBe("sent");
      expect(provider.submissions()).toBe(2);

      const rejected = await newDraft(mailbox, "SMTP certificate");
      provider.failNextSubmission("ETLS", false);
      const failed = await send(mailbox, rejected.id, rejected.revision, "smtp-certificate", "failed");
      expect(await delivery(failed.id)).toEqual({
        state: "failed",
        last_error_code: "ETLS",
        command_state: "failed",
        draft_state: "draft",
      });
      expect(provider.submissions()).toBe(2);
    } finally {
      provider.restore();
    }
  });

  test("a send whose IMAP server is unreachable before dispatch is retried instead of dropped", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "IMAP unreachable");
      provider.failNextSearches(1, "CONNECT_TIMEOUT");
      const outbox = await send(mailbox, draft.id, draft.revision, "imap-unreachable", "scheduled");
      expect(provider.submissions()).toBe(0);
      expect(await delivery(outbox.id)).toEqual({
        state: "scheduled",
        last_error_code: "OUTBOX_PREDISPATCH_RETRY",
        command_state: "queued",
        draft_state: "scheduled",
      });
      expect(await sendRetryNow(outbox.id)).toBe("sent");
      expect(provider.submissions()).toBe(1);
      expect(provider.messagesWithId("Sent", outbox.stable_message_id)).toHaveLength(1);
    } finally {
      provider.restore();
    }
  });

  test("an unproven Gmail send is checked again and proven by the copy the Sent folder sync finds", async () => {
    const provider = createProvider("gmail");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Lost confirmation");
      provider.indexNewMessagesLate();
      // Gmail stored the message, but the connection dropped before its confirmation arrived.
      provider.failNextSubmission("ECONNECTION", true);
      const outbox = await send(mailbox, draft.id, draft.revision, "gmail-lost-confirmation", "unknown");
      const checks: (string | null)[] = [];
      while (checks.at(-1) !== "needs_attention" && checks.length < 5) checks.push(await executeOutboxSubmission(outbox.id));
      // Gmail's search may list its copy only later, so Mail checks a few more times before it gives up.
      expect(checks).toEqual(["unknown", "unknown", "unknown", "needs_attention"]);

      await mailbox.syncAll();
      // The synced copy's body is hydrated here, so no hydration worker holds the provider lease the check needs.
      await waitForHydration(mailbox);
      expect(await delivery(outbox.id)).toMatchObject({ state: "unknown", command_state: "ambiguous" });
      // Replaced credentials no longer match the send's pinned binding; the synced copy needs none.
      await sql`
        UPDATE mail.provider_connections connection
        SET secret_revision = connection.secret_revision + 1
        FROM mail.outbox_submissions submission
        JOIN mail.provider_bindings binding ON binding.id = submission.selected_binding_id
        WHERE submission.id = ${outbox.id}::uuid AND connection.id = binding.connection_id
      `;
      expect(await executeOutboxSubmission(outbox.id)).toBe("reconciled_accepted");
      expect(await delivery(outbox.id)).toEqual({
        state: "reconciled_accepted",
        last_error_code: null,
        command_state: "reconciled",
        draft_state: "sent",
      });
      expect(provider.submissions()).toBe(1);
      expect(provider.messagesWithId(SENT, outbox.stable_message_id)).toHaveLength(1);
      expect(provider.appends.filter((path) => path === SENT)).toEqual([]);
    } finally {
      provider.restore();
    }
  });

  /** A Mail request made with the user's personal API key, resolved the way the auth middleware resolves it. */
  const personalKeyContext = async (): Promise<MailRequestContext> => {
    if (context.actor.kind !== "user") throw new Error("The test context must be a user");
    const created = await serviceAccountCredentials.createUserApiToken({ user: context.actor.user, name: `Mail CLI ${suffix}` });
    if (!created.ok) throw new Error(created.error.message);
    const authenticated = await serviceAccountCredentials.authenticateApiToken(created.data.token);
    if (!authenticated?.delegatedUser) throw new Error("The personal API key did not authenticate as its user");
    return {
      actor: {
        kind: "service_account",
        serviceAccount: authenticated.serviceAccount,
        delegatedUser: authenticated.delegatedUser,
        scopes: authenticated.credential.scopes,
        credentialId: authenticated.credential.id,
        credentialExpiresAt: authenticated.credential.expiresAt,
      },
      accessSubject: { type: "user", userId: authenticated.delegatedUser.id },
      requestId: `mail-sent-projection-personal-key-${suffix}`,
    };
  };

  test("a send queued with a personal API key goes out as its user", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Sent from the CLI");
      // A personal API key is minted without scopes and acts with its user's mailbox access.
      const outbox = await send(mailbox, draft.id, draft.revision, "personal-key", "sent", { as: await personalKeyContext() });
      expect(await delivery(outbox.id)).toEqual({ state: "sent", last_error_code: null, command_state: "confirmed", draft_state: "sent" });
      expect(provider.submissions()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  /** Schedules a send for an hour from now; `sendRetryNow` makes it due. */
  const schedule = async (mailbox: Connected, draftId: string, revision: number, key: string) => {
    const command = await createActorCommand({
      context,
      mailboxId: mailbox.mailboxId,
      input: {
        kind: "send",
        draftId,
        expectedDraftRevision: revision,
        senderIdentityId: mailbox.identityId,
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        undoSeconds: 0,
        idempotencyKey: `${key}-${suffix}`,
      },
      enqueue: false,
    });
    if (!command.ok) throw new Error(JSON.stringify(command.error));
    // Without an undo window, the send is due at its scheduled time alone.
    const [outbox] = await sql<{ id: string; stable_message_id: string; message_id: string; command_id: string }[]>`
      UPDATE mail.outbox_submissions SET undo_until = NULL
      WHERE command_id = ${command.data.id}::uuid
      RETURNING id, stable_message_id, message_id, command_id
    `;
    return outbox!;
  };

  /** Leaves the outbox as a worker does that claimed it eleven minutes ago and then stopped. */
  const stopWorkerAfterClaim = async (outboxId: string, state: "sending" | "unknown", effectStarted: boolean) => {
    await sql`
      UPDATE mail.outbox_submissions
      SET state = ${state}, attempt = attempt + 1, scheduled_at = now() - interval '11 minutes', undo_until = NULL
      WHERE id = ${outboxId}::uuid
    `;
    await sql`
      UPDATE mail.commands command
      SET
        state = 'executing',
        attempt = command.attempt + 1,
        started_at = now() - interval '11 minutes',
        worker_heartbeat_at = now() - interval '11 minutes',
        finished_at = NULL,
        provider_effect_started_at = CASE WHEN ${effectStarted} THEN now() - interval '11 minutes' ELSE command.provider_effect_started_at END,
        provider_effect_attempt = CASE WHEN ${effectStarted} THEN command.attempt + 1 ELSE command.provider_effect_attempt END
      FROM mail.outbox_submissions outbox
      WHERE outbox.id = ${outboxId}::uuid AND command.id = outbox.command_id
    `;
    if (state === "sending") {
      await sql`
        UPDATE mail.drafts draft SET state = 'sending'
        FROM mail.outbox_submissions outbox
        WHERE outbox.id = ${outboxId}::uuid AND draft.id = outbox.draft_id
      `;
    }
  };

  test("a send whose worker stopped before SMTP goes back to the queue, and one that reached SMTP is checked instead", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const unsent = await newDraft(mailbox, "Worker stopped early");
      const early = await schedule(mailbox, unsent.id, unsent.revision, "stopped-before-smtp");
      await stopWorkerAfterClaim(early.id, "sending", false);
      const dispatched = await newDraft(mailbox, "Worker stopped during SMTP");
      const late = await schedule(mailbox, dispatched.id, dispatched.revision, "stopped-during-smtp");
      await stopWorkerAfterClaim(late.id, "sending", true);

      await recoverStaleExecutions();
      // Nothing reached SMTP, so the message is still unsent and goes out on its next attempt.
      expect(await delivery(early.id)).toEqual({
        state: "scheduled",
        last_error_code: "WORKER_LEASE_EXPIRED",
        command_state: "queued",
        draft_state: "scheduled",
      });
      expect(await sendRetryNow(early.id)).toBe("sent");
      expect(provider.submissions()).toBe(1);
      // SMTP may have the other message already, so it is checked and never sent twice.
      expect(await delivery(late.id)).toMatchObject({
        state: "unknown",
        last_error_code: "WORKER_LEASE_EXPIRED",
        command_state: "ambiguous",
      });
    } finally {
      provider.restore();
    }
  });

  test("a send whose lease is lost after the Sent check and before SMTP goes back to the queue", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Lease lost before SMTP");
      const outbox = await schedule(mailbox, draft.id, draft.revision, "lease-lost-before-smtp");
      await sql`UPDATE mail.outbox_submissions SET scheduled_at = now() - interval '1 second' WHERE id = ${outbox.id}::uuid`;
      const searchesBefore = provider.searches();
      // The job's lease renews fine until the send has looked for an earlier copy in Sent.
      const leaseLost = executeOutboxSubmissionWithHeartbeat(outbox.id, async () => {
        if (provider.searches() > searchesBefore) {
          throw Object.assign(new Error("Mail outbox job lease was lost"), { code: "COMMAND_JOB_LEASE_LOST" });
        }
      });
      await expect(leaseLost).rejects.toMatchObject({ code: "COMMAND_JOB_LEASE_LOST" });
      expect(await delivery(outbox.id)).toEqual({
        state: "scheduled",
        last_error_code: "OUTBOX_PREDISPATCH_RETRY",
        command_state: "queued",
        draft_state: "scheduled",
      });
      expect(provider.submissions()).toBe(0);
      expect(await sendRetryNow(outbox.id)).toBe("sent");
      expect(provider.submissions()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  test("an unproven send whose check stopped with its worker is checked again", async () => {
    const provider = createProvider("gmail");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Check interrupted");
      provider.indexNewMessagesLate();
      provider.failNextSubmission("ECONNECTION", true);
      const outbox = await send(mailbox, draft.id, draft.revision, "check-interrupted", "unknown");
      await stopWorkerAfterClaim(outbox.id, "unknown", true);
      expect(await executeOutboxSubmission(outbox.id)).toBeNull();

      await recoverStaleExecutions();
      expect(await delivery(outbox.id)).toMatchObject({ state: "unknown", command_state: "ambiguous" });
      provider.indexEverything();
      expect(await executeOutboxSubmission(outbox.id)).toBe("reconciled_accepted");
      expect(provider.submissions()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  const MISTYPED = "custmer@example.test";

  /** A draft to the customer and to a mistyped address that SMTP refuses. */
  const partlyDeliverableDraft = async (mailbox: Connected, subject: string) => {
    const created = await createDraft({
      context,
      mailboxId: mailbox.mailboxId,
      input: {
        senderIdentityId: mailbox.identityId,
        to: [
          { name: "Customer", address: CUSTOMER },
          { name: "Typo", address: MISTYPED },
        ],
        cc: [],
        bcc: [],
        subject,
        body: "The report is ready.",
        format: "plain",
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    await waitForDraftExport(created.data.id, ["active"]);
    return created.data;
  };

  test("a check whose worker stopped during the last attempt gives up without asking the provider again", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Last check interrupted");
      provider.failNextSubmission("ECONNECTION", true);
      const outbox = await send(mailbox, draft.id, draft.revision, "last-check-interrupted", "unknown");
      await sql`UPDATE mail.outbox_submissions SET attempt = ${OUTBOX_MAX_ATTEMPTS - 1} WHERE id = ${outbox.id}::uuid`;
      await stopWorkerAfterClaim(outbox.id, "unknown", true);
      await recoverStaleExecutions();

      const searches = provider.searches();
      expect(await executeOutboxSubmission(outbox.id)).toBe("needs_attention");
      expect(provider.searches()).toBe(searches);
      expect(await delivery(outbox.id)).toEqual({
        state: "needs_attention",
        last_error_code: "AMBIGUOUS_SMTP_OUTCOME",
        command_state: "needs_attention",
        draft_state: "sent",
      });
      expect(provider.submissions()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  test("a message only some recipients accept is stored in Sent and still needs attention", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await partlyDeliverableDraft(mailbox, "Partly delivered");
      provider.refuseRecipient(MISTYPED);
      const outbox = await send(mailbox, draft.id, draft.revision, "partial", "needs_attention");
      expect(await delivery(outbox.id)).toEqual({
        state: "needs_attention",
        last_error_code: "SMTP_PARTIAL_ACCEPTANCE",
        command_state: "needs_attention",
        draft_state: "sent",
      });
      expect(provider.messagesWithId("Sent", outbox.stable_message_id)).toHaveLength(1);
      const projection = await sentProjection(mailbox, outbox.stable_message_id);
      expect(projection.placements).toEqual(["Sent"]);
      expect(projection.messages[0]!.sent_at).not.toBeNull();
      const [accepted] = await sql<{ accepted_at: Date | null }[]>`
        SELECT accepted_at FROM mail.outbox_submissions WHERE id = ${outbox.id}::uuid
      `;
      expect(accepted?.accepted_at).not.toBeNull();
    } finally {
      provider.restore();
    }
  });

  test("a partly accepted send whose lease is lost after SMTP answered keeps its partial outcome", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await partlyDeliverableDraft(mailbox, "Lease lost after a partial answer");
      provider.refuseRecipient(MISTYPED);
      // This server stores what it sends in Sent itself, so the copy is there right after SMTP.
      provider.setStoresSubmissions(true);
      const outbox = await schedule(mailbox, draft.id, draft.revision, "lease-lost-after-partial-answer");
      await sql`UPDATE mail.outbox_submissions SET scheduled_at = now() - interval '1 second' WHERE id = ${outbox.id}::uuid`;
      const leaseLost = executeOutboxSubmissionWithHeartbeat(outbox.id, async () => {
        if (provider.submissions() > 0) {
          throw Object.assign(new Error("Mail outbox job lease was lost"), { code: "COMMAND_JOB_LEASE_LOST" });
        }
      });
      await expect(leaseLost).rejects.toMatchObject({ code: "COMMAND_JOB_LEASE_LOST" });
      expect(await delivery(outbox.id)).toMatchObject({ state: "unknown", command_state: "ambiguous" });

      // The check finds the copy in Sent, and the recorded answer still says who did not get it.
      expect(await executeOutboxSubmission(outbox.id)).toBe("needs_attention");
      expect(await delivery(outbox.id)).toEqual({
        state: "needs_attention",
        last_error_code: "SMTP_PARTIAL_ACCEPTANCE",
        command_state: "needs_attention",
        draft_state: "sent",
      });
      expect(provider.messagesWithId("Sent", outbox.stable_message_id)).toHaveLength(1);
      expect(provider.submissions()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  test("a send whose worker stopped after SMTP answered settles with that answer instead of staying unclear", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const partlyDraft = await partlyDeliverableDraft(mailbox, "Stopped after a partial answer");
      const partly = await schedule(mailbox, partlyDraft.id, partlyDraft.revision, "stopped-after-partial-answer");
      const fullDraft = await newDraft(mailbox, "Stopped after SMTP accepted");
      const full = await schedule(mailbox, fullDraft.id, fullDraft.revision, "stopped-after-acceptance");
      // SMTP answered and Mail recorded the answer; the worker stopped before the Sent copy was stored.
      for (const [outbox, rejected] of [
        [partly, [MISTYPED]],
        [full, []],
      ] as const) {
        await stopWorkerAfterClaim(outbox.id, "sending", true);
        await sql`
          UPDATE mail.outbox_submissions
          SET provider_response = ${{ accepted: [CUSTOMER], rejected, response: "250 2.0.0 OK", messageId: outbox.stable_message_id }}::jsonb
          WHERE id = ${outbox.id}::uuid
        `;
      }
      await recoverStaleExecutions();
      expect(await delivery(partly.id)).toMatchObject({ state: "unknown", command_state: "ambiguous" });

      // Only some recipients got the message, so it still needs attention for the others.
      expect(await executeOutboxSubmission(partly.id)).toBe("needs_attention");
      expect(await delivery(partly.id)).toEqual({
        state: "needs_attention",
        last_error_code: "SMTP_PARTIAL_ACCEPTANCE",
        command_state: "needs_attention",
        draft_state: "sent",
      });
      expect(provider.messagesWithId("Sent", partly.stable_message_id)).toHaveLength(1);
      expect(await executeOutboxSubmission(full.id)).toBe("sent");
      expect(await delivery(full.id)).toEqual({ state: "sent", last_error_code: null, command_state: "confirmed", draft_state: "sent" });
      expect(provider.messagesWithId("Sent", full.stable_message_id)).toHaveLength(1);
      expect(provider.submissions()).toBe(0);
    } finally {
      provider.restore();
    }
  });

  test("a scheduled send goes out after the mailbox's credentials were replaced and verified again", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Monday morning");
      const outbox = await schedule(mailbox, draft.id, draft.revision, "replaced-credentials");
      // The password was replaced; until the account is verified with it again, the send waits.
      await sql`
        UPDATE mail.provider_connections connection
        SET secret_revision = connection.secret_revision + 1
        FROM mail.provider_bindings binding
        WHERE binding.id = (SELECT selected_binding_id FROM mail.outbox_submissions WHERE id = ${outbox.id}::uuid)
          AND connection.id = binding.connection_id
      `;
      expect(await sendRetryNow(outbox.id)).toBe("scheduled");
      expect(await delivery(outbox.id)).toMatchObject({ state: "scheduled", last_error_code: "OUTBOX_PREDISPATCH_RETRY" });
      // The account and its sender were verified with the new password.
      await sql`
        UPDATE mail.provider_bindings binding
        SET verified_secret_revision = connection.secret_revision
        FROM mail.provider_connections connection
        WHERE binding.id = (SELECT selected_binding_id FROM mail.outbox_submissions WHERE id = ${outbox.id}::uuid)
          AND connection.id = binding.connection_id
      `;
      await sql`
        UPDATE mail.sender_identity_bindings sender_binding
        SET verified_secret_revision = binding.verified_secret_revision
        FROM mail.provider_bindings binding
        WHERE sender_binding.sender_identity_id = ${mailbox.identityId}::uuid AND binding.id = sender_binding.binding_id
      `;
      expect(await sendRetryNow(outbox.id)).toBe("sent");
      expect(provider.submissions()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  test("a scheduled send waits while its mailbox needs its password again instead of failing", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Due during an outage");
      const outbox = await schedule(mailbox, draft.id, draft.revision, "auth-required");
      await sql`UPDATE mail.mailboxes SET health = 'auth_required' WHERE id = ${mailbox.mailboxId}::uuid`;
      expect(await sendRetryNow(outbox.id)).toBe("scheduled");
      expect(await delivery(outbox.id)).toEqual({
        state: "scheduled",
        last_error_code: "OUTBOX_PREDISPATCH_RETRY",
        command_state: "queued",
        draft_state: "scheduled",
      });
      expect(provider.submissions()).toBe(0);
      await sql`UPDATE mail.mailboxes SET health = 'active' WHERE id = ${mailbox.mailboxId}::uuid`;
      expect(await sendRetryNow(outbox.id)).toBe("sent");
      expect(provider.submissions()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  test("a scheduled message is dated when it goes out, not when it was scheduled", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Dated at dispatch");
      const outbox = await schedule(mailbox, draft.id, draft.revision, "dated-at-dispatch");
      // As if Send was chosen three days ago.
      await sql`
        UPDATE mail.outbox_submissions
        SET created_at = created_at - interval '3 days', mime_date = mime_date - interval '3 days'
        WHERE id = ${outbox.id}::uuid
      `;
      const dispatchedFrom = Date.now() - 1_000;
      expect(await sendRetryNow(outbox.id)).toBe("sent");
      const [copy] = provider.messagesWithId("Sent", outbox.stable_message_id);
      if (!copy) throw new Error("The Sent copy is missing");
      const parsed = await simpleParser(copy.source);
      expect(parsed.date?.getTime()).toBeGreaterThanOrEqual(Math.floor(dispatchedFrom / 1_000) * 1_000);
      expect(copy.internalDate.getTime()).toBeGreaterThanOrEqual(dispatchedFrom);
      const projection = await sentProjection(mailbox, outbox.stable_message_id);
      expect(projection.messages[0]!.sent_at!.getTime()).toBeGreaterThanOrEqual(dispatchedFrom);
    } finally {
      provider.restore();
    }
  });

  test("rebuilding threads removes projected drafts an earlier sync imported as messages", async () => {
    const provider = createProvider("gmail");
    try {
      const mailbox = await connect(provider);
      const inbound = await receive(provider, mailbox, "gmail-repair");
      const draft = await replyDraft(mailbox, inbound);
      await waitForDraftExport(draft.id, ["active"]);
      const [snapshot] = await sql<{ stable_message_id: string }[]>`
        SELECT stable_message_id FROM mail.draft_provider_snapshots
        WHERE draft_id = ${draft.id}::uuid AND direction = 'export' AND state = 'active'
      `;
      // A sync before the \Draft guard imported Gmail's All Mail copy of the projected draft.
      const [allMailCopy] = [...provider.folder(ALL).entries.entries()].filter(
        ([, message]) => message.messageId === snapshot!.stable_message_id,
      );
      const envelope = await provider.envelope(ALL, allMailCopy![0], mailbox.folderId(ALL));
      expect(envelope.flags).toContain("\\Draft");
      const [resource] = await sql<{ id: string }[]>`
        SELECT remote_resource_id AS id FROM mail.folders WHERE id = ${mailbox.folderId(ALL)}::uuid
      `;
      const importCopy = (flags: string[], labels: string[]) =>
        ingestEnvelope({
          db: sql,
          mailboxId: mailbox.mailboxId,
          remoteResourceId: resource!.id,
          folderId: mailbox.folderId(ALL),
          message: { ...envelope, flags, labels },
        });
      const rebuildThreads = async (key: string) => {
        const rebuild = await createMailCommand({
          context,
          mailboxId: mailbox.mailboxId,
          input: { kind: "rebuild_threads", idempotencyKey: `repair-threads-${key}-${suffix}` },
          enqueue: false,
        });
        if (!rebuild.ok) throw new Error(JSON.stringify(rebuild.error));
        expect(await executeMaintenanceCommand(rebuild.data.id, undefined, { enqueueWork: false })).toBe("confirmed");
      };

      // Placed without the \Draft flag, the message is real mail that kept the draft's Message-ID,
      // even once the provider no longer lists it.
      await importCopy([], []);
      await sql`
        UPDATE mail.message_placements placement
        SET deleted_at = now()
        FROM mail.message_contents message
        WHERE message.id = placement.message_id
          AND message.mailbox_id = ${mailbox.mailboxId}::uuid
          AND message.message_id = ${snapshot!.stable_message_id}
      `;
      await rebuildThreads("sent-elsewhere");
      expect((await conversationMessages(inbound.conversation_id)).map((message) => message.message_id)).toEqual([
        inbound.messageId,
        snapshot!.stable_message_id,
      ]);

      await importCopy(envelope.flags, envelope.labels);
      // A draft copy someone referenced in a comment keeps that link.
      const [copy] = await sql<{ id: string }[]>`
        SELECT id FROM mail.message_contents
        WHERE mailbox_id = ${mailbox.mailboxId}::uuid AND message_id = ${snapshot!.stable_message_id}
      `;
      const [comment] = await sql<{ id: string }[]>`
        INSERT INTO mail.conversation_comments (short_id, conversation_id, author_kind, author_id, body_markdown, referenced_message_id)
        VALUES (${newShortId()}, ${inbound.conversation_id}::uuid, 'user', ${userIds[0]!}::uuid, 'See this copy', ${copy!.id}::uuid)
        RETURNING id
      `;
      await rebuildThreads("commented-copy");
      expect((await conversationMessages(inbound.conversation_id)).map((message) => message.message_id)).toEqual([
        inbound.messageId,
        snapshot!.stable_message_id,
      ]);
      await sql`DELETE FROM mail.conversation_comments WHERE id = ${comment!.id}::uuid`;

      await rebuildThreads("draft-copy");
      expect(await conversationMessages(inbound.conversation_id)).toEqual([{ message_id: inbound.messageId, active_placements: 2 }]);
      const [kept] = await sql<{ state: string }[]>`
        SELECT state FROM mail.drafts WHERE id = ${draft.id}::uuid
      `;
      expect(kept?.state).toBe("draft");
    } finally {
      provider.restore();
    }
  });

  test("a reply scheduled for later lets an answer that arrives first reopen the conversation", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const inbound = await receive(provider, mailbox, "scheduled");
      const draft = await replyDraft(mailbox, inbound);
      await waitForDraftExport(draft.id, ["active"]);
      const scheduledAt = new Date(Date.now() + 2 * 60 * 60_000);
      const command = await createActorCommand({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          kind: "send",
          draftId: draft.id,
          expectedDraftRevision: draft.revision,
          senderIdentityId: mailbox.identityId,
          undoSeconds: 0,
          scheduledAt: scheduledAt.toISOString(),
          idempotencyKey: `scheduled-reply-${suffix}`,
        },
        enqueue: false,
      });
      if (!command.ok) throw new Error(JSON.stringify(command.error));
      const conversationState = async () => {
        const [state] = await sql<
          { work_status: string; snoozed_until: Date | null; latest_message_at: Date; participant_summary: string }[]
        >`
          SELECT work_status, snoozed_until, latest_message_at, participant_summary
          FROM mail.conversations
          WHERE id = ${inbound.conversation_id}::uuid
        `;
        if (!state) throw new Error("The conversation disappeared");
        return state;
      };
      // The scheduled reply has not reached anyone, so it does not date the conversation yet.
      expect((await conversationState()).latest_message_at.getTime()).toBeLessThan(Date.now());
      await sql`
        UPDATE mail.conversations
        SET work_status = 'waiting', snoozed_until = now() + interval '5 days'
        WHERE id = ${inbound.conversation_id}::uuid
      `;

      const answerId = `<answer-scheduled-${suffix}@example.test>`;
      await provider.deliver(
        [
          `Message-ID: ${answerId}`,
          `In-Reply-To: ${inbound.messageId}`,
          `References: ${inbound.messageId}`,
          `Date: ${new Date().toUTCString()}`,
          `From: Customer <${CUSTOMER}>`,
          `To: Owner <${OWNER}>`,
          "Subject: Re: Document request",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Never mind, I found it.",
        ].join("\r\n"),
      );
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      const [answer] = await sql<{ conversation_id: string; internal_date: Date }[]>`
        SELECT link.conversation_id, message.internal_date
        FROM mail.message_contents message
        JOIN mail.conversation_messages link ON link.message_id = message.id
        WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid AND message.message_id = ${answerId}
      `;
      expect(answer?.conversation_id).toBe(inbound.conversation_id);
      const reopened = await conversationState();
      expect(reopened.work_status).toBe("needs_action");
      expect(reopened.snoozed_until).toBeNull();
      expect(reopened.latest_message_at.getTime()).toBe(answer!.internal_date.getTime());
      expect(reopened.participant_summary).toBe("Customer");
      // The list previews the answer, not the reply that has not been sent yet.
      const needsAction = await listConversations({ context, mailboxId: mailbox.mailboxId, view: "needs_action" });
      if (!needsAction.ok) throw new Error(JSON.stringify(needsAction.error));
      const row = needsAction.data.items.find((item) => item.id === inbound.conversation_id);
      expect(row?.preview).toStartWith("Never mind, I found it.");

      // Once sent, the reply is the newest message, but it was written before the answer, so the
      // answer still needs action, also after the provider's copy of the reply is synchronized.
      const [outbox] = await sql<{ id: string; message_id: string }[]>`
        UPDATE mail.outbox_submissions
        SET scheduled_at = now() - interval '1 second', undo_until = NULL
        WHERE command_id = ${command.data.id}::uuid
        RETURNING id, message_id
      `;
      expect(await executeOutboxSubmission(outbox!.id)).toBe("sent");
      const [reply] = await sql<{ internal_date: Date }[]>`
        SELECT internal_date FROM mail.message_contents WHERE id = ${outbox!.message_id}::uuid
      `;
      const sent = await conversationState();
      expect(sent.work_status).toBe("needs_action");
      expect(sent.latest_message_at.getTime()).toBe(reply!.internal_date.getTime());
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      const [sentCopy] = await sql<{ hydration_status: string }[]>`
        SELECT hydration_status FROM mail.message_contents WHERE id = ${outbox!.message_id}::uuid
      `;
      expect(sentCopy?.hydration_status).toBe("complete");
      expect((await conversationState()).work_status).toBe("needs_action");
    } finally {
      provider.restore();
    }
  });

  test("an answer that arrives after Send but loads only after the reply went out still needs action", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const inbound = await receive(provider, mailbox, "late-load");
      await sql`UPDATE mail.conversations SET work_status = 'done' WHERE id = ${inbound.conversation_id}::uuid`;
      const draft = await replyDraft(mailbox, inbound);
      await waitForDraftExport(draft.id, ["active"]);
      const command = await createActorCommand({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          kind: "send",
          draftId: draft.id,
          expectedDraftRevision: draft.revision,
          senderIdentityId: mailbox.identityId,
          undoSeconds: 0,
          scheduledAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          idempotencyKey: `late-load-reply-${suffix}`,
        },
        enqueue: false,
      });
      if (!command.ok) throw new Error(JSON.stringify(command.error));
      const workStatus = async () => {
        const [state] = await sql<{ work_status: string }[]>`
          SELECT work_status FROM mail.conversations WHERE id = ${inbound.conversation_id}::uuid
        `;
        return state?.work_status;
      };

      // The answer arrives while the reply waits for its send time, but its body loads only after
      // the reply went out, so the reply is the newer message by date.
      const answerId = `<answer-late-load-${suffix}@example.test>`;
      await provider.deliver(
        [
          `Message-ID: ${answerId}`,
          `In-Reply-To: ${inbound.messageId}`,
          `References: ${inbound.messageId}`,
          `Date: ${new Date().toUTCString()}`,
          `From: Customer <${CUSTOMER}>`,
          `To: Owner <${OWNER}>`,
          "Subject: Re: Document request",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "One more question.",
        ].join("\r\n"),
      );
      await mailbox.syncAll();
      const [outbox] = await sql<{ id: string }[]>`
        UPDATE mail.outbox_submissions
        SET scheduled_at = now() - interval '1 second', undo_until = NULL
        WHERE command_id = ${command.data.id}::uuid
        RETURNING id
      `;
      expect(await executeOutboxSubmission(outbox!.id)).toBe("sent");
      await waitForHydration(mailbox);
      const [answer] = await sql<{ hydration_status: string }[]>`
        SELECT hydration_status FROM mail.message_contents
        WHERE mailbox_id = ${mailbox.mailboxId}::uuid AND message_id = ${answerId}
      `;
      expect(answer?.hydration_status).toBe("complete");
      expect(await workStatus()).toBe("needs_action");

      // The provider's copy of the reply does not answer it either.
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      expect(await workStatus()).toBe("needs_action");
    } finally {
      provider.restore();
    }
  });

  test("merging or rebuilding threads keeps a reply scheduled for later out of the conversation's date", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const inbound = await receive(provider, mailbox, "merge-scheduled");
      const draft = await replyDraft(mailbox, inbound);
      await waitForDraftExport(draft.id, ["active"]);
      const command = await createActorCommand({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          kind: "send",
          draftId: draft.id,
          expectedDraftRevision: draft.revision,
          senderIdentityId: mailbox.identityId,
          undoSeconds: 0,
          scheduledAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
          idempotencyKey: `merge-scheduled-reply-${suffix}`,
        },
        enqueue: false,
      });
      if (!command.ok) throw new Error(JSON.stringify(command.error));
      const otherMessageId = `<inbound-merge-other-${suffix}@example.test>`;
      await provider.deliver(inboundSource(`merge-other-${suffix}`, "Invoice question"));
      await mailbox.syncAll();
      await waitForHydration(mailbox);
      const [other] = await sql<{ conversation_id: string; internal_date: Date }[]>`
        SELECT link.conversation_id, message.internal_date
        FROM mail.message_contents message
        JOIN mail.conversation_messages link ON link.message_id = message.id
        WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid AND message.message_id = ${otherMessageId}
      `;
      expect(other!.conversation_id).not.toBe(inbound.conversation_id);
      const revisions = await sql<{ id: string; revision: string | number }[]>`
        SELECT id, revision FROM mail.conversations
        WHERE id IN (${inbound.conversation_id}::uuid, ${other!.conversation_id}::uuid)
      `;
      const revisionOf = (id: string) => Number(revisions.find((row) => row.id === id)!.revision);
      const merged = await mergeConversations({
        context,
        mailboxId: mailbox.mailboxId,
        targetConversationId: inbound.conversation_id,
        input: {
          sourceConversationId: other!.conversation_id,
          expectedTargetRevision: revisionOf(inbound.conversation_id),
          expectedSourceRevision: revisionOf(other!.conversation_id),
          confirm: true,
        },
      });
      if (!merged.ok) throw new Error(JSON.stringify(merged.error));
      const [inboundDate] = await sql<{ internal_date: Date }[]>`
        SELECT internal_date FROM mail.message_contents WHERE id = ${inbound.id}::uuid
      `;
      const [target] = await sql<{ latest_message_at: Date; subject: string }[]>`
        SELECT latest_message_at, subject FROM mail.conversations WHERE id = ${inbound.conversation_id}::uuid
      `;
      const newestReceived = Math.max(inboundDate!.internal_date.getTime(), other!.internal_date.getTime());
      expect(target!.latest_message_at.getTime()).toBe(newestReceived);
      expect(target!.subject).not.toBe("Re: Document request");

      // An operator's thread rebuild follows the same rule.
      const rebuild = await createMailCommand({
        context,
        mailboxId: mailbox.mailboxId,
        input: { kind: "rebuild_threads", idempotencyKey: `merge-scheduled-rebuild-${suffix}` },
        enqueue: false,
      });
      if (!rebuild.ok) throw new Error(JSON.stringify(rebuild.error));
      expect(await executeMaintenanceCommand(rebuild.data.id, undefined, { enqueueWork: false })).toBe("confirmed");
      const [rebuilt] = await sql<{ latest_message_at: Date }[]>`
        SELECT latest_message_at FROM mail.conversations WHERE id = ${inbound.conversation_id}::uuid
      `;
      expect(rebuilt!.latest_message_at.getTime()).toBe(newestReceived);
    } finally {
      provider.restore();
    }
  });

  test("a reply waiting for another send attempt leaves the conversation's date until it is sent", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const inbound = await receive(provider, mailbox, "retried");
      const draft = await replyDraft(mailbox, inbound);
      await waitForDraftExport(draft.id, ["active"]);
      const command = await createActorCommand({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          kind: "send",
          draftId: draft.id,
          expectedDraftRevision: draft.revision,
          senderIdentityId: mailbox.identityId,
          undoSeconds: 10,
          idempotencyKey: `retried-reply-${suffix}`,
        },
        enqueue: false,
      });
      if (!command.ok) throw new Error(JSON.stringify(command.error));
      const dates = async () => {
        const [row] = await sql<{ latest_message_at: Date; inbound_at: Date; reply_at: Date }[]>`
          SELECT conversation.latest_message_at, inbound.internal_date AS inbound_at, reply.internal_date AS reply_at
          FROM mail.conversations conversation
          JOIN mail.message_contents inbound ON inbound.id = ${inbound.id}::uuid
          JOIN mail.outbox_submissions outbox ON outbox.command_id = ${command.data.id}::uuid
          JOIN mail.message_contents reply ON reply.id = outbox.message_id
          WHERE conversation.id = ${inbound.conversation_id}::uuid
        `;
        if (!row) throw new Error("The conversation disappeared");
        return { latest: row.latest_message_at.getTime(), inbound: row.inbound_at.getTime(), reply: row.reply_at.getTime() };
      };
      // Right after Send, the reply dates the conversation.
      const sending = await dates();
      expect(sending.latest).toBe(sending.reply);

      const [outbox] = await sql<{ id: string }[]>`
        UPDATE mail.outbox_submissions
        SET scheduled_at = now() - interval '1 second', undo_until = now() - interval '1 second'
        WHERE command_id = ${command.data.id}::uuid
        RETURNING id
      `;
      const revision = async () => {
        const [row] = await sql<{ revision: string | number }[]>`
          SELECT revision FROM mail.conversations WHERE id = ${inbound.conversation_id}::uuid
        `;
        return Number(row!.revision);
      };
      const revisionBeforeRetry = await revision();
      provider.failNextSubmission("ESOCKET", false);
      expect(await executeOutboxSubmission(outbox!.id)).toBe("scheduled");
      const retrying = await dates();
      expect(retrying.latest).toBe(retrying.inbound);
      // The changed date is a new revision, so open views refresh the conversation.
      expect(await revision()).toBeGreaterThan(revisionBeforeRetry);

      expect(await sendRetryNow(outbox!.id)).toBe("sent");
      const sent = await dates();
      expect(sent.latest).toBe(sent.reply);
    } finally {
      provider.restore();
    }
  });

  test("a new message starts a conversation that waits for an answer", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await createDraft({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          senderIdentityId: mailbox.identityId,
          to: [{ name: "Customer", address: CUSTOMER }],
          cc: [],
          bcc: [],
          subject: "Announcement",
          body: "We are moving to a new office.",
          format: "plain",
          intent: "new",
        },
      });
      if (!draft.ok) throw new Error(JSON.stringify(draft.error));
      await waitForDraftExport(draft.data.id, ["active"]);
      const outbox = await send(mailbox, draft.data.id, draft.data.revision, "new-message");
      const [conversation] = await sql<{ work_status: string }[]>`
        SELECT conversation.work_status
        FROM mail.conversation_messages link
        JOIN mail.conversations conversation ON conversation.id = link.conversation_id
        WHERE link.message_id = ${outbox.message_id}::uuid
      `;
      expect(conversation?.work_status).toBe("waiting");
    } finally {
      provider.restore();
    }
  });

  test("a new message from another Gmail client waits for an answer whichever folder syncs first", async () => {
    const provider = createProvider("gmail");
    try {
      const mailbox = await connect(provider);
      const ownMessage = async (key: string, to: string, alsoInInbox: boolean) => {
        const messageId = `<own-${key}-${suffix}@example.test>`;
        await provider.storeSent(
          [
            `Message-ID: ${messageId}`,
            `Date: ${new Date().toUTCString()}`,
            `From: Owner <${OWNER}>`,
            `To: ${to}`,
            `Subject: Own message ${key}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Hello.",
          ].join("\r\n"),
          alsoInInbox,
        );
        return messageId;
      };
      const workStatus = async (messageId: string) => {
        const [conversation] = await sql<{ work_status: string }[]>`
          SELECT conversation.work_status
          FROM mail.message_contents message
          JOIN mail.conversation_messages link ON link.message_id = message.id
          JOIN mail.conversations conversation ON conversation.id = link.conversation_id
          WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid AND message.message_id = ${messageId}
        `;
        return conversation?.work_status;
      };

      // All Mail lists the message with its Sent label before the Sent folder syncs.
      const announcement = await ownMessage("announcement", CUSTOMER, false);
      await whenProviderFree(() => syncFolderBatch(mailbox.folderId(ALL), async () => undefined));
      expect(await workStatus(announcement)).toBe("waiting");

      // A contact form that sends through the mailbox's own account to itself is in Sent and the Inbox.
      const contactForm = await ownMessage("contact-form", OWNER, true);
      await whenProviderFree(() => syncFolderBatch(mailbox.folderId(SENT), async () => undefined));
      expect(await workStatus(contactForm)).toBe("needs_action");

      // An operator's thread rebuild gives both messages the same start.
      for (const messageId of [announcement, contactForm]) {
        await sql`
          DELETE FROM mail.conversation_messages link
          USING mail.message_contents message
          WHERE link.message_id = message.id
            AND message.mailbox_id = ${mailbox.mailboxId}::uuid
            AND message.message_id = ${messageId}
        `;
      }
      const rebuild = await createMailCommand({
        context,
        mailboxId: mailbox.mailboxId,
        input: { kind: "rebuild_threads", idempotencyKey: `own-message-rebuild-${suffix}` },
        enqueue: false,
      });
      if (!rebuild.ok) throw new Error(JSON.stringify(rebuild.error));
      expect(await executeMaintenanceCommand(rebuild.data.id, undefined, { enqueueWork: false })).toBe("confirmed");
      expect(await workStatus(announcement)).toBe("waiting");
      expect(await workStatus(contactForm)).toBe("needs_action");
    } finally {
      provider.restore();
    }
  });

  test("a draft saved in another client stays one draft through every later sync of a server without CONDSTORE", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const externalDraft = (subject: string) =>
        [
          `Message-ID: <external-draft-${suffix}@example.test>`,
          `Date: ${new Date().toUTCString()}`,
          `From: Owner <${OWNER}>`,
          `To: Customer <${CUSTOMER}>`,
          `Subject: ${subject}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "A note written in another client.",
        ].join("\r\n");
      await provider.saveDraftElsewhere(externalDraft("Started elsewhere"));
      const drafts = () =>
        sql<{ subject: string; revision: string }[]>`
          SELECT subject, revision::text FROM mail.drafts WHERE mailbox_id = ${mailbox.mailboxId}::uuid ORDER BY created_at
        `;
      const importsSettled = () =>
        waitFor(async () => {
          const [pending] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM mail.draft_provider_snapshots
            WHERE mailbox_id = ${mailbox.mailboxId}::uuid AND direction = 'import' AND state IN ('external', 'importing')
          `;
          return pending?.count === 0;
        }, "draft imports");

      await mailbox.syncAll();
      await importsSettled();
      expect(await drafts()).toEqual([{ subject: "Started elsewhere", revision: "1" }]);
      const observations = async () => {
        const [row] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM mail.draft_provider_snapshots
          WHERE mailbox_id = ${mailbox.mailboxId}::uuid AND direction = 'import'
        `;
        return row?.count ?? 0;
      };
      const observationsBefore = await observations();

      // Every six hours the Drafts folder is reconciled in full. Without MODSEQ, that cannot tell an
      // unchanged draft from an edited one, so each draft is downloaded and compared again.
      for (let round = 0; round < 2; round += 1) {
        await sql`
          UPDATE mail.folders
          SET envelope_cursor = jsonb_set(envelope_cursor, '{lastFullReconcileAt}', to_jsonb((now() - interval '7 hours')::text))
          WHERE id = ${mailbox.folderId(provider.draftsPath)}::uuid
        `;
        await mailbox.syncAll();
        await importsSettled();
      }
      // Seeing the same copy again leaves nothing behind, so the reconciliations do not pile up rows.
      expect(await observations()).toBe(observationsBefore);
      expect(await drafts()).toEqual([{ subject: "Started elsewhere", revision: "1" }]);

      // The other client saves an edit as a new message with the same Message-ID.
      provider.folder(provider.draftsPath).entries.clear();
      await provider.saveDraftElsewhere(externalDraft("Edited elsewhere"));
      await mailbox.syncAll();
      await importsSettled();
      expect(await drafts()).toEqual([{ subject: "Edited elsewhere", revision: "2" }]);
    } finally {
      provider.restore();
    }
  });

  test("the Drafts folder lists and counts the drafts saved in Mail and in another client", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      await provider.saveDraftElsewhere(
        [
          `Message-ID: <listed-draft-${suffix}@example.test>`,
          `Date: ${new Date().toUTCString()}`,
          `From: Owner <${OWNER}>`,
          `To: Customer <${CUSTOMER}>`,
          "Subject: Written elsewhere",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Saved in another client.",
        ].join("\r\n"),
      );
      const invalidations = async () => {
        const [row] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM events.outbox WHERE app_id = 'mail' AND ordering_key = ${mailbox.mailboxId}
        `;
        return row?.count ?? 0;
      };
      const invalidationsBefore = await invalidations();
      await mailbox.syncAll();
      await waitFor(async () => {
        const [imported] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM mail.drafts WHERE mailbox_id = ${mailbox.mailboxId}::uuid
        `;
        return imported?.count === 1;
      }, "the imported draft");
      // An open Drafts folder refreshes live when a draft arrives from another client.
      expect(await invalidations()).toBeGreaterThan(invalidationsBefore);
      const created = await createDraft({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          senderIdentityId: mailbox.identityId,
          to: [{ name: "Customer", address: CUSTOMER }],
          cc: [],
          bcc: [],
          subject: "Written in Mail",
          body: "Saved in Mail.",
          format: "plain",
          conversationId: null,
          intent: "new",
          sourceMessageId: null,
        },
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      await waitForDraftExport(created.data.id, ["active"]);
      await mailbox.syncAll();

      const draftsFolderId = mailbox.folderId(provider.draftsPath);
      const folders = await listFolders(context, mailbox.mailboxId);
      if (!folders.ok) throw new Error(folders.error.message);
      expect(folders.data.find((folder) => folder.id === draftsFolderId)).toMatchObject({ role: "drafts", total: 2, unread: 0 });

      const [draftsFolder] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.folders WHERE id = ${draftsFolderId}::uuid`;
      const request = await resolveWorkspaceRequest(
        new URL(`https://cloud.example.test/app/mail/mailbox?folder=${draftsFolder!.short_id}`),
        mailbox.mailboxId,
      );
      if (!request) throw new Error("Workspace request did not resolve");
      const page = await loadMailboxPageData({ context, mailboxId: mailbox.mailboxId, ...request });
      if (!page.ok) throw new Error(page.error.message);
      expect(page.data.draftsMode).toBe(true);
      expect(page.data.draftsPage?.total).toBe(2);
      expect(page.data.draftsPage?.items.map((item) => item.subject).sort()).toEqual(["Written elsewhere", "Written in Mail"]);
      expect(page.data.listItems).toEqual([]);
    } finally {
      provider.restore();
    }
  });
  // Waits only for the projection jobs Mail submitted itself: work that would wait for the maintenance sweep fails the test.
  const settleDraftImports = (mailboxId: string) =>
    waitFor(
      async () => {
        const [pending] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM mail.draft_provider_snapshots
        WHERE mailbox_id = ${mailboxId}::uuid
          AND state IN ('prepared', 'appending', 'retiring', 'external', 'importing')
      `;
        return pending?.count === 0;
      },
      "draft projection",
      20_000,
    );

  const draftElsewhere = (messageId: string, subject: string, body: string) =>
    [
      `Message-ID: ${messageId}`,
      `Date: ${new Date().toUTCString()}`,
      `From: Owner <${OWNER}>`,
      `To: Customer <${CUSTOMER}>`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\r\n");

  const mailboxDrafts = (mailboxId: string) =>
    sql<{ id: string; subject: string; body: string; revision: string; state: string; recoveries: number }[]>`
      SELECT
        draft.id,
        draft.subject,
        draft.body_markdown AS body,
        draft.revision::text,
        draft.state,
        (SELECT count(*)::int FROM mail.draft_recovery_copies recovery WHERE recovery.draft_id = draft.id) AS recoveries
      FROM mail.drafts draft
      WHERE draft.mailbox_id = ${mailboxId}::uuid
      ORDER BY draft.created_at
    `;

  const editInCloud = async (mailbox: Connected, draftId: string, expectedRevision: number, body: string) => {
    const updated = await updateDraft({
      context,
      mailboxId: mailbox.mailboxId,
      draftId,
      expectedRevision,
      input: {
        senderIdentityId: mailbox.identityId,
        to: [{ name: "Customer", address: CUSTOMER }],
        cc: [],
        bcc: [],
        subject: "Started elsewhere",
        body,
        format: "plain",
        priority: "normal",
        requestDeliveryReceipt: false,
        requestReadReceipt: false,
      },
    });
    if (!updated.ok) throw new Error(updated.error.message);
    return updated.data;
  };

  test("an edit another client saves from a copy older than the Cloud edit stays a recovery copy, however often it saves again", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const messageId = `<stale-copy-${suffix}@example.test>`;
      const drafts = provider.folder(provider.draftsPath).entries;
      await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Original text."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);
      const [imported] = await mailboxDrafts(mailbox.mailboxId);
      if (!imported) throw new Error("The external draft was not imported");

      // Mail replaces the copy in the Drafts folder with its own edit.
      const original = [...drafts.keys()];
      await editInCloud(mailbox, imported.id, 1, "Cloud edit.");
      await settleDraftImports(mailbox.mailboxId);
      expect(drafts.size).toBe(1);
      expect(drafts.has(original[0]!)).toBe(false);

      // The other client still shows the original and saves an edit of it, twice; each save replaces its previous one.
      const first = await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Other client edit one."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);
      drafts.delete(first.uid);
      await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Other client edit two."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);

      expect(await mailboxDrafts(mailbox.mailboxId)).toEqual([
        expect.objectContaining({ id: imported.id, body: "Cloud edit.", revision: "2", state: "draft", recoveries: 2 }),
      ]);
    } finally {
      provider.restore();
    }
  });

  test("a client that edits the current copy updates the draft once, even when it stores the edit twice", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const messageId = `<double-save-${suffix}@example.test>`;
      const drafts = provider.folder(provider.draftsPath).entries;
      const original = await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Original text."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);

      drafts.delete(original.uid);
      await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Edited elsewhere."));
      await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Edited elsewhere."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);

      expect(await mailboxDrafts(mailbox.mailboxId)).toEqual([
        expect.objectContaining({ body: "Edited elsewhere.", revision: "2", state: "draft", recoveries: 0 }),
      ]);
    } finally {
      provider.restore();
    }
  });

  test("a draft another client re-saved unchanged leaves the provider when discarded, and a later save from it starts a new draft", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const messageId = `<re-saved-${suffix}@example.test>`;
      const drafts = provider.folder(provider.draftsPath).entries;
      const original = await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Original text."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);

      drafts.delete(original.uid);
      await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Original text."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);
      const [draft] = await mailboxDrafts(mailbox.mailboxId);
      expect(draft).toEqual(expect.objectContaining({ body: "Original text.", revision: "1", state: "draft" }));

      const discarded = await discardDraft({ context, mailboxId: mailbox.mailboxId, draftId: draft!.id, expectedRevision: 1 });
      if (!discarded.ok) throw new Error(discarded.error.message);
      await settleDraftImports(mailbox.mailboxId);
      expect(drafts.size).toBe(0);

      // The other client still had the draft open and saves an edit.
      await provider.saveDraftElsewhere(draftElsewhere(messageId, "Started elsewhere", "Saved after the discard."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);
      expect(await mailboxDrafts(mailbox.mailboxId)).toEqual([
        expect.objectContaining({ id: draft!.id, state: "discarded", recoveries: 0 }),
        expect.objectContaining({ body: "Saved after the discard.", revision: "1", state: "draft" }),
      ]);
    } finally {
      provider.restore();
    }
  });

  test("an edit from another client imports into a draft whose attachment was uploaded in Mail", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const created = await createDraft({
        context,
        mailboxId: mailbox.mailboxId,
        input: {
          senderIdentityId: mailbox.identityId,
          to: [{ name: "Customer", address: CUSTOMER }],
          cc: [],
          bcc: [],
          subject: "With attachment",
          body: "Written in Mail.",
          format: "plain",
          conversationId: null,
          intent: "new",
          sourceMessageId: null,
        },
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const upload = await createDraftAttachmentUpload({
        context,
        mailboxId: mailbox.mailboxId,
        draftId: created.data.id,
        input: { filename: "notes.txt", contentType: "text/plain", byteLength: 5 },
      });
      if (!upload.ok) throw new Error(upload.error.message);
      const appended = await appendDraftAttachmentUpload({
        context,
        mailboxId: mailbox.mailboxId,
        draftId: created.data.id,
        uploadId: upload.data.id,
        offset: 0,
        bytes: Buffer.from("notes"),
      });
      if (!appended.ok) throw new Error(appended.error.message);
      const attached = await finalizeDraftAttachmentUpload({
        context,
        mailboxId: mailbox.mailboxId,
        draftId: created.data.id,
        uploadId: upload.data.id,
        expectedRevision: created.data.revision,
      });
      if (!attached.ok) throw new Error(attached.error.message);
      await settleDraftImports(mailbox.mailboxId);
      const [exported] = await sql<{ stable_message_id: string; uid: string }[]>`
        SELECT stable_message_id, uid::text FROM mail.draft_provider_snapshots
        WHERE draft_id = ${created.data.id}::uuid AND direction = 'export' AND state = 'active'
      `;
      if (!exported) throw new Error("The draft was not exported");

      // The other client replaces Mail's copy with its own edit, without Mail's headers or the attachment.
      provider.folder(provider.draftsPath).entries.delete(Number(exported.uid));
      await provider.saveDraftElsewhere(draftElsewhere(exported.stable_message_id, "With attachment", "Edited elsewhere."));
      await mailbox.syncAll();
      await settleDraftImports(mailbox.mailboxId);

      expect(await mailboxDrafts(mailbox.mailboxId)).toEqual([
        expect.objectContaining({ id: created.data.id, body: "Edited elsewhere.", revision: String(attached.data.revision + 1) }),
      ]);
      const [attachments] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM mail.draft_attachments WHERE draft_id = ${created.data.id}::uuid AND removed_at IS NULL
      `;
      expect(attachments?.count).toBe(0);
    } finally {
      provider.restore();
    }
  });

  const providerDrafts = async (provider: Provider) =>
    Promise.all(
      [...provider.folder(provider.draftsPath).entries.values()].map(async (message) => {
        const parsed = await simpleParser(message.source);
        return {
          revision: String(parsed.headers.get("x-cloud-draft-revision") ?? ""),
          body: parsed.text?.trim() ?? "",
          attachments: parsed.attachments.map((attachment) => attachment.filename),
        };
      }),
    );

  // A change that wakes no export of its own, as when its wake fails and Mail leaves the export to the sweep.
  const changeDraftWithoutWake = async (draftId: string, body: string) => {
    await sql`UPDATE mail.drafts SET body_markdown = ${body}, revision = revision + 1 WHERE id = ${draftId}::uuid`;
  };
  const providerDraftAppends = (provider: Provider) => provider.appends.filter((path) => path === provider.draftsPath).length;

  test("an attachment finished in Mail reaches the provider's Drafts folder without the maintenance sweep", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Notes attached later");
      await settleDraftImports(mailbox.mailboxId);
      expect(await providerDrafts(provider)).toEqual([{ revision: String(draft.revision), body: "The report is ready.", attachments: [] }]);

      const upload = await createDraftAttachmentUpload({
        context,
        mailboxId: mailbox.mailboxId,
        draftId: draft.id,
        input: { filename: "notes.txt", contentType: "text/plain", byteLength: 5 },
      });
      if (!upload.ok) throw new Error(upload.error.message);
      const appended = await appendDraftAttachmentUpload({
        context,
        mailboxId: mailbox.mailboxId,
        draftId: draft.id,
        uploadId: upload.data.id,
        offset: 0,
        bytes: Buffer.from("notes"),
      });
      if (!appended.ok) throw new Error(appended.error.message);
      const attached = await finalizeDraftAttachmentUpload({
        context,
        mailboxId: mailbox.mailboxId,
        draftId: draft.id,
        uploadId: upload.data.id,
        expectedRevision: draft.revision,
      });
      if (!attached.ok) throw new Error(attached.error.message);
      await settleDraftImports(mailbox.mailboxId);

      expect(await providerDrafts(provider)).toEqual([
        { revision: String(attached.data.revision), body: "The report is ready.", attachments: ["notes.txt"] },
      ]);
    } finally {
      provider.restore();
    }
  });

  test("a draft that changes while its copy is appended gets its current revision exported without the maintenance sweep", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      let changed = false;
      provider.duringNextDraftAppend(async (source) => {
        const draftId = /^X-Cloud-Draft-ID: *(\S+)/im.exec(source.toString("utf8"))?.[1];
        if (!draftId) throw new Error("The appended draft carries no Cloud draft ID");
        await changeDraftWithoutWake(draftId, "Changed during the append.");
        changed = true;
      });
      const draft = await newDraft(mailbox, "Changed mid-append");
      await settleDraftImports(mailbox.mailboxId);

      expect(changed).toBe(true);
      expect(await providerDrafts(provider)).toEqual([
        { revision: String(draft.revision + 1), body: "Changed during the append.", attachments: [] },
      ]);
    } finally {
      provider.restore();
    }
  });

  test("a draft that changes just before its copy is appended gets its current revision exported without the maintenance sweep", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Changed before the append");
      await settleDraftImports(mailbox.mailboxId);
      // A save's export takes the provider, and a second change whose wake fails commits right before it appends.
      await changeDraftWithoutWake(draft.id, "Saved once more.");
      const queued = await sql.begin((tx) => queueDraftProjectionInTransaction({ db: tx, draftId: draft.id }));
      if (!queued) throw new Error("No export was queued for the saved revision");
      let changed = false;
      provider.duringNextDraftsStatus(async () => {
        await changeDraftWithoutWake(draft.id, "Changed before the append.");
        changed = true;
      });
      await enqueueDraftProjectionSnapshot(queued);
      await settleDraftImports(mailbox.mailboxId);

      expect(changed).toBe(true);
      expect(await providerDrafts(provider)).toEqual([
        { revision: String(draft.revision + 2), body: "Changed before the append.", attachments: [] },
      ]);
      // The outdated revision stopped before its append.
      expect(providerDraftAppends(provider)).toBe(2);
    } finally {
      provider.restore();
    }
  });

  test("a draft that changes before its queued export starts gets its current revision exported without the maintenance sweep", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const draft = await newDraft(mailbox, "Changed before the export");
      await settleDraftImports(mailbox.mailboxId);
      // A save's export waits in the queue while a second change whose wake fails commits.
      await changeDraftWithoutWake(draft.id, "Saved once more.");
      const queued = await sql.begin((tx) => queueDraftProjectionInTransaction({ db: tx, draftId: draft.id }));
      if (!queued) throw new Error("No export was queued for the saved revision");
      await changeDraftWithoutWake(draft.id, "Changed before the export started.");
      await enqueueDraftProjectionSnapshot(queued);
      await settleDraftImports(mailbox.mailboxId);

      expect(await providerDrafts(provider)).toEqual([
        { revision: String(draft.revision + 2), body: "Changed before the export started.", attachments: [] },
      ]);
      // The outdated revision never started its append.
      expect(providerDraftAppends(provider)).toBe(2);
    } finally {
      provider.restore();
    }
  });

  test("with Drafts mapped to another folder, the provider's own Drafts folder lists its messages", async () => {
    const provider = createProvider("imap");
    try {
      const mailbox = await connect(provider);
      const mapped = await setFolderRole({ context, mailboxId: mailbox.mailboxId, folderId: mailbox.folderId("Sent"), role: "drafts" });
      if (!mapped.ok) throw new Error(mapped.error.message);
      await provider.storeIn(provider.draftsPath, inboundSource(`kept-in-drafts-${suffix}`, "Kept in the old Drafts folder"), ["\\Seen"]);
      await mailbox.syncAll();
      await waitForHydration(mailbox);

      const folders = await listFolders(context, mailbox.mailboxId);
      if (!folders.ok) throw new Error(folders.error.message);
      expect(folders.data.find((folder) => folder.id === mailbox.folderId(provider.draftsPath))).toMatchObject({ total: 1 });

      const [providerDrafts] = await sql<{ short_id: string }[]>`
        SELECT short_id FROM mail.folders WHERE id = ${mailbox.folderId(provider.draftsPath)}::uuid
      `;
      const request = await resolveWorkspaceRequest(
        new URL(`https://cloud.example.test/app/mail/mailbox?folder=${providerDrafts!.short_id}`),
        mailbox.mailboxId,
      );
      if (!request) throw new Error("Workspace request did not resolve");
      const page = await loadMailboxPageData({ context, mailboxId: mailbox.mailboxId, ...request });
      if (!page.ok) throw new Error(page.error.message);
      expect(page.data.draftsMode).toBe(false);
      expect(page.data.listItems.map((item) => item.subject)).toEqual(["Kept in the old Drafts folder"]);
    } finally {
      provider.restore();
    }
  });
});
