import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { unwrap } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { getConversationViewCounts, listConversations, listFolders } from "./messages";
import { listSavedViewConversations } from "./saved-views";
import { loadMailboxListView, resolveWorkspaceRequest } from "./workspace";

const suite = suiteFor("database", "nats", "valkey");

// Work lists show open conversations only; done and snoozed ones wait behind "Show done" (Focus "All active" rule).
suite("work lists leave out done and snoozed conversations", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId: string;
  let context: MailRequestContext;
  let mailboxId: string;
  let mailboxShortId: string;
  let accessIds: string[] = [];
  const folders: Record<"inbox" | "project" | "archive", { id: string; shortId: string }> = {} as never;
  const ids: Record<string, string> = {};
  let tag: { id: string; shortId: string };

  const createConversation = async (params: {
    key: string;
    folder: keyof typeof folders;
    status: "needs_action" | "waiting" | "done";
    snoozed?: boolean;
    unread?: boolean;
    subject?: string;
    minutesAgo: number;
  }) => {
    const date = new Date(Date.now() - params.minutesAgo * 60_000);
    const subject = params.subject ?? `${params.key} ${suffix}`;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.test>`}, ${subject}, ${subject.toLowerCase()}, ${date}, 128,
        ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'complete', ${`Text of ${subject}`}
      ) RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folders[params.folder].id}::uuid, ${message!.id}::uuid, 1, ${Math.floor(Math.random() * 1_000_000) + 1})
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${remoteRef!.id}::uuid, ${folders[params.folder].id}::uuid, ${message!.id}::uuid,
        ${params.unread ? sql`ARRAY[]::text[]` : sql`ARRAY['\\Seen']::text[]`}, ARRAY[]::text[])
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status, snoozed_until)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, 'Customer', ${date}, ${params.status},
        ${params.snoozed ? new Date(Date.now() + 86_400_000) : null})
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, ${date.getTime()}, 'headers')
    `;
    ids[params.key] = conversation!.id;
  };

  const listed = async (params: Omit<Parameters<typeof listConversations>[0], "context" | "mailboxId">) => {
    const page = unwrap(await listConversations({ context, mailboxId, ...params }));
    return { keys: page.items.map((item) => Object.keys(ids).find((key) => ids[key] === item.id)).sort(), openOnly: page.openOnly };
  };

  const workspace = async (query: string) => {
    const request = await resolveWorkspaceRequest(new URL(`http://mail.test/app/mail/${mailboxShortId}${query}`), mailboxId);
    if (!request) throw new Error(`Workspace URL did not resolve: ${query}`);
    const view = unwrap(await loadMailboxListView({ context, mailboxId, ...request, locale: "en" }));
    return {
      keys: view.listItems.map((item) => Object.keys(ids).find((key) => ids[key] === item.conversationId)).sort(),
      hiddenDone: view.hiddenDone,
    };
  };
  const searchParam = (expression: unknown) => `search=${encodeURIComponent(JSON.stringify({ expression, sort: "newest" }))}`;

  beforeAll(async () => {
    const uid = `open-work-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin) VALUES (${uid}, 'local', 'user', 'Open work', false) RETURNING id
    `;
    userId = user!.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid,
          provider: "local",
          profile: "user",
          displayName: "Open work",
          givenname: "Open",
          sn: "Work",
          mail: null,
          avatarHash: null,
          roles: ["user"],
          ipa: null,
          accountExpires: null,
          lastLoginLocal: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
        },
      },
      accessSubject: { type: "user", userId },
    };
    const mailbox = unwrap(await createMailbox(context, { name: `Open work ${suffix}` }));
    mailboxId = mailbox.id;
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = row!.short_id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'active')
      RETURNING id
    `;
    for (const [key, name, role] of [
      ["inbox", "Inbox", "inbox"],
      ["project", "Projects", "other"],
      ["archive", "Archive", "archive"],
    ] as const) {
      const shortId = newShortId();
      const [folder] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${shortId}, ${resource!.id}::uuid, ${`${key}-${suffix}`}, ${name}, ${role}, 'current')
        RETURNING id
      `;
      folders[key] = { id: folder!.id, shortId };
    }
    await createConversation({ key: "open", folder: "inbox", status: "needs_action", minutesAgo: 1 });
    await createConversation({ key: "waiting", folder: "inbox", status: "waiting", minutesAgo: 2 });
    await createConversation({
      key: "done",
      folder: "inbox",
      status: "done",
      unread: true,
      subject: `Invoice March ${suffix}`,
      minutesAgo: 3,
    });
    await createConversation({ key: "snoozed", folder: "inbox", status: "needs_action", snoozed: true, minutesAgo: 4 });
    await createConversation({ key: "projectOpen", folder: "project", status: "needs_action", minutesAgo: 5 });
    await createConversation({ key: "projectDone", folder: "project", status: "done", minutesAgo: 6 });
    await createConversation({ key: "archived", folder: "archive", status: "done", unread: true, minutesAgo: 7 });
    const tagShortId = newShortId();
    const [createdTag] = await sql<{ id: string }[]>`
      INSERT INTO mail.local_tags (short_id, mailbox_id, name, normalized_name, created_by_actor_kind, created_by_actor_id)
      VALUES (${tagShortId}, ${mailboxId}::uuid, 'Customer', 'customer', 'user', ${userId}::uuid)
      RETURNING id
    `;
    tag = { id: createdTag!.id, shortId: tagShortId };
    for (const key of ["projectOpen", "projectDone"]) {
      await sql`
        INSERT INTO mail.conversation_local_tags (mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id)
        VALUES (${mailboxId}::uuid, ${ids[key]!}::uuid, ${tag.id}::uuid, 'user', ${userId}::uuid)
      `;
    }
    accessIds = (await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`).map(
      (access) => access.access_id,
    );
  });

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  describe("the conversation API, CLI and Assistant list", () => {
    test("All mail, Inbox and an own folder list open work only", async () => {
      expect(await listed({})).toEqual({ keys: ["open", "projectOpen", "waiting"], openOnly: true });
      expect(await listed({ folderId: folders.inbox.id })).toEqual({ keys: ["open", "waiting"], openOnly: true });
      expect(await listed({ folderId: folders.project.id })).toEqual({ keys: ["projectOpen"], openOnly: true });
    });

    test("filing folders, an explicit status, a view and includeDone list everything they did before", async () => {
      expect(await listed({ folderId: folders.archive.id })).toEqual({ keys: ["archived"], openOnly: false });
      expect((await listed({ status: "done" })).keys).toEqual(["archived", "done", "projectDone"]);
      expect((await listed({ view: "done" })).keys).toEqual(["archived", "done", "projectDone"]);
      expect((await listed({ view: "snoozed" })).keys).toEqual(["snoozed"]);
      expect(await listed({ includeDone: true })).toEqual({
        keys: ["archived", "done", "open", "projectDone", "projectOpen", "snoozed", "waiting"],
        openOnly: false,
      });
      expect((await listed({ folderId: folders.inbox.id, includeDone: true })).keys).toEqual(["done", "open", "snoozed", "waiting"]);
    });

    test("a saved view without a status condition is a work list; one with a status keeps its rule", async () => {
      const saved = async (name: string, expression: unknown) => {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO mail.saved_conversation_views (short_id, mailbox_id, scope, name, filter, created_by_kind, created_by_id)
          VALUES (${newShortId()}, ${mailboxId}::uuid, 'mailbox', ${name}, ${{ expression, sort: "newest" }}::jsonb, 'user', ${userId}::uuid)
          RETURNING id
        `;
        return row!.id;
      };
      const tagged = await saved("Customers", { type: "local_tag_id", tagId: tag.id });
      const done = await saved("Done customers", {
        type: "and",
        expressions: [
          { type: "local_tag_id", tagId: tag.id },
          { type: "work_status", value: "done" },
        ],
      });
      const page = unwrap(await listSavedViewConversations({ context, mailboxId, viewId: tagged }));
      expect(page.items.map((item) => item.id)).toEqual([ids.projectOpen]);
      expect(page.openOnly).toBe(true);
      expect(unwrap(await listSavedViewConversations({ context, mailboxId, viewId: tagged, includeDone: true })).items).toHaveLength(2);
      expect(unwrap(await listSavedViewConversations({ context, mailboxId, viewId: done })).items.map((item) => item.id)).toEqual([
        ids.projectDone,
      ]);
    });
  });

  describe("the workspace list and its footer", () => {
    test("All mail names the Done tab's count at its end", async () => {
      const counts = unwrap(await getConversationViewCounts({ context, mailboxId }));
      expect(await workspace("")).toEqual({ keys: ["open", "projectOpen", "waiting"], hiddenDone: { count: counts.done, more: false } });
      expect(counts.done).toBe(3);
    });

    test("a folder names its own done conversations; a filing folder names none", async () => {
      expect(await workspace(`?folder=${folders.inbox.shortId}`)).toEqual({
        keys: ["open", "waiting"],
        hiddenDone: { count: 1, more: false },
      });
      expect(await workspace(`?folder=${folders.project.shortId}`)).toEqual({
        keys: ["projectOpen"],
        hiddenDone: { count: 1, more: false },
      });
      expect(await workspace(`?folder=${folders.archive.shortId}`)).toEqual({ keys: ["archived"], hiddenDone: null });
    });

    test("a tag or filter leaves done out and counts it; Show done adds the status condition", async () => {
      const tagged = { type: "local_tag_id", tagId: tag.shortId };
      expect(await workspace(`?${searchParam(tagged)}`)).toEqual({ keys: ["projectOpen"], hiddenDone: { count: 1, more: false } });
      const inboxUnread = {
        type: "and",
        expressions: [
          { type: "folder_id", folderId: folders.inbox.shortId },
          { type: "unread", folderId: folders.inbox.shortId },
        ],
      };
      expect(await workspace(`?folder=${folders.inbox.shortId}&${searchParam(inboxUnread)}`)).toEqual({
        keys: [],
        hiddenDone: { count: 1, more: false },
      });
      const showDone = { type: "and", expressions: [tagged, { type: "work_status", value: "done" }] };
      expect(await workspace(`?${searchParam(showDone)}`)).toEqual({ keys: ["projectDone"], hiddenDone: null });
      const inboxDone = {
        type: "and",
        expressions: [
          { type: "folder_id", folderId: folders.inbox.shortId },
          { type: "work_status", value: "done" },
        ],
      };
      expect((await workspace(`?folder=${folders.inbox.shortId}&${searchParam(inboxDone)}`)).keys).toEqual(["done"]);
    });

    test("a text search finds done conversations", async () => {
      expect(await workspace(`?q=${encodeURIComponent(`Invoice March ${suffix}`)}`)).toEqual({ keys: ["done"], hiddenDone: null });
    });

    test("work views keep their own rule and name nothing", async () => {
      expect((await workspace("?view=done")).hiddenDone).toBeNull();
      expect((await workspace("?view=done")).keys).toEqual(["archived", "done", "projectDone"]);
    });
  });

  test("a work folder's unread badge counts open conversations; a filing folder counts everything", async () => {
    const byId = new Map(unwrap(await listFolders(context, mailboxId)).map((folder) => [folder.id, folder]));
    expect(byId.get(folders.inbox.id)?.unread).toBe(0);
    expect(byId.get(folders.inbox.id)?.total).toBe(4);
    expect(byId.get(folders.archive.id)?.unread).toBe(1);
  });
});
