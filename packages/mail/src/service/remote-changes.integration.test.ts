import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { createActorCommand, createMaintenanceCommand } from "./commands";
import type { ConnectorEnvelope } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { keepConversation, releaseConversationKeep } from "./conversation-keeps";
import { createMailbox } from "./mailboxes";
import { executeMaintenanceCommand } from "./maintenance-runtime";
import { getMessage } from "./messages";
import { createProviderConnection } from "./provider-connections";
import { submitDueFolderSyncs, syncFolderBatch } from "./sync-runtime";
import { createConversationTriageCommands } from "./triage";

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
const createProvider = (params: { condstore: boolean; draftSearchRefused: boolean }) => {
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
      const batch = {
        messages: selected.map((uid) => envelope(request.folderPath, uid, request.folderStableKey)),
        nextHighUid: uids.length > request.limit ? uids[request.limit]! : null,
      };
      const change = afterNextEnvelopes;
      afterNextEnvelopes = null;
      change?.();
      return batch;
    }),
    spyOn(imapSmtpConnector, "fetchFlagChanges").mockResolvedValue([]),
    spyOn(imapSmtpConnector, "fetchUidWindow").mockImplementation(async (_config, path, _uidValidity, low, high) => {
      calls.windows.push([path, low, high]);
      const listed = [...folder(path).entries.entries()]
        .filter(([uid]) => uid >= low && uid <= high)
        .map(([uid, message]) => ({ uid, modseq: null, flags: [...message.flags].sort(), labels: [] }))
        .sort((left, right) => left.uid - right.uid);
      const change = afterNextWindow;
      afterNextWindow = null;
      change?.();
      return listed;
    }),
    spyOn(imapSmtpConnector, "countDraftMessages").mockImplementation(async (_config, path, _uidValidity, maxUid) => {
      calls.draftCounts += 1;
      if (params.draftSearchRefused) throw Object.assign(new Error("SEARCH failed"), { code: "IMAP_SEARCH_FAILED" });
      return [...folder(path).entries.entries()].filter(([uid, message]) => uid <= maxUid && message.flags.has("\\Draft")).length;
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

  test("a kept message remains in its last folder after an external deletion, retires on reappearance and hides on release", async () => {
    const mailbox = await connect("keep-vanish", true);
    const uid = mailbox.remote.put("archive", id("kept-copy"));
    await mailbox.sync("archive");
    const [content] = await sql<{ id: string; conversation_id: string }[]>`SELECT message.id, link.conversation_id
      FROM mail.message_contents message JOIN mail.conversation_messages link ON link.message_id = message.id
      WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid AND message.message_id = ${id("kept-copy")}`;
    if (!content) throw new Error("Synced keep fixture missing");
    // No hydration worker runs here; a complete stored copy should not queue a download.
    await sql`UPDATE mail.message_contents SET hydration_status = 'complete', plain_text = 'Stored evidence' WHERE id = ${content.id}::uuid`;
    const scope = { context: ownerContext, mailboxId: mailbox.mailboxId, conversationId: content.conversation_id };
    expect((await keepConversation(scope)).ok).toBeTrue();
    mailbox.remote.remove("archive", uid);
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("kept-copy"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
    expect(await getMessage({ context: ownerContext, mailboxId: mailbox.mailboxId, messageId: content.id })).toMatchObject({
      ok: true,
      data: { deletedOnServer: true, plainText: "Stored evidence" },
    });
    // The folder stays writable on the server; only the message is gone there.
    await sql`
      UPDATE mail.binding_folder_refs SET effective_rights = ARRAY['read', 'write_flags']::text[]
      WHERE folder_id = ${mailbox.folderId("archive")}::uuid
    `;
    // Marking only Cloud's copy read changes it in Cloud and leaves the server alone.
    expect(
      await createConversationTriageCommands({
        ...scope,
        input: {
          kind: "change_state",
          sourceFolderId: mailbox.folderId("archive"),
          change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
          idempotencyKey: `kept-triage-${suffix}`,
        },
      }),
    ).toMatchObject({ ok: true, data: { commands: [] } });
    expect(await mailbox.placements(id("kept-copy"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Seen"] }]);
    const newUid = mailbox.remote.put("inbox", id("kept-copy"));
    await mailbox.sync("inbox");
    expect(await mailbox.placements(id("kept-copy"))).toEqual([
      { role: "archive", deleted: true, flags: ["\\Seen"] },
      { role: "inbox", deleted: false, flags: [] },
    ]);
    expect(await getMessage({ context: ownerContext, mailboxId: mailbox.mailboxId, messageId: content.id })).toMatchObject({
      ok: true,
      data: { deletedOnServer: false },
    });
    mailbox.remote.remove("inbox", newUid);
    await mailbox.sync("inbox");
    expect((await releaseConversationKeep(scope)).ok).toBeTrue();
    expect((await mailbox.placements(id("kept-copy"))).every((placement) => placement.deleted)).toBeTrue();
    expect(await sql<{ plain_text: string }[]>`SELECT plain_text FROM mail.message_contents WHERE id = ${content.id}::uuid`).toEqual([
      { plain_text: "Stored evidence" },
    ]);
  });

  test("archive and mark read change Cloud's kept copy in Cloud next to the server's messages, and never move it to Drafts", async () => {
    const mailbox = await connect("keep-triage", true);
    const goneUid = mailbox.remote.put("inbox", id("kept-gone"));
    mailbox.remote.put("inbox", id("kept-live"));
    await mailbox.sync("inbox");
    const rows = await sql<{ id: string; message_id: string; conversation_id: string }[]>`
      SELECT message.id, message.message_id, link.conversation_id
      FROM mail.message_contents message JOIN mail.conversation_messages link ON link.message_id = message.id
      WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid
    `;
    const gone = rows.find((row) => row.message_id === id("kept-gone"));
    const live = rows.find((row) => row.message_id === id("kept-live"));
    if (!gone || !live) throw new Error("Synced triage fixture missing");
    // A reply that joined the kept conversation; no hydration worker runs here.
    await sql`UPDATE mail.conversation_messages SET conversation_id = ${gone.conversation_id}::uuid WHERE message_id = ${live.id}::uuid`;
    await sql`UPDATE mail.message_contents SET hydration_status = 'complete' WHERE mailbox_id = ${mailbox.mailboxId}::uuid`;
    await sql`
      UPDATE mail.binding_folder_refs SET effective_rights = ARRAY['read', 'write_flags', 'insert', 'move']::text[]
      WHERE folder_id IN (${mailbox.folderId("inbox")}::uuid, ${mailbox.folderId("archive")}::uuid, ${mailbox.folderId("drafts")}::uuid)
    `;
    const scope = { context: ownerContext, mailboxId: mailbox.mailboxId, conversationId: gone.conversation_id };
    expect((await keepConversation(scope)).ok).toBeTrue();
    mailbox.remote.remove("inbox", goneUid);
    await mailbox.sync("inbox");
    expect(await mailbox.placements(id("kept-gone"))).toEqual([{ role: "inbox", deleted: false, flags: [] }]);
    expect(await getMessage({ context: ownerContext, mailboxId: mailbox.mailboxId, messageId: gone.id })).toMatchObject({
      ok: true,
      data: { deletedOnServer: true, remoteAvailable: false },
    });
    // A command for one message names the reason instead of a missing placement.
    expect(
      await createActorCommand({
        context: ownerContext,
        mailboxId: mailbox.mailboxId,
        enqueue: false,
        input: { kind: "delete", messageId: gone.id, folderId: mailbox.folderId("inbox"), idempotencyKey: `kept-direct-${suffix}` },
      }),
    ).toMatchObject({ ok: false, error: { code: "KEPT_COPY_ONLY", status: 409 } });
    const triage = (input: Parameters<typeof createConversationTriageCommands>[0]["input"]) =>
      createConversationTriageCommands({ ...scope, input });
    const read = await triage({
      kind: "change_state",
      sourceFolderId: mailbox.folderId("inbox"),
      change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
      idempotencyKey: `kept-read-${suffix}`,
    });
    expect(read.ok && read.data.commands.map((command) => command.kind)).toEqual(["change_message_state"]);
    expect(await mailbox.placements(id("kept-gone"))).toEqual([{ role: "inbox", deleted: false, flags: ["\\Seen"] }]);
    // Drafts would import the message as a draft, and discarding a draft deletes it on the server.
    expect(
      await triage({
        kind: "move_to_folder",
        sourceFolderId: mailbox.folderId("inbox"),
        destinationFolderId: mailbox.folderId("drafts"),
        idempotencyKey: `kept-drafts-${suffix}`,
      }),
    ).toMatchObject({ ok: false, error: { code: "CONVERSATION_KEPT", status: 409 } });
    const archived = await triage({
      kind: "move_to_role",
      role: "archive",
      sourceFolderId: mailbox.folderId("inbox"),
      idempotencyKey: `kept-archive-${suffix}`,
    });
    expect(archived.ok && archived.data.commands.map((command) => command.kind)).toEqual(["move"]);
    expect(await mailbox.placements(id("kept-gone"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Seen"] }]);
    // Only Cloud's copy is in Archive: moving it back queues nothing for the server.
    expect(
      await triage({
        kind: "move_to_role",
        role: "inbox",
        sourceFolderId: mailbox.folderId("archive"),
        idempotencyKey: `kept-back-${suffix}`,
      }),
    ).toMatchObject({ ok: true, data: { commands: [] } });
    expect(await mailbox.placements(id("kept-gone"))).toEqual([{ role: "inbox", deleted: false, flags: ["\\Seen"] }]);
  });

  test("UIDVALIDITY reset and folder rebuild preserve a kept copy", async () => {
    const mailbox = await connect("keep-reset", true);
    mailbox.remote.put("archive", id("kept-reset"));
    await mailbox.sync("archive");
    const [content] = await sql<{ id: string; conversation_id: string }[]>`SELECT message.id, link.conversation_id
      FROM mail.message_contents message JOIN mail.conversation_messages link ON link.message_id = message.id
      WHERE message.mailbox_id = ${mailbox.mailboxId}::uuid AND message.message_id = ${id("kept-reset")}`;
    if (!content) throw new Error("Synced reset fixture missing");
    await sql`UPDATE mail.message_contents SET hydration_status = 'complete' WHERE id = ${content.id}::uuid`;
    expect(
      (await keepConversation({ context: ownerContext, mailboxId: mailbox.mailboxId, conversationId: content.conversation_id })).ok,
    ).toBeTrue();
    mailbox.remote.resetUidValidity("archive");
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("kept-reset"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
    mailbox.remote.put("archive", id("kept-reset"));
    await mailbox.sync("archive");
    const rebuild = await createMaintenanceCommand({
      context: ownerContext,
      mailboxId: mailbox.mailboxId,
      enqueue: false,
      input: { kind: "rebuild_folder", folderId: mailbox.folderId("archive"), idempotencyKey: `keep-rebuild-${suffix}` },
    });
    if (!rebuild.ok) throw new Error(rebuild.error.message);
    expect(await executeMaintenanceCommand(rebuild.data.id, async () => undefined, { enqueueWork: false })).toBe("confirmed");
    expect((await mailbox.placements(id("kept-reset"))).filter((placement) => !placement.deleted)).toHaveLength(1);
    expect(await getMessage({ context: ownerContext, mailboxId: mailbox.mailboxId, messageId: content.id })).toMatchObject({
      ok: true,
      data: { deletedOnServer: true },
    });
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
    // The search starts at the newest window and stops as soon as the count matches again. A
    // window spans messages, not UIDs, so these three sparse messages need one window.
    expect(mailbox.remote.calls.windows).toEqual([["archive", 1, 12_000]]);

    // With nothing missing, the next sync only compares the counts.
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    expect(mailbox.remote.calls).toEqual({ windows: [], envelopes: 0, draftCounts: 0 });
  });

  test("a folder that receives new mail before every sync still notices a removed message", async () => {
    const mailbox = await connect("busy", true);
    mailbox.remote.put("archive", id("busy-kept"));
    const removed = mailbox.remote.put("archive", id("busy-removed"));
    await mailbox.sync("archive");

    mailbox.remote.remove("archive", removed);
    mailbox.remote.put("archive", id("busy-first"));
    await mailbox.sync("archive");
    mailbox.remote.put("archive", id("busy-second"));
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("busy-removed"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("busy-second"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
    expect(mailbox.remote.calls.windows).toHaveLength(1);

    // A message Mail itself moves away is no removal to search for, even while mail keeps coming.
    await sql`
      UPDATE mail.remote_message_refs
      SET stale_at = now()
      WHERE folder_id = ${mailbox.folderId("archive")}::uuid AND uid = 3
    `;
    mailbox.remote.remove("archive", 3);
    mailbox.remote.put("archive", id("busy-third"));
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    mailbox.remote.put("archive", id("busy-fourth"));
    await mailbox.sync("archive");
    mailbox.remote.put("archive", id("busy-fifth"));
    await mailbox.sync("archive");
    expect(mailbox.remote.calls.windows).toEqual([]);
    expect(await mailbox.placements(id("busy-fifth"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
  });

  test("two messages deleted one sync apart both leave the folder, and later removals are still found", async () => {
    const mailbox = await connect("apart", true);
    const uids = ["apart-1", "apart-2", "apart-3", "apart-4"].map((name) => mailbox.remote.put("archive", id(name)));
    await mailbox.sync("archive");

    mailbox.remote.remove("archive", uids[0]!);
    await mailbox.sync("archive");
    mailbox.remote.remove("archive", uids[1]!);
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("apart-1"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("apart-2"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);

    mailbox.remote.remove("archive", uids[2]!);
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("apart-3"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("apart-4"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
  });

  test("a message removed right after the search listed the folder is found by the next sync", async () => {
    const mailbox = await connect("raced", true);
    mailbox.remote.put("archive", id("raced-kept"));
    const first = mailbox.remote.put("archive", id("raced-first"));
    const during = mailbox.remote.put("archive", id("raced-during"));
    const later = mailbox.remote.put("archive", id("raced-later"));
    await mailbox.sync("archive");

    // Another client removes a second message right after the search listed the folder: the
    // search ends one message short, and the next sync searches again instead of taking the
    // difference for the server's way of counting.
    mailbox.remote.remove("archive", first);
    mailbox.remote.afterNextWindow(() => mailbox.remote.remove("archive", during));
    await mailbox.sync("archive");
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("raced-first"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("raced-during"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);

    mailbox.remote.remove("archive", later);
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("raced-later"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("raced-kept"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
  });

  test("a message removed in a window the search already passed is found by the next sync", async () => {
    const mailbox = await connect("raced-windows", true);
    // 5,000 skipped drafts make every search window span 5,000 UIDs: the folder needs four.
    const oldest = mailbox.remote.put("archive", id("windows-oldest"), [], 1);
    for (let uid = 2; uid <= 5_001; uid += 1) mailbox.remote.put("archive", id(`windows-draft-${uid}`), ["\\Draft"], uid);
    mailbox.remote.put("archive", id("windows-kept"), [], 9_000);
    const newest = mailbox.remote.put("archive", id("windows-newest"), [], 18_000);
    await mailbox.sync("archive", 40);

    // The newest message goes right after the search listed its window, and the search walks on
    // down to the oldest one.
    mailbox.remote.remove("archive", oldest);
    mailbox.remote.afterNextWindow(() => mailbox.remote.remove("archive", newest));
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    expect(mailbox.remote.calls.windows).toEqual([
      ["archive", 13_001, 18_000],
      ["archive", 8_001, 13_000],
      ["archive", 3_001, 8_000],
      ["archive", 1, 3_000],
    ]);
    expect(await mailbox.placements(id("windows-oldest"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);

    await mailbox.sync("archive");
    expect(await mailbox.placements(id("windows-newest"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("windows-kept"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
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

  test("without CONDSTORE, one window per sync covers a folder with sparse UIDs and rewrites no unchanged message", async () => {
    const mailbox = await connect("sparse-flags", false);
    const old = mailbox.remote.put("archive", id("sparse-old"), [], 1);
    const recent = mailbox.remote.put("archive", id("sparse-recent"), ["\\Seen"], 12_000);
    await mailbox.sync("archive");
    const versions = () =>
      sql<{ uid: string; version: string }[]>`
        SELECT uid::text AS uid, xmin::text AS version
        FROM mail.remote_message_refs
        WHERE folder_id = ${mailbox.folderId("archive")}::uuid AND stale_at IS NULL
        ORDER BY uid
      `;
    const before = await versions();
    expect(before.map((row) => Number(row.uid))).toEqual([old, recent]);

    mailbox.remote.setFlags("archive", old, ["\\Seen"]);
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("sparse-old"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Seen"] }]);
    expect(mailbox.remote.calls.windows).toEqual([["archive", 1, 12_000]]);
    expect(await versions()).toEqual(before);
  });

  test("a draft count the server refused once does not hide a later removal", async () => {
    const mailbox = await connect("refused-once", true);
    mailbox.remote.put("archive", id("once-kept"));
    const removed = mailbox.remote.put("archive", id("once-removed"));
    mailbox.remote.put("archive", id("once-other"));
    const draft = mailbox.remote.put("archive", id("once-draft"), ["\\Draft"]);
    await mailbox.sync("archive");

    // The draft leaves while the server refuses to count drafts: the search finds nothing to retire.
    mailbox.remote.remove("archive", draft);
    mailbox.remote.refuseDraftCount(true);
    await mailbox.sync("archive");
    await mailbox.sync("archive");

    mailbox.remote.refuseDraftCount(false);
    mailbox.remote.remove("archive", removed);
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("once-removed"))).toEqual([{ role: "archive", deleted: true, flags: [] }]);
    expect(await mailbox.placements(id("once-kept"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
  });

  test("a sweep window lists at most a window's worth of messages Mail keeps no record of", async () => {
    const mailbox = await connect("skipped-many", false);
    mailbox.remote.put("archive", id("bounded-old"), [], 1);
    for (let uid = 2; uid <= 5_001; uid += 1) mailbox.remote.put("archive", id(`bounded-draft-${uid}`), ["\\Draft"], uid);
    const recent = mailbox.remote.put("archive", id("bounded-recent"), [], 12_000);
    await mailbox.sync("archive", 40);

    mailbox.remote.setFlags("archive", recent, ["\\Seen"]);
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("bounded-recent"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Seen"] }]);
    // 5,000 skipped drafts: the window spans 5,000 UIDs instead of the two messages Mail holds.
    // The next older window follows in the same turn.
    expect(mailbox.remote.calls.windows).toEqual([
      ["archive", 7_001, 12_000],
      ["archive", 2_001, 7_000],
    ]);
  });

  test("without CONDSTORE, every sync reconciles the newest window and the older windows take turns", async () => {
    const mailbox = await connect("newest-flags", false);
    // 5,000 skipped drafts make every window span 5,000 UIDs: the folder needs four.
    mailbox.remote.put("archive", id("turns-oldest"), [], 1);
    for (let uid = 2; uid <= 5_001; uid += 1) mailbox.remote.put("archive", id(`turns-draft-${uid}`), ["\\Draft"], uid);
    const middle = mailbox.remote.put("archive", id("turns-middle"), [], 9_000);
    const newest = mailbox.remote.put("archive", id("turns-newest"), [], 18_000);
    await mailbox.sync("archive", 40);

    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    mailbox.remote.setFlags("archive", newest, ["\\Seen"]);
    mailbox.remote.setFlags("archive", middle, ["\\Flagged"]);
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("turns-newest"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Seen"] }]);
    await mailbox.sync("archive");
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("turns-middle"))).toEqual([{ role: "archive", deleted: false, flags: ["\\Flagged"] }]);
    expect(mailbox.remote.calls.windows).toEqual([
      ["archive", 13_001, 18_000],
      ["archive", 8_001, 13_000],
      ["archive", 13_001, 18_000],
      ["archive", 3_001, 8_000],
      ["archive", 13_001, 18_000],
      ["archive", 1, 3_000],
      ["archive", 13_001, 18_000],
      ["archive", 8_001, 13_000],
    ]);
  });

  test("without CONDSTORE, the first sync and new mail fetch each message once", async () => {
    const mailbox = await connect("single-fetch", false);
    for (let index = 1; index <= 650; index += 1) mailbox.remote.put("archive", id(`single-${index}`));
    await mailbox.sync("archive");
    expect(mailbox.remote.calls.envelopes).toBe(4);

    mailbox.remote.put("archive", id("single-new"));
    mailbox.remote.resetCalls();
    await mailbox.sync("archive");
    expect(mailbox.remote.calls.envelopes).toBe(1);
    expect(await mailbox.placements(id("single-new"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
  });

  test("without CONDSTORE, a new draft that another client sends while the sync runs arrives in the same sync", async () => {
    const mailbox = await connect("cleared-draft", false);
    mailbox.remote.put("archive", id("cleared-kept"));
    await mailbox.sync("archive");

    // The sync fetches the new message as a draft and skips it; its window then lists it as mail.
    const draft = mailbox.remote.put("archive", id("cleared-draft"), ["\\Draft"]);
    mailbox.remote.afterNextEnvelopes(() => mailbox.remote.setFlags("archive", draft, []));
    await mailbox.sync("archive");
    expect(await mailbox.placements(id("cleared-draft"))).toEqual([{ role: "archive", deleted: false, flags: [] }]);
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
    // Backfill and the first reconciliation end.
    await mailbox.sync("drafts", 10);
    const [tracked] = await sql<{ count: number }[]>`
      SELECT count(DISTINCT uid)::int AS count FROM mail.draft_provider_snapshots WHERE folder_id = ${mailbox.folderId("drafts")}::uuid
    `;
    expect(tracked?.count).toBe(250);

    // The next full reconciliation hands every draft to the draft projection again, one envelope
    // batch per window, and ends after the second window instead of repeating the first.
    await sql`
      UPDATE mail.folders
      SET envelope_cursor = jsonb_set(envelope_cursor, '{lastFullReconcileAt}', to_jsonb((now() - interval '7 hours')::text))
      WHERE id = ${mailbox.folderId("drafts")}::uuid
    `;
    mailbox.remote.resetCalls();
    expect(await mailbox.sync("drafts", 5)).toBe(2);
    expect(mailbox.remote.calls.windows).toEqual([
      ["drafts", 1, 250],
      ["drafts", 201, 250],
    ]);
    expect(mailbox.remote.calls.envelopes).toBe(2);

    // A draft deleted in another client leaves Mail's Drafts at the next sync.
    mailbox.remote.remove("drafts", 250);
    await mailbox.sync("drafts");
    const [missing] = await sql<{ state: string; last_error_code: string | null }[]>`
      SELECT state, last_error_code FROM mail.draft_provider_snapshots
      WHERE folder_id = ${mailbox.folderId("drafts")}::uuid AND uid = 250
    `;
    expect(missing).toEqual({ state: "needs_attention", last_error_code: "REMOTE_DRAFT_MISSING" });
  });

  test("Mail's own draft retirement and drafts it cannot track do not hide a draft deleted in another client", async () => {
    const mailbox = await connect("draft-states", true);
    const retired = mailbox.remote.put("drafts", id("draft-retired"), ["\\Draft"]);
    const conflicted = mailbox.remote.put("drafts", id("draft-conflicted"), ["\\Draft"]);
    const deleted = mailbox.remote.put("drafts", id("draft-deleted"), ["\\Draft"]);
    await mailbox.sync("drafts");
    const setState = (uid: number, state: string) => sql`
      UPDATE mail.draft_provider_snapshots
      SET state = ${state}
      WHERE folder_id = ${mailbox.folderId("drafts")}::uuid AND uid = ${uid}
    `;

    // Mail retires a draft revision: the server keeps it until Mail removes it.
    await setState(retired, "retiring");
    // An import that stopped on a conflict leaves its draft on the server.
    await setState(conflicted, "conflict");
    mailbox.remote.resetCalls();
    await mailbox.sync("drafts");
    mailbox.remote.remove("drafts", retired);
    await setState(retired, "retired");
    await mailbox.sync("drafts");
    expect(mailbox.remote.calls.windows).toEqual([]);

    mailbox.remote.remove("drafts", deleted);
    await mailbox.sync("drafts");
    const [missing] = await sql<{ state: string; last_error_code: string | null }[]>`
      SELECT state, last_error_code FROM mail.draft_provider_snapshots
      WHERE folder_id = ${mailbox.folderId("drafts")}::uuid AND uid = ${deleted}
    `;
    expect(missing).toEqual({ state: "needs_attention", last_error_code: "REMOTE_DRAFT_MISSING" });
  });

  test("a completed walk lowers an offset a raced search raised, also below zero", async () => {
    const mailbox = await connect("raced-drafts", true);
    const first = mailbox.remote.put("drafts", id("raced-draft-first"), ["\\Draft"]);
    const during = mailbox.remote.put("drafts", id("raced-draft-during"), ["\\Draft"]);
    const later = mailbox.remote.put("drafts", id("raced-draft-later"), ["\\Draft"]);
    const hidden = mailbox.remote.put("drafts", id("raced-draft-hidden"), ["\\Draft"]);
    const conflicted = mailbox.remote.put("drafts", id("raced-draft-conflicted"), ["\\Draft"]);
    await mailbox.sync("drafts");
    const state = async (uid: number) => {
      const [snapshot] = await sql<{ state: string }[]>`
        SELECT state FROM mail.draft_provider_snapshots
        WHERE folder_id = ${mailbox.folderId("drafts")}::uuid AND uid = ${uid}
      `;
      return snapshot?.state;
    };
    // A draft that stopped on a conflict stays on the server but out of Mail's count: offset -1.
    await sql`
      UPDATE mail.draft_provider_snapshots SET state = 'conflict'
      WHERE folder_id = ${mailbox.folderId("drafts")}::uuid AND uid = ${conflicted}
    `;
    await mailbox.sync("drafts");

    // A second draft goes right after the search listed the folder: the next sync searches again.
    mailbox.remote.remove("drafts", first);
    mailbox.remote.afterNextWindow(() => mailbox.remote.remove("drafts", during));
    await mailbox.sync("drafts");
    await mailbox.sync("drafts");
    expect(await state(first)).toBe("needs_attention");
    expect(await state(during)).toBe("needs_attention");

    // A search that found nothing to retire can still race a removal and raise the offset, here
    // by two. A draft deleted then hides behind it until the full reconciliation retires it.
    await sql`
      UPDATE mail.folders
      SET envelope_cursor = jsonb_set(envelope_cursor, '{countOffset}', '1'::jsonb)
      WHERE id = ${mailbox.folderId("drafts")}::uuid
    `;
    mailbox.remote.remove("drafts", hidden);
    await mailbox.sync("drafts");
    expect(await state(hidden)).not.toBe("needs_attention");

    // The walk lowers the offset again, and a removal before the next count check is found.
    await sql`
      UPDATE mail.folders
      SET envelope_cursor = jsonb_set(envelope_cursor, '{lastFullReconcileAt}', to_jsonb((now() - interval '7 hours')::text))
      WHERE id = ${mailbox.folderId("drafts")}::uuid
    `;
    await mailbox.sync("drafts");
    expect(await state(hidden)).toBe("needs_attention");
    mailbox.remote.remove("drafts", later);
    await mailbox.sync("drafts");
    expect(await state(later)).toBe("needs_attention");
    expect(await state(conflicted)).toBe("conflict");
  });

  test("every Inbox is queued on every scheduler run, and the other folders take the remaining places in turn", async () => {
    await connect("scheduler", true);
    const eligible = await submitDueFolderSyncs(100_000);
    const inboxes = (
      await sql<{ id: string }[]>`
        SELECT id FROM mail.folders
        WHERE role = 'inbox' AND id::text IN (SELECT jsonb_array_elements_text(${eligible}::jsonb))
      `
    )
      .map((folder) => folder.id)
      .sort();
    const others = eligible.length - inboxes.length;
    expect(inboxes.length).toBeGreaterThan(0);
    expect(others).toBeGreaterThanOrEqual(ROLES.length - 1);
    const queued = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      const folderIds = await submitDueFolderSyncs(inboxes.length + Math.ceil(others / 3));
      expect(folderIds.slice(0, inboxes.length).sort()).toEqual(inboxes);
      for (const folderId of folderIds) queued.add(folderId);
    }
    expect([...queued].sort()).toEqual([...eligible].sort());
  });
});
