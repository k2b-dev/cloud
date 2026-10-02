import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import type { ConnectorEnvelope } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { createMailbox } from "./mailboxes";
import { createProviderConnection } from "./provider-connections";
import { submitDueFolderSyncs, syncFolderBatch } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");

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
const createProvider = (params: { condstore: boolean; draftSearchRefused?: boolean }) => {
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
      sentAt: new Date(),
      internalDate: new Date(),
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
  const spies = [
    spyOn(imapSmtpConnector, "getFolderStatus").mockImplementation(async (_config, path) => ({
      uidValidity: folder(path).uidValidity,
      uidNext: folder(path).nextUid,
      highestModseq: params.condstore ? "1" : null,
      messages: folder(path).entries.size,
    })),
    spyOn(imapSmtpConnector, "fetchEnvelopeBatch").mockImplementation(async (_config, request) => {
      calls.envelopes += 1;
      const low = request.lowUid ?? 1;
      const uids = [...folder(request.folderPath).entries.keys()]
        .filter((uid) => (request.uids ? request.uids.includes(uid) : uid >= low && uid <= request.highUid))
        .sort((left, right) => right - left);
      const selected = uids.slice(0, request.limit);
      return {
        messages: selected.map((uid) => envelope(request.folderPath, uid, request.folderStableKey)),
        nextHighUid: uids.length > request.limit ? uids[request.limit]! : null,
      };
    }),
    spyOn(imapSmtpConnector, "fetchFlagChanges").mockResolvedValue([]),
    spyOn(imapSmtpConnector, "fetchUidWindow").mockImplementation(async (_config, path, _uidValidity, low, high) => {
      calls.windows.push([path, low, high]);
      return [...folder(path).entries.entries()]
        .filter(([uid]) => uid >= low && uid <= high)
        .map(([uid, message]) => ({ uid, modseq: null, flags: [...message.flags].sort(), labels: [] }))
        .sort((left, right) => left.uid - right.uid);
    }),
    spyOn(imapSmtpConnector, "countDraftMessages").mockImplementation(async (_config, path) => {
      calls.draftCounts += 1;
      if (params.draftSearchRefused) throw Object.assign(new Error("SEARCH failed"), { code: "IMAP_SEARCH_FAILED" });
      return [...folder(path).entries.values()].filter((message) => message.flags.has("\\Draft")).length;
    }),
  ];
  return {
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
    remove: (path: string, uid: number) => folder(path).entries.delete(uid),
    setFlags: (path: string, uid: number, flags: string[]) => {
      folder(path).entries.get(uid)!.flags = new Set(flags);
    },
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
};

type Provider = ReturnType<typeof createProvider>;

suite("mail sync of changes made in other clients", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  let userId = "";
  let ownerContext: MailRequestContext;
  let provider: Provider | null = null;

  const connect = async (label: string, condstore: boolean, draftSearchRefused = false) => {
    provider = createProvider({ condstore, draftSearchRefused });
    const account = `${label}-${suffix}@example.test`;
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
    const sync = async (role: FolderRole, maxBatches = 20): Promise<number> => {
      for (let batch = 1; batch <= maxBatches; batch += 1) {
        const result = await syncFolderBatch(folderId(role), async () => undefined);
        if (!result.hasMore) return batch;
      }
      throw new Error(`The ${role} sync still reported more work after ${maxBatches} batches`);
    };
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
  };

  const id = (name: string) => `<${name}-${suffix}@example.test>`;

  beforeAll(async () => {
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

  afterEach(() => {
    provider?.restore();
    provider = null;
  });

  afterAll(async () => {
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

  test("a message deleted or moved in another client leaves its folder at the next sync, outside Inbox too", async () => {
    const mailbox = await connect("moves", true);
    // Sparse UIDs: the folder spans several reconcile windows.
    mailbox.remote.put("archive", id("old"), ["\\Seen"], 1);
    const moved = mailbox.remote.put("archive", id("moved"), ["\\Seen"], 9_000);
    const deleted = mailbox.remote.put("archive", id("deleted"), ["\\Seen"], 12_000);
    await mailbox.sync("archive");
    await mailbox.sync("inbox");
    expect(await mailbox.placements(id("moved"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Seen"] }]);

    mailbox.remote.remove("archive", deleted);
    mailbox.remote.remove("archive", moved);
    mailbox.remote.put("inbox", id("moved"), ["\\Seen"]);
    mailbox.remote.resetCalls();
    await mailbox.sync("inbox");
    await mailbox.sync("archive");

    expect(await mailbox.placements(id("deleted"))).toEqual([{ role: "archive", deleted: true, flags: ["\\Seen"] }]);
    expect(await mailbox.placements(id("moved"))).toEqual([
      { role: "archive", deleted: true, flags: ["\\Seen"] },
      { role: "inbox", deleted: false, flags: ["\\Seen"] },
    ]);
    expect(await mailbox.placements(id("old"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Seen"] }]);
    // The search starts at the newest window and stops as soon as the count matches again.
    expect(mailbox.remote.calls.windows).toEqual([["archive", 7_001, 12_000]]);

    // With nothing missing, the next sync only compares the counts.
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    expect(mailbox.remote.calls).toEqual({ windows: [], envelopes: 0, draftCounts: 0 });
  });

  test("a server without CONDSTORE still delivers read and flag changes made in another client", async () => {
    const mailbox = await connect("flags", false);
    const uid = mailbox.remote.put("archive", id("unread"));
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("unread"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);

    mailbox.remote.setFlags("archive", uid, ["\\Flagged", "\\Seen"]);
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("unread"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Flagged", "\\Seen"] }]);
  });

  test("a draft that leaves a folder Mail skips drafts in costs a draft count, not a search", async () => {
    const mailbox = await connect("skipped-drafts", true);
    mailbox.remote.put("all", id("kept"));
    const draft = mailbox.remote.put("all", id("draft"), ["\\Draft"]);
    const removed = mailbox.remote.put("all", id("removed"));
    await mailbox.sync("all");
    expect(await mailbox.placements(id("draft"))).toEqual([]);

    // A new draft arrives, then both drafts leave, as when another client saves and sends them.
    const saved = mailbox.remote.put("all", id("saved"), ["\\Draft"]);
    await mailbox.sync("all");
    mailbox.remote.remove("all", saved);
    mailbox.remote.remove("all", draft);
    mailbox.remote.resetCalls();
    await mailbox.sync("all");
    expect(mailbox.remote.calls).toEqual({ windows: [], envelopes: 0, draftCounts: 1 });

    // A message that leaves while a new draft arrives is still found.
    mailbox.remote.put("all", id("next-draft"), ["\\Draft"]);
    mailbox.remote.remove("all", removed);
    await mailbox.sync("all");
    await mailbox.sync("all");
    expect(await mailbox.placements(id("removed"))).toEqual([{ role: "all", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("kept"))).toEqual([{ role: "all", deleted: false, flags: [] }]);
  });

  test("a server that refuses the draft count still gets its removed messages found", async () => {
    const mailbox = await connect("refused-draft-count", true, true);
    mailbox.remote.put("archive", id("stays"));
    const removed = mailbox.remote.put("archive", id("goes"));
    await mailbox.sync("archive");
    mailbox.remote.remove("archive", removed);
    await mailbox.sync("archive");
    expect(mailbox.remote.calls.draftCounts).toBe(1);
    expect(await mailbox.placements(id("goes"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("stays"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
  });

  test("a Drafts folder with more drafts than one envelope batch finishes its reconciliation", async () => {
    const mailbox = await connect("many-drafts", true);
    for (let index = 1; index <= 250; index += 1) mailbox.remote.put("drafts", id(`draft-${index}`), ["\\Draft"]);
    // Backfill and the first reconciliation end; the drafts it already tracks need no second import.
    await mailbox.sync("drafts", 10);
    const [tracked] = await sql<{ count: number }[]>`
      SELECT count(DISTINCT uid)::int AS count FROM mail.draft_provider_snapshots WHERE folder_id = ${mailbox.folderId("drafts")}::uuid
    `;
    expect(tracked?.count).toBe(250);

    // The next full reconciliation lists the drafts again and fetches no envelopes for them.
    await sql`
      UPDATE mail.folders
      SET envelope_cursor = jsonb_set(envelope_cursor, '{lastFullReconcileAt}', to_jsonb((now() - interval '7 hours')::text))
      WHERE id = ${mailbox.folderId("drafts")}::uuid
    `;
    mailbox.remote.resetCalls();
    expect(await mailbox.sync("drafts", 3)).toBe(1);
    expect(mailbox.remote.calls.windows).toHaveLength(1);
    expect(mailbox.remote.calls.envelopes).toBe(0);

    // A draft deleted in another client leaves Mail's Drafts at the next sync.
    mailbox.remote.remove("drafts", 250);
    await mailbox.sync("drafts");
    const [missing] = await sql<{ state: string; last_error_code: string | null }[]>`
      SELECT state, last_error_code FROM mail.draft_provider_snapshots
      WHERE folder_id = ${mailbox.folderId("drafts")}::uuid AND uid = 250
    `;
    expect(missing).toEqual({ state: "needs_attention", last_error_code: "REMOTE_DRAFT_MISSING" });
  });

  test("every eligible folder gets its turn when more folders are due than one scheduler run queues", async () => {
    await connect("scheduler", true);
    const eligible = await submitDueFolderSyncs(100_000);
    expect(eligible.length).toBeGreaterThanOrEqual(ROLES.length);
    const limit = Math.ceil(eligible.length / 3);
    const queued = new Set<string>();
    for (let run = 0; run < 3; run += 1) for (const folderId of await submitDueFolderSyncs(limit)) queued.add(folderId);
    expect([...queued].sort()).toEqual([...eligible].sort());
  });
});
