import { afterAll, afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
import { sql } from "bun";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { type ConnectorEnvelope, type EnvelopeBatchRequest, imapSmtpConnector } from "./connectors";
import { createMailbox } from "./mailboxes";
import { createProviderConnection } from "./provider-connections";
import { syncFolderBatch } from "./sync-runtime";

type FolderRole = "inbox" | "archive" | "drafts" | "all";
type RemoteMessage = { messageId: string; flags: Set<string> };
type RemoteFolder = { role: FolderRole; uidValidity: string; nextUid: number; entries: Map<number, RemoteMessage> };

const ROLES: FolderRole[] = ["inbox", "archive", "drafts", "all"];

const fixtureVerification = (account: string): ConnectorVerification => ({
  authenticatedPrincipal: account,
  serverIdentity: { serverInfo: { name: "fixture" } },
  capabilities: {
    idle: true,
    condstore: true,
    qresync: false,
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

/**
 * An in-memory IMAP account whose folders other clients change. A server with CONDSTORE reports
 * an unchanged HIGHESTMODSEQ, so only new UIDs and the folder's message count show a change.
 */
const createProvider = (params: { account: string; condstore: boolean; draftSearchRefused: boolean }) => {
  const folders = new Map<string, RemoteFolder>(
    ROLES.map((role, index) => [role, { role, uidValidity: String(500 + index), nextUid: 1, entries: new Map() }]),
  );
  const folder = (path: string): RemoteFolder => {
    const found = folders.get(path);
    if (!found) throw new Error(`No folder ${path}`);
    return found;
  };
  const envelope = (path: string, uid: number, folderStableKey: string): ConnectorEnvelope => {
    const message = folder(path).entries.get(uid)!;
    return {
      remoteRef: { folderStableKey, uidValidity: folder(path).uidValidity, uid: String(uid), modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId: message.messageId,
      inReplyTo: null,
      references: [],
      subject: `Remote change ${message.messageId}`,
      sentAt: new Date("2026-10-09T10:00:00Z"),
      internalDate: new Date("2026-10-09T10:00:00Z"),
      sizeBytes: 42,
      flags: [...message.flags].sort(),
      labels: [],
      addresses: {
        from: [{ name: null, address: "sender@example.test" }],
        replyTo: [],
        to: [{ name: null, address: "owner@example.test" }],
        cc: [],
        bcc: [],
      },
      mimeStructure: {},
    };
  };
  const calls = { windows: [] as [string, number, number][], envelopes: 0, draftCounts: 0 };
  /** Runs once after the next window listed the folder, like a change another client makes meanwhile. */
  let afterNextWindow: (() => void) | null = null;
  /** Runs once after the next envelope fetch, like a change another client makes meanwhile. */
  let afterNextEnvelopes: (() => void) | null = null;
  let ended = false;
  let holdNextEnvelopes = false;
  let heldEnvelopes: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const methods = {
    getFolderStatus: async (path: string) => ({
      uidValidity: folder(path).uidValidity,
      uidNext: folder(path).nextUid,
      highestModseq: params.condstore ? "1" : null,
      messages: folder(path).entries.size,
    }),
    fetchEnvelopeBatch: async (request: EnvelopeBatchRequest) => {
      calls.envelopes += 1;
      if (holdNextEnvelopes) {
        holdNextEnvelopes = false;
        await new Promise<void>((resolve, reject) => {
          heldEnvelopes = { resolve, reject };
        });
      }
      if (ended) throw endedProviderError("fetchEnvelopeBatch", params.account);
      const low = request.lowUid ?? 1;
      const uids = [...folder(request.folderPath).entries.keys()]
        .filter((uid) => (request.uids ? request.uids.includes(uid) : uid >= low && uid <= request.highUid))
        .sort((left, right) => right - left);
      const selected = uids.slice(0, request.limit);
      const batch = {
        messages: selected.map((uid) => envelope(request.folderPath, uid, request.folderStableKey)),
        nextHighUid: uids.length > request.limit ? uids[request.limit]! : null,
      };
      const change = afterNextEnvelopes;
      afterNextEnvelopes = null;
      change?.();
      return batch;
    },
    fetchFlagChanges: async () => [],
    fetchUidWindow: async (path: string, low: number, high: number) => {
      calls.windows.push([path, low, high]);
      const listed = [...folder(path).entries.entries()]
        .filter(([uid]) => uid >= low && uid <= high)
        .map(([uid, message]) => ({ uid, modseq: null, flags: [...message.flags].sort(), labels: [] }))
        .sort((left, right) => left.uid - right.uid);
      const change = afterNextWindow;
      afterNextWindow = null;
      change?.();
      return listed;
    },
    countDraftMessages: async (path: string, maxUid: number) => {
      calls.draftCounts += 1;
      if (params.draftSearchRefused) throw Object.assign(new Error("SEARCH failed"), { code: "IMAP_SEARCH_FAILED" });
      return [...folder(path).entries.entries()].filter(([uid, message]) => uid <= maxUid && message.flags.has("\\Draft")).length;
    },
  };
  return {
    account: params.account,
    methods,
    calls,
    resetCalls: () => {
      calls.windows.length = 0;
      calls.envelopes = 0;
      calls.draftCounts = 0;
    },
    /** Stores a message in the folder, at `uid` when given; the next UID follows the highest one. */
    put: (path: string, messageId: string, flags: string[] = [], uid?: number): number => {
      const target = folder(path);
      const placed = uid ?? target.nextUid;
      target.entries.set(placed, { messageId, flags: new Set(flags) });
      target.nextUid = Math.max(target.nextUid, placed + 1);
      return placed;
    },
    resetUidValidity: (path: string) => {
      const target = folder(path);
      target.uidValidity = String(Number(target.uidValidity) + 1000);
      target.entries.clear();
      target.nextUid = 1;
    },
    remove: (path: string, uid: number) => folder(path).entries.delete(uid),
    refuseDraftCount: (refused: boolean) => {
      params.draftSearchRefused = refused;
    },
    afterNextWindow: (change: () => void) => {
      afterNextWindow = change;
    },
    afterNextEnvelopes: (change: () => void) => {
      afterNextEnvelopes = change;
    },
    setFlags: (path: string, uid: number, flags: string[]) => {
      folder(path).entries.get(uid)!.flags = new Set(flags);
    },
    /** Holds the next envelope answer until teardown or another account connects. */
    holdNextEnvelopes: () => {
      holdNextEnvelopes = true;
    },
    anotherProviderCreated: () => {
      heldEnvelopes?.resolve();
      heldEnvelopes = null;
    },
    end: () => {
      ended = true;
      heldEnvelopes?.reject(endedProviderError("fetchEnvelopeBatch", params.account));
      heldEnvelopes = null;
    },
  };
};

type Provider = ReturnType<typeof createProvider>;
type TestState = { ended: boolean; providers: Set<Provider>; work: Set<Promise<unknown>> };

const endedProviderError = (method: string, account: string) =>
  Object.assign(new Error(`${method} for ${account} arrived after its test ended`), { code: "ENDED_TEST_PROVIDER" });

const assertTestActive = (state: TestState) => {
  if (state.ended) {
    throw Object.assign(new Error("The test ended (for example, timed out) before this sync's next batch"), { code: "TEST_ENDED" });
  }
};

export const useRemoteChangesFixture = () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  let userId = "";
  let ownerContext: MailRequestContext;
  const providers = new Map<string, Provider>();
  const tests = new Set<TestState>();
  let currentTest: TestState;
  const spies: { mockRestore: () => void }[] = [];
  const route = (method: keyof Provider["methods"], account: string) => {
    const provider = providers.get(account);
    if (!provider) throw endedProviderError(method, account);
    return provider.methods;
  };
  const trackForTest = <T>(state: TestState, work: Promise<T>): Promise<T> => {
    state.work.add(work);
    return work;
  };
  const track = <T>(work: Promise<T>): Promise<T> => trackForTest(currentTest, work);
  const endTest = (state: TestState) => {
    state.ended = true;
    for (const provider of state.providers) {
      providers.delete(provider.account);
      provider.end();
    }
  };
  const settleTest = async (state: TestState) => {
    // Settling connect() can resume a timed-out body that then tries to start its sync.
    while (state.work.size > 0) {
      const work = [...state.work];
      await Promise.allSettled(work);
      for (const promise of work) state.work.delete(promise);
    }
  };

  beforeEach(() => {
    currentTest = { ended: false, providers: new Set(), work: new Set() };
    tests.add(currentTest);
  });

  const connect = (label: string, condstore: boolean, draftSearchRefused = false) => {
    const state = currentTest;
    assertTestActive(state);
    return trackForTest(
      state,
      (async () => {
        const account = `${label}-${suffix}@example.test`;
        const provider = createProvider({ account, condstore, draftSearchRefused });
        for (const existing of providers.values()) existing.anotherProviderCreated();
        providers.set(account, provider);
        state.providers.add(provider);
        const mailbox = await createMailbox(ownerContext, { name: `Remote changes ${label} ${suffix}` });
        if (!mailbox.ok) throw new Error(mailbox.error.message);
        mailboxIds.push(mailbox.data.id);
        const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification(account));
        let connectionId = "";
        try {
          const connection = await createProviderConnection({
            context: ownerContext,
            mailboxId: mailbox.data.id,
            input: {
              name: `Remote changes ${label}`,
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
        const folderIds = new Map<string, string>();
        for (const [index, role] of ROLES.entries()) {
          const [folder] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role)
        VALUES (${newShortId()}, ${resource!.id}::uuid, ${`${role}:${500 + index}`}, ${role}, ${role})
        RETURNING id
      `;
          await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, uid_validity, uid_next, highest_modseq, effective_rights, rights_source, last_verified_at
        ) VALUES (
          ${binding!.id}::uuid, ${folder!.id}::uuid, ${role}, ${500 + index}, 1, 1, ARRAY['read']::text[], 'acl', now()
        )
      `;
          folderIds.set(role, folder!.id);
        }
        await sql`UPDATE mail.mailboxes SET health = 'active', health_reason = NULL WHERE id = ${mailbox.data.id}::uuid`;
        const folderId = (role: FolderRole): string => folderIds.get(role)!;
        /** One scheduler turn for the folder: the job runs batches while the sync reports more work. */
        const sync = (role: FolderRole, maxBatches = 20): Promise<number> =>
          trackForTest(
            state,
            (async () => {
              for (let batch = 1; batch <= maxBatches; batch += 1) {
                assertTestActive(state);
                const result = await syncFolderBatch(folderId(role), async () => assertTestActive(state));
                if (!result.hasMore) return batch;
              }
              throw new Error(`The ${role} sync still reported more work after ${maxBatches} batches`);
            })(),
          );
        const placements = async (messageId: string) =>
          sql<{ role: string; deleted: boolean; flags: string[] }[]>`
        SELECT folder.role, placement.deleted_at IS NOT NULL AS deleted, placement.flags
        FROM mail.message_placements placement
        JOIN mail.folders folder ON folder.id = placement.folder_id
        JOIN mail.message_contents content ON content.id = placement.message_id
        WHERE content.mailbox_id = ${mailbox.data.id}::uuid AND content.message_id = ${messageId}
        ORDER BY folder.role, placement.deleted_at NULLS FIRST
      `;
        return { remote: provider, mailboxId: mailbox.data.id, folderId, sync, placements };
      })(),
    );
  };

  const id = (name: string) => `<${name}-${suffix}@example.test>`;

  beforeAll(async () => {
    spies.push(
      spyOn(imapSmtpConnector, "getFolderStatus").mockImplementation(async (config, path) =>
        route("getFolderStatus", config.username).getFolderStatus(path),
      ),
      spyOn(imapSmtpConnector, "fetchEnvelopeBatch").mockImplementation(async (config, request) =>
        route("fetchEnvelopeBatch", config.username).fetchEnvelopeBatch(request),
      ),
      spyOn(imapSmtpConnector, "fetchFlagChanges").mockImplementation(async (config) =>
        route("fetchFlagChanges", config.username).fetchFlagChanges(),
      ),
      spyOn(imapSmtpConnector, "fetchUidWindow").mockImplementation(async (config, path, _uidValidity, low, high) =>
        route("fetchUidWindow", config.username).fetchUidWindow(path, low, high),
      ),
      spyOn(imapSmtpConnector, "countDraftMessages").mockImplementation(async (config, path, _uidValidity, maxUid) =>
        route("countDraftMessages", config.username).countDraftMessages(path, maxUid),
      ),
    );
    await migrate();
    const uid = `mail-remote-changes-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create the remote changes test user");
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
      requestId: `mail-remote-changes-${suffix}`,
    };
  });

  afterEach(async () => {
    const state = currentTest;
    endTest(state);
    await settleTest(state);
    state.providers.clear();
    tests.delete(state);
  });

  afterAll(async () => {
    for (const state of tests) endTest(state);
    await Promise.allSettled([...tests].map(settleTest));
    for (const spy of spies) spy.mockRestore();
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.draft_provider_snapshots WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  return {
    connect,
    id,
    suffix,
    ROLES,
    track,
    mailboxIds,
    get ownerContext() {
      return ownerContext;
    },
  };
};
