import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { ConversationView, FolderDisplay } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { listFocusConversations, listMailboxCounts } from "./focus";
import { setFolderDisplay } from "./folders";
import { createMailbox } from "./mailboxes";
import { getConversationViewCounts, listConversations, listFolders } from "./messages";
import { searchMessages } from "./search";
import { loadMailboxPageData, resolveWorkspaceRequest } from "./workspace";

const suite = suiteFor("database", "nats");

/**
 * A generic IMAP mailbox files each message in one folder; a Gmail-like one adds every message to
 * All Mail and files a labelled message once per label. Conversations whose mail lies only in a
 * "folder only" or hidden folder leave the views that mix folders; the rest stay.
 */
suite("mail folder display", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  let ownerId = "";
  let owner: MailRequestContext;
  let reader: MailRequestContext;
  let uid = 0;

  const contextFor = (id: string, uid: string): MailRequestContext => ({
    actor: {
      kind: "user",
      user: {
        id,
        uid,
        provider: "local",
        profile: "user",
        displayName: uid,
        givenName: "Folder",
        sn: "Display",
        mail: `${uid}@example.test`,
        roles: ["user"],
        memberofGroupIds: [],
        memberofGroups: [],
      } as never,
    },
    accessSubject: { type: "user", userId: id },
    requestId: `mail-folder-display-${suffix}`,
  });

  const createUser = async (label: string) => {
    const uid = `mail-folder-display-${label}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    userIds.push(row!.id);
    return { id: row!.id, context: contextFor(row!.id, uid) };
  };

  type Fixture = { mailboxId: string; resourceId: string; folders: Record<string, string> };

  const createFixtureMailbox = async (
    name: string,
    folders: Array<{ key: string; name: string; role: string; parent?: string; providerCollection?: boolean }>,
  ): Promise<Fixture> => {
    const created = await createMailbox(owner, { name: `${name} ${suffix}`, description: null });
    if (!created.ok) throw new Error(created.error.message);
    mailboxIds.push(created.data.id);
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${created.data.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'active')
      RETURNING id
    `;
    const ids: Record<string, string> = {};
    for (const folder of folders) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, parent_id, stable_key, name, role, provider_collection, sync_status)
        VALUES (
          ${newShortId()}, ${resource!.id}::uuid, ${folder.parent ? ids[folder.parent]! : null}::uuid, ${`${folder.key}-${suffix}`},
          ${folder.name}, ${folder.role}, ${folder.providerCollection ?? false}, 'current'
        )
        RETURNING id
      `;
      ids[folder.key] = row!.id;
    }
    return { mailboxId: created.data.id, resourceId: resource!.id, folders: ids };
  };

  /** One message, filed in each of `folderIds`; one without a folder is an outgoing reply that never arrived anywhere. */
  const addMessage = async (mailbox: Fixture, subject: string, minutesAgo: number, folderIds: string[], unread = true) => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (
        ${newShortId()}, ${mailbox.mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.test>`}, ${subject}, ${subject.toLowerCase()},
        now() - make_interval(mins => ${minutesAgo}), 128, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'complete',
        ${`Lighthouse ${subject}`}
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, 'Customer', 'customer@example.test', 'customer@example.test')
    `;
    for (const folderId of folderIds) {
      uid += 1;
      const [ref] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${uid})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
        VALUES (${ref!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid, ${unread ? "{}" : "{\\Seen}"}::text[], ARRAY[]::text[])
      `;
    }
    return message!.id;
  };

  const addConversation = async (
    mailbox: Fixture,
    subject: string,
    messages: string[][],
    options: { status?: "needs_action" | "waiting" | "done"; assignee?: string; snoozed?: boolean; minutesAgo?: number } = {},
  ) => {
    const minutesAgo = options.minutesAgo ?? 10;
    const messageIds: string[] = [];
    for (const [index, folderIds] of messages.entries()) {
      messageIds.push(await addMessage(mailbox, subject, minutesAgo + messages.length - index, folderIds));
    }
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (
        short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status, assignee_user_id, snoozed_until
      ) VALUES (
        ${newShortId()}, ${mailbox.mailboxId}::uuid, ${subject}, 'Customer', now() - make_interval(mins => ${minutesAgo}),
        ${options.status ?? "needs_action"}, ${options.assignee ?? null}::uuid,
        ${options.snoozed ? new Date(Date.now() + 86_400_000) : null}
      ) RETURNING id
    `;
    for (const [index, messageId] of messageIds.entries()) {
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${messageId}::uuid, ${index + 1}, 'headers')
      `;
    }
    return { id: conversation!.id, messageIds };
  };

  let imap: Fixture;
  let gmail: Fixture;
  const conversations: Record<string, string> = {};
  let failedReplyId = "";

  const setDisplay = async (mailbox: Fixture, folder: string, display: FolderDisplay) => {
    const result = await setFolderDisplay({ context: owner, mailboxId: mailbox.mailboxId, folderId: mailbox.folders[folder]!, display });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  };

  const subjectsOf = (ids: readonly string[]) => {
    const byId = new Map(Object.entries(conversations).map(([subject, id]) => [id, subject]));
    return ids.map((id) => byId.get(id) ?? id).sort();
  };

  const listed = async (mailbox: Fixture, view: ConversationView | null, folder?: string) => {
    const result = await listConversations({
      context: owner,
      mailboxId: mailbox.mailboxId,
      view,
      folderId: folder ? mailbox.folders[folder]! : null,
      limit: 100,
    });
    if (!result.ok) throw new Error(result.error.message);
    return subjectsOf(result.data.items.map((item) => item.id));
  };

  const workspace = async (mailbox: Fixture, query: string, listMode: "conversations" | "messages") => {
    const request = await resolveWorkspaceRequest(new URL(`https://cloud.example.test/app/mail/box${query}`), mailbox.mailboxId);
    if (!request) throw new Error("Workspace request did not resolve");
    const page = await loadMailboxPageData({ context: owner, mailboxId: mailbox.mailboxId, ...request, listMode });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.listError).toBeNull();
    return page.data;
  };

  beforeAll(async () => {
    await migrate();
    const ownerUser = await createUser("owner");
    ownerId = ownerUser.id;
    owner = ownerUser.context;
    const readerUser = await createUser("reader");
    reader = readerUser.context;

    imap = await createFixtureMailbox("IMAP", [
      { key: "inbox", name: "INBOX", role: "inbox" },
      { key: "sent", name: "Sent", role: "sent" },
      { key: "trash", name: "Trash", role: "trash" },
      { key: "projects", name: "Projects", role: "other" },
      { key: "shared", name: "Shared", role: "other" },
      { key: "team", name: "Team", role: "other", parent: "shared" },
      { key: "private", name: "Private", role: "other" },
    ]);
    gmail = await createFixtureMailbox("Gmail", [
      { key: "inbox", name: "INBOX", role: "inbox" },
      { key: "all", name: "All Mail", role: "all", providerCollection: true },
      { key: "important", name: "Important", role: "other", providerCollection: true },
      { key: "sent", name: "Sent Mail", role: "sent" },
      { key: "label", name: "Shared", role: "other" },
    ]);
    for (const mailbox of [imap, gmail]) {
      const granted = await grantMailboxAccess({
        context: owner,
        mailboxId: mailbox.mailboxId,
        principal: { type: "user", userId: readerUser.id },
        permission: "read",
      });
      if (!granted.ok) throw new Error(granted.error.message);
    }

    const i = imap.folders;
    const add = async (mailbox: Fixture, subject: string, messages: string[][], options?: Parameters<typeof addConversation>[3]) => {
      conversations[subject] = (await addConversation(mailbox, subject, messages, options)).id;
    };
    await add(imap, "inbox", [[i.inbox!]]);
    await add(imap, "projects", [[i.projects!]], { status: "waiting" });
    await add(imap, "team", [[i.team!]]);
    await add(imap, "shared and inbox", [[i.shared!], [i.inbox!]]);
    await add(imap, "shared and sent", [[i.shared!], [i.sent!]]);
    await add(imap, "shared and trash", [[i.shared!], [i.trash!]]);
    await add(imap, "shared assigned", [[i.shared!]], { assignee: ownerId });
    await add(imap, "shared waiting", [[i.shared!]], { status: "waiting" });
    await add(imap, "shared done", [[i.shared!]], { status: "done" });
    await add(imap, "shared snoozed", [[i.shared!]], { snoozed: true });
    await add(imap, "private", [[i.private!]]);
    const failed = await addConversation(imap, "shared failed send", [[i.shared!], []]);
    conversations["shared failed send"] = failed.id;
    failedReplyId = failed.messageIds[1]!;

    const g = gmail.folders;
    await add(gmail, "gmail inbox and label", [[g.inbox!, g.label!, g.all!]]);
    await add(gmail, "gmail label", [[g.label!, g.all!, g.important!]]);
    await add(gmail, "gmail label then inbox", [
      [g.label!, g.all!],
      [g.inbox!, g.all!],
    ]);
    await add(gmail, "gmail label and own reply", [
      [g.label!, g.all!],
      [g.sent!, g.all!],
    ]);

    // A failed reply in the Shared conversation, so Send problems has a conversation of a "folder only" folder.
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret
      ) VALUES (
        ${imap.mailboxId}::uuid, 'IMAP', 'team@example.test', 'team@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls', 'password', 'fixture'
      ) RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
      VALUES (${imap.resourceId}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb)
      RETURNING id
    `;
    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
      VALUES (${newShortId()}, ${imap.mailboxId}::uuid, 'team@example.test', 'Team')
      RETURNING id
    `;
    const [draft] = await sql<{ id: string }[]>`
      INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, state)
      VALUES (${newShortId()}, ${imap.mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${ownerId}::uuid, 'user', ${ownerId}::uuid, 'sent')
      RETURNING id
    `;
    const [command] = await sql<{ id: string }[]>`
      INSERT INTO mail.commands (
        mailbox_id, kind, actor_kind, actor_id, idempotency_key, request_hash, target, payload,
        access_subject_kind, access_subject_id, credential_scopes
      ) VALUES (
        ${imap.mailboxId}::uuid, 'send', 'user', ${ownerId}::uuid, ${`send-${suffix}`}, ${"f".repeat(64)},
        '{}'::jsonb, '{}'::jsonb, 'user', ${ownerId}::uuid, ARRAY[]::text[]
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.outbox_submissions (
        short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id,
        stable_message_id, state, last_error_code, mime_date, message_id
      ) VALUES (
        ${newShortId()}, ${imap.mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${identity!.id}::uuid,
        ${binding!.id}::uuid, ${`<failed-${suffix}@example.test>`}, 'failed', 'SMTP_REJECTED', now(), ${failedReplyId}::uuid
      )
    `;
  }, 30_000);

  afterAll(async () => {
    if (mailboxIds.length > 0) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access
        WHERE mailbox_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))`;
      if (access.length > 0) {
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))`;
      }
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  const IMAP_EVERYWHERE = ["inbox", "projects", "shared and inbox"];
  const IMAP_ALL = [
    ...IMAP_EVERYWHERE,
    "private",
    "shared and sent",
    "shared and trash",
    "shared assigned",
    "shared done",
    "shared failed send",
    "shared snoozed",
    "shared waiting",
    "team",
  ].sort();

  test("only a mailbox administrator sets a folder's display, and subfolders inherit the stricter one", async () => {
    const denied = await setFolderDisplay({
      context: reader,
      mailboxId: imap.mailboxId,
      folderId: imap.folders.shared!,
      display: "folder_only",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    expect(await listed(imap, null)).toEqual(IMAP_ALL);

    expect(await setDisplay(imap, "shared", "folder_only")).toEqual({
      folderId: imap.folders.shared!,
      display: "folder_only",
      effectiveDisplay: "folder_only",
      displayInheritedFromFolderId: null,
    });
    // A looser setting on the subfolder is kept, but the parent's stricter one applies.
    expect(await setDisplay(imap, "team", "everywhere")).toEqual({
      folderId: imap.folders.team!,
      display: "everywhere",
      effectiveDisplay: "folder_only",
      displayInheritedFromFolderId: imap.folders.shared!,
    });
    await setDisplay(imap, "private", "hidden");
    await setDisplay(gmail, "label", "folder_only");

    const folders = await listFolders(reader, imap.mailboxId);
    if (!folders.ok) throw new Error(folders.error.message);
    const byKey = (key: string) => folders.data.find((folder) => folder.id === imap.folders[key]);
    expect(byKey("team")).toMatchObject({
      display: "everywhere",
      effectiveDisplay: "folder_only",
      displayInheritedFromFolderId: imap.folders.shared,
      displayNeutral: false,
    });
    expect(byKey("private")).toMatchObject({ display: "hidden", effectiveDisplay: "hidden" });
    expect(byKey("sent")).toMatchObject({ effectiveDisplay: "everywhere", displayNeutral: true });
    const gmailFolders = await listFolders(owner, gmail.mailboxId);
    if (!gmailFolders.ok) throw new Error(gmailFolders.error.message);
    expect(
      gmailFolders.data
        .filter((folder) => folder.displayNeutral)
        .map((folder) => folder.name)
        .sort(),
    ).toEqual(["All Mail", "Important", "Sent Mail"]);
  });

  test("leaves conversations kept inside their folders out of All mail and every work view but Assigned to me", async () => {
    expect(await listed(imap, null)).toEqual(IMAP_EVERYWHERE);
    expect(await listed(imap, "recently_active")).toEqual(IMAP_EVERYWHERE);
    expect(await listed(imap, "needs_action")).toEqual(["inbox", "shared and inbox"]);
    expect(await listed(imap, "unassigned")).toEqual(["inbox", "projects", "shared and inbox"]);
    expect(await listed(imap, "waiting")).toEqual(["projects"]);
    expect(await listed(imap, "snoozed")).toEqual([]);
    expect(await listed(imap, "done")).toEqual([]);
    expect(await listed(imap, "mine")).toEqual(["shared assigned"]);
    expect(await listed(imap, "send_problems")).toEqual(["shared failed send"]);

    // Inside the folder everything stays, and so do its unread counts.
    expect(await listed(imap, null, "shared")).toEqual(
      [
        "shared and inbox",
        "shared and sent",
        "shared and trash",
        "shared assigned",
        "shared done",
        "shared failed send",
        "shared snoozed",
        "shared waiting",
      ].sort(),
    );
    expect(await listed(imap, null, "team")).toEqual(["team"]);
    expect(await listed(imap, null, "private")).toEqual(["private"]);
    const folders = await listFolders(owner, imap.mailboxId);
    if (!folders.ok) throw new Error(folders.error.message);
    expect(folders.data.find((folder) => folder.id === imap.folders.shared)?.unread).toBe(8);

    // Trash does not count either, and Gmail adds every message to All Mail and Important and one's own reply to Sent.
    expect(await listed(imap, "recently_active")).not.toContain("shared and trash");
    expect(await listed(gmail, null)).toEqual(["gmail inbox and label", "gmail label then inbox"]);
    expect(await listed(gmail, null, "label")).toEqual(
      ["gmail inbox and label", "gmail label", "gmail label and own reply", "gmail label then inbox"].sort(),
    );
  });

  test("counts each view the way it lists", async () => {
    const counts = await getConversationViewCounts({ context: owner, mailboxId: imap.mailboxId });
    expect(counts).toEqual({
      ok: true,
      data: {
        needs_action: 2,
        mine: 1,
        unassigned: 3,
        waiting: 1,
        done: 0,
        snoozed: 0,
        send_problems: 1,
        recently_active: 3,
      },
    });
    const gmailCounts = await getConversationViewCounts({ context: owner, mailboxId: gmail.mailboxId });
    expect(gmailCounts.ok && gmailCounts.data).toMatchObject({ needs_action: 2, unassigned: 2, recently_active: 2 });
  });

  test("lists the views the same way on the page, in both list modes", async () => {
    for (const [query, expected] of [
      ["", IMAP_EVERYWHERE],
      ["?view=needs_action", ["inbox", "shared and inbox"]],
      ["?view=unassigned", ["inbox", "projects", "shared and inbox"]],
      ["?view=waiting", ["projects"]],
      ["?view=snoozed", []],
      ["?view=done", []],
      ["?view=recently_active", IMAP_EVERYWHERE],
      ["?view=mine", ["shared assigned"]],
    ] as const) {
      const page = await workspace(imap, query, "conversations");
      expect(subjectsOf(page.listItems.map((item) => item.conversationId!)), query).toEqual([...expected]);
      expect(page.viewCounts.needs_action).toBe(2);
      const messages = await workspace(imap, query, "messages");
      expect([...new Set(subjectsOf(messages.listItems.map((item) => item.conversationId!)))], `${query} messages`).toEqual([...expected]);
    }
  });

  test("keeps search finding every conversation and says where its mail lies", async () => {
    const result = await searchMessages({
      context: owner,
      mailboxId: imap.mailboxId,
      request: { expression: { type: "text", field: "subject", query: "team", match: "words" }, sort: "newest", limit: 10 },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.items.map((item) => [item.conversationId, item.folderPath])).toEqual([[conversations.team!, "Shared / Team"]]);
    const everything = await searchMessages({
      context: owner,
      mailboxId: imap.mailboxId,
      request: { expression: { type: "all" }, sort: "newest", limit: 50 },
    });
    if (!everything.ok) throw new Error(everything.error.message);
    expect(subjectsOf(everything.data.items.map((item) => item.conversationId!))).toEqual(IMAP_ALL);
  });

  test("leaves them out of the cross-mailbox overview except where they are assigned to the person", async () => {
    const all = await listFocusConversations({ context: owner, view: "all", excludedMailboxIds: [], limit: 100 });
    if (!all.ok) throw new Error(all.error.message);
    const mine = mailboxIds;
    expect(subjectsOf(all.data.items.filter((item) => mine.includes(item.mailboxId)).map((item) => item.id))).toEqual(
      ["gmail inbox and label", "gmail label then inbox", "inbox", "projects", "shared and inbox"].sort(),
    );
    const assigned = await listFocusConversations({ context: owner, view: "mine", limit: 100 });
    if (!assigned.ok) throw new Error(assigned.error.message);
    expect(subjectsOf(assigned.data.items.filter((item) => mine.includes(item.mailboxId)).map((item) => item.id))).toEqual([
      "shared assigned",
    ]);
    const unassigned = await listFocusConversations({ context: reader, view: "unassigned", limit: 100 });
    if (!unassigned.ok) throw new Error(unassigned.error.message);
    expect(subjectsOf(unassigned.data.items.filter((item) => mine.includes(item.mailboxId)).map((item) => item.id))).toEqual(
      ["gmail inbox and label", "gmail label then inbox", "inbox", "shared and inbox"].sort(),
    );
    const counts = await listMailboxCounts(owner);
    if (!counts.ok) throw new Error(counts.error.message);
    expect(counts.data.filter((item) => mine.includes(item.mailboxId))).toEqual(
      expect.arrayContaining([
        { mailboxId: imap.mailboxId, unread: 3, needsAction: 2 },
        { mailboxId: gmail.mailboxId, unread: 2, needsAction: 2 },
      ]),
    );
  });

  test("brings conversations back once a folder shows its mail everywhere again", async () => {
    await setDisplay(imap, "shared", "everywhere");
    expect(await listed(imap, null)).toEqual(IMAP_ALL.filter((subject) => subject !== "private"));
    // A subfolder may still be stricter than its parent.
    await setDisplay(imap, "team", "folder_only");
    expect(await listed(imap, null)).not.toContain("team");
    expect(await listed(imap, "needs_action")).toContain("shared and sent");
  });
});
