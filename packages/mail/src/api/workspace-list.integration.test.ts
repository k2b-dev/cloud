import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import type { InferResponseType } from "hono/client";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { composeMailListSnapshot, pickMailWorkspaceFrame } from "../frontend/_components/mail-workspace-frame";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import * as access from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { mailLive } from "../service/live";
import * as localTags from "../service/local-tags";
import * as mailboxes from "../service/mailboxes";
import * as messages from "../service/messages";
import * as publicResources from "../service/public-resources";
import * as scheduledSends from "../service/scheduled-sends";
import * as senderIdentities from "../service/sender-identities";
import {
  loadMailboxListView,
  loadMailboxPageData,
  type MailboxListView,
  type MailboxPageData,
  resolveWorkspaceRequest,
} from "../service/workspace";
import app from ".";
import type { apiClient } from "./client";

// Check the browser's actual Hono client inference without a cast or a runtime browser import.
type ListResponse = InferResponseType<(typeof apiClient.mailboxes)[":mailboxId"]["workspace-list"]["$get"], 200>;
const inferredListView = (data: ListResponse): MailboxListView => data;

// Page 2 of the folder fixture with a conversation open, measured on 2026-10-18: workspace-route sends 25,254 bytes
// (the whole workspace and the open conversation's detail), workspace-list 3,411 bytes. The budget sits between them
// with room for row fields, and fails when a list page carries the workspace or the selection again.
const WORKSPACE_LIST_PAGE_TWO_MAX_BYTES = 5_000;
// Page 1 of the folder fixture on a folder switch, measured on 2026-10-19: workspace-route sends 48,045 bytes (the
// list plus mailbox, folders, counts, identities and saved views), workspace-list 44,940 bytes. Fifty rows dominate
// this small mailbox; the budget sits between the two and fails when the switch carries the mailbox frame again.
const WORKSPACE_LIST_FOLDER_SWITCH_MAX_BYTES = 46_000;
const anchor = new Date("2026-10-01T12:00:00.000Z");
const suite = suiteFor("database", "nats", "valkey");
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: null,
});
const listFields = [
  "scheduledMode",
  "scheduledPage",
  "scheduledError",
  "draftsMode",
  "draftsPage",
  "draftsError",
  "activeView",
  "savedViewId",
  "listMode",
  "folderId",
  "query",
  "search",
  "listItems",
  "listCursor",
  "nextListCursor",
  "listError",
  "listTitle",
] as const;
const listPart = (data: MailboxListView) =>
  Object.fromEntries([
    ...listFields.map((key) => [key, data[key]]),
    ...(data.scheduledMode ? [["scheduledCount", data.scheduledCount]] : []),
  ]);
const nextCursor = (data: MailboxListView) => data.scheduledPage?.nextCursor ?? data.draftsPage?.nextCursor ?? data.nextListCursor;
const rows = (data: MailboxListView) => data.scheduledPage?.items ?? data.draftsPage?.items ?? data.listItems;

type Scope = { name: string; params: Record<string, string>; listMode?: "messages" };
suite("Mail workspace list pages", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: User[] = [];
  let owner: User;
  let reader: User;
  let outsider: User;
  let tokenSpy: ReturnType<typeof spyOn<typeof oauthTokens, "verifyAccessToken">> | undefined;
  let mailboxId = "";
  let mailboxShortId = "";
  let folderShortId = "";
  let draftsShortId = "";
  let savedViewShortId = "";
  let conversationShortId = "";
  let messageShortId = "";
  const hiddenIds = new Set<string>();
  const visibleIds = new Set<string>();
  const scopes = (): Scope[] => [
    { name: "folder", params: { folder: folderShortId } },
    { name: "needs_action", params: { view: "needs_action" } },
    { name: "saved view", params: { savedView: savedViewShortId } },
    { name: "search", params: { search: JSON.stringify({ expression: { type: "folder_id", folderId: folderShortId }, sort: "newest" }) } },
    { name: "messages", params: { folder: folderShortId }, listMode: "messages" },
    { name: "drafts", params: { folder: draftsShortId } },
    { name: "scheduled", params: { scheduled: "1" } },
  ];
  // Every unselected scope available from the workspace sidebar or search control.
  const switchScopes = (): Scope[] => [
    ...scopes().filter((scope) => scope.name !== "search" && scope.name !== "messages"),
    { name: "assigned to me", params: { view: "mine" } },
    { name: "search", params: { q: "Page", searchFrom: `folder=${folderShortId}` } },
    { name: "all mail", params: {} },
  ];
  const switchHref = (scope: Scope) => {
    const query = new URLSearchParams(scope.params).toString();
    return `/app/mail/${mailboxShortId}${query ? `?${query}` : ""}`;
  };
  const snapshot = async (href: string, token: string): Promise<MailboxPageData> => {
    const response = await request("workspace-route", href, token);
    expect(response.status, href).toBe(200);
    return response.json();
  };
  const hrefFor = (scope: Scope, cursor?: string) =>
    `/app/mail/${mailboxShortId}?${new URLSearchParams({
      ...scope.params,
      conversation: conversationShortId,
      message: messageShortId,
      ...(cursor ? { cursor } : {}),
    })}`;
  const request = (route: string, href: string, token = "owner", listMode?: "messages") =>
    app.request(`/mailboxes/${mailboxShortId}/${route}?${new URLSearchParams({ href, ...(listMode ? { listMode } : {}) })}`, {
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": uniqueCallerAddress() },
    });
  const page = async (route: string, href: string, token: string, scope: Scope): Promise<MailboxListView> => {
    const response = await request(route, href, token, scope.listMode);
    expect(response.status, `${scope.name}: ${route}`).toBe(200);
    return inferredListView(await response.json());
  };
  const createUser = async (role: string): Promise<User> => {
    const uid = `mail-list-${role}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${role}, false) RETURNING id`;
    const user: User = {
      id: row!.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: role,
      sn: "Test",
      displayName: role,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    users.push(user);
    return user;
  };

  beforeAll(async () => {
    await migrate();
    owner = await createUser("owner");
    reader = await createUser("reader");
    outsider = await createUser("outsider");
    tokenSpy = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = token === "owner" ? owner : token === "reader" ? reader : token === "outsider" ? outsider : null;
      return user ? { kind: "user", payload: {}, user, scopes: [] } : null;
    });
    mailboxId = unwrap(await mailboxes.createMailbox(contextFor(owner), { name: `List pages ${suffix}` })).id;
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailbox!.short_id;
    unwrap(
      await access.grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: reader.id },
        permission: "read",
        scope: "assigned",
      }),
    );

    // One bounded transaction; fixed timestamps and explicit order keep cursor fixtures independent of the clock.
    await sql.begin(async (tx) => {
      const [resource] = await tx<{ id: string }[]>`INSERT INTO mail.remote_resources
        (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${mailboxId}::uuid, '{}', '{}', ${"c".repeat(64)}, 'active') RETURNING id`;
      folderShortId = newShortId();
      draftsShortId = newShortId();
      const [folder] = await tx<{ id: string }[]>`INSERT INTO mail.folders
        (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${folderShortId}, ${resource!.id}::uuid, 'inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
      await tx`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${draftsShortId}, ${resource!.id}::uuid, 'drafts', 'Drafts', 'drafts', 'current')`;
      const [identity] = await tx<{ id: string }[]>`INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
        VALUES (${newShortId()}, ${mailboxId}::uuid, 'team@example.test', 'Team') RETURNING id`;
      const [connection] = await tx<{ id: string }[]>`INSERT INTO mail.provider_connections
        (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, status)
        VALUES (${mailboxId}::uuid, 'Test', 'team@example.test', 'team@example.test', 'imap.example.test', 993, 'implicit',
          'smtp.example.test', 587, 'starttls', 'password', 'revoked') RETURNING id`;
      const [binding] = await tx<{ id: string }[]>`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, remote_locator)
        VALUES (${resource!.id}::uuid, ${connection!.id}::uuid, '{}') RETURNING id`;
      savedViewShortId = newShortId();
      await tx`INSERT INTO mail.saved_conversation_views (short_id, mailbox_id, scope, owner_user_id, name, filter, created_by_kind, created_by_id)
        VALUES (${savedViewShortId}, ${mailboxId}::uuid, 'mailbox', NULL, 'Needs action',
          ${{ expression: { type: "work_status", value: "needs_action" }, sort: "newest" }}::jsonb, 'user', ${owner.id}::uuid)`;
      // 52 visible rows plus one hidden row: every owner and assigned-reader scope has a second page.
      for (let i = 0; i < 53; i++) {
        const date = new Date(anchor.getTime() - i * 60_000);
        const shortId = newShortId();
        const msgShortId = newShortId();
        if (i === 0) {
          conversationShortId = shortId;
          messageShortId = msgShortId;
        }
        const [conversation] = await tx<{ id: string }[]>`INSERT INTO mail.conversations
          (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status, summary)
          VALUES (${shortId}, ${mailboxId}::uuid, ${`Page fixture ${i}`}, 'Customer', ${date}, 'needs_action', 'Fixture summary') RETURNING id`;
        const [message] = await tx<{ id: string }[]>`INSERT INTO mail.message_contents
          (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at, size_bytes, content_hash, hydration_status, plain_text)
          VALUES (${msgShortId}, ${mailboxId}::uuid, ${`<${suffix}-${i}@example.test>`}, ${`Page fixture ${i}`}, ${`page fixture ${i}`},
            ${date}, ${date}, 2048, ${i.toString(16).padStart(64, "0")}, 'complete', ${"Fixture detail body. ".repeat(400)}) RETURNING id`;
        await tx`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
          VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 1, 'headers')`;
        const [ref] = await tx<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
          VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 1, ${i + 1}) RETURNING id`;
        await tx`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
          VALUES (${ref!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid, ARRAY[]::text[])`;
        await tx`INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
          VALUES (${message!.id}::uuid, ${mailboxId}::uuid, 0, to_tsvector('simple', 'Page fixture'))`;
        if (i < 52)
          await tx`INSERT INTO mail.conversation_assignees (conversation_id, user_id, assigned_at)
          VALUES (${conversation!.id}::uuid, ${reader.id}::uuid, ${anchor})`;
        const ids = i < 52 ? visibleIds : hiddenIds;
        ids.add(shortId);
        ids.add(msgShortId);
        for (const state of ["draft", "scheduled"]) {
          const draftShortId = newShortId();
          ids.add(draftShortId);
          const [draft] = await tx<{ id: string }[]>`INSERT INTO mail.drafts
            (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id, author_kind, author_id,
              last_editor_kind, last_editor_id, subject, body_markdown, state, updated_at)
            VALUES (${draftShortId}, ${mailboxId}::uuid, ${conversation!.id}::uuid, ${message!.id}::uuid, 'reply', ${identity!.id}::uuid,
              'user', ${owner.id}::uuid, 'user', ${owner.id}::uuid, ${`Draft ${i}`}, 'Draft body', ${state}, ${date}) RETURNING id`;
          if (state === "draft") continue;
          const key = crypto.randomUUID();
          const [command] = await tx<{ id: string }[]>`INSERT INTO mail.commands
            (mailbox_id, kind, actor_kind, actor_id, idempotency_key, request_hash, target, payload, access_subject_kind, access_subject_id, credential_scopes)
            VALUES (${mailboxId}::uuid, 'send', 'user', ${owner.id}::uuid, ${key}, ${"f".repeat(64)}, '{}',
              ${{ scheduledAt: anchor.toISOString() }}::jsonb, 'user', ${owner.id}::uuid, ARRAY[]::text[]) RETURNING id`;
          const submissionShortId = newShortId();
          ids.add(submissionShortId);
          await tx`INSERT INTO mail.outbox_submissions
            (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id,
              state, scheduled_at, requested_at, mime_date, draft_snapshot)
            VALUES (${submissionShortId}, ${mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${identity!.id}::uuid, ${binding!.id}::uuid,
              ${`<${key}@example.test>`}, 'scheduled', ${anchor}, ${date}, ${date},
              ${{ to: [], cc: [], bcc: [], subject: `Scheduled ${i}`, body: "Body", renderedText: "Body" }}::jsonb)`;
        }
      }
    });
  }, 30_000);

  afterAll(async () => {
    tokenSpy?.mockRestore();
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const user of users) await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
  });

  for (const token of ["owner", "reader"])
    test(`${token}: all scope kinds match the full route on pages 1 and 2`, async () => {
      for (const scope of scopes()) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let p = 1; p <= 2; p++) {
          const href = hrefFor(scope, cursor);
          const full = await page("workspace-route", href, token, scope);
          const list = await page("workspace-list", href, token, scope);
          expect(listPart(list), `${scope.name} page ${p}`).toEqual(listPart(full));
          // Exact keys also exclude every selection and workspace-only field.
          expect(Object.keys(list).sort()).toEqual(Object.keys(listPart(list)).sort());
          expect(list.listError).toBeNull();
          expect(list.draftsError).toBeNull();
          expect(list.scheduledError).toBeNull();
          expect(rows(list).length, `${scope.name} page ${p}`).toBe(p === 1 ? 50 : token === "reader" ? 2 : 3);
          for (const row of rows(list)) {
            expect(seen.has(row.id)).toBe(false);
            seen.add(row.id);
            expect(token === "reader" ? visibleIds.has(row.id) : visibleIds.has(row.id) || hiddenIds.has(row.id)).toBe(true);
          }
          if (p === 1) {
            expect(nextCursor(list)).not.toBeNull();
            cursor = nextCursor(list)!;
          } else expect(nextCursor(list)).toBeNull();
        }
        expect(seen.size).toBe(token === "reader" ? 52 : 53);
      }
    }, 30_000);

  test("work guard: list pages never rebuild the workspace or read the selection", async () => {
    const spies = [
      spyOn(messages, "getConversationViewCounts"),
      spyOn(senderIdentities, "listSenderIdentities"),
      spyOn(mailboxes, "getMailbox"),
      spyOn(scheduledSends, "countScheduledSends"),
      spyOn(mailboxes, "getMailboxReceivingAddress"),
      spyOn(mailLive, "cursor"),
      spyOn(localTags, "listLocalTags"),
      spyOn(messages, "listConversationMessageDetails"),
      spyOn(messages, "getMessage"),
      spyOn(access, "requireVisibleConversation"),
    ];
    try {
      for (const scope of scopes()) {
        let cursor: string | undefined;
        for (let p = 1; p <= 2; p++) {
          const resolved = await resolveWorkspaceRequest(new URL(hrefFor(scope, cursor), "https://cloud.test"), mailboxId);
          expect(resolved).not.toBeNull();
          const result = unwrap(
            await loadMailboxListView({
              context: contextFor(owner),
              mailboxId,
              ...resolved!,
              listMode: scope.listMode,
            }),
          );
          expect(rows(result).length).toBe(p === 1 ? 50 : 3);
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
          cursor = nextCursor(result) ?? undefined;
        }
      }
      // Positive controls run the original loader with the SAME spies. A namespace spy
      // that Bun does not intercept therefore fails this test instead of passing silently.
      const resolved = await resolveWorkspaceRequest(new URL(hrefFor(scopes()[0]!), "https://cloud.test"), mailboxId);
      unwrap(await loadMailboxPageData({ context: contextFor(owner), mailboxId, ...resolved! }));
      const messageUrl = new URL(resolved!.requestUrl);
      messageUrl.searchParams.delete("conversation");
      unwrap(await loadMailboxPageData({ context: contextFor(owner), mailboxId, ...resolved!, requestUrl: messageUrl }));
      for (const spy of spies) expect(spy).toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }, 30_000);

  for (const token of ["owner", "reader"])
    test(`${token}: composing a different scope's frame and target list equals the entire target snapshot`, async () => {
      for (const target of switchScopes()) {
        const href = switchHref(target);
        const startScope = switchScopes().find((scope) => switchHref(scope) !== href)!;
        const startHref = switchHref(startScope);
        const expected = await snapshot(href, token);
        for (const selected of [false, true]) {
          const start = new URL(startHref, "https://cloud.test");
          if (selected) start.searchParams.set("conversation", conversationShortId);
          const frame = pickMailWorkspaceFrame(await snapshot(`${start.pathname}${start.search}`, token));
          const list = await page("workspace-list", href, token, target);
          expect(composeMailListSnapshot(frame, list), `${token}: ${target.name}, selected start: ${selected}`).toEqual(expected);
        }
      }
    }, 30_000);

  test("switch work guard: HTTP page 1 never rebuilds the frame or reads selection detail", async () => {
    const spies = [
      spyOn(messages, "getConversationViewCounts"),
      spyOn(senderIdentities, "listSenderIdentities"),
      spyOn(mailboxes, "getMailbox"),
      spyOn(scheduledSends, "countScheduledSends"),
      spyOn(mailboxes, "getMailboxReceivingAddress"),
      spyOn(mailLive, "cursor"),
      spyOn(localTags, "listLocalTags"),
      spyOn(messages, "listConversationMessageDetails"),
      spyOn(messages, "getMessage"),
      spyOn(access, "requireVisibleConversation"),
    ];
    try {
      for (const token of ["owner", "reader"])
        for (const scope of switchScopes()) {
          await page("workspace-list", switchHref(scope), token, scope);
          for (const spy of spies) expect(spy, `${token}: ${scope.name}`).not.toHaveBeenCalled();
        }
      // The same HTTP snapshot routes must reach these exact spies, including selected snapshots.
      for (const scope of switchScopes()) {
        const href = switchHref(scope);
        await snapshot(href, "owner");
        const selected = new URL(href, "https://cloud.test");
        selected.searchParams.set("conversation", conversationShortId);
        selected.searchParams.set("message", messageShortId);
        await snapshot(`${selected.pathname}${selected.search}`, "owner");
      }
      // A message-only selection exercises getMessage, which a conversation selection supersedes.
      await snapshot(`/app/mail/${mailboxShortId}?message=${messageShortId}`, "owner");
      for (const spy of spies) expect(spy).toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }, 30_000);

  test("a folder switch's page 1 stays within the list byte budget", async () => {
    const href = switchHref(switchScopes()[0]!);
    const before = await request("workspace-route", href);
    const after = await request("workspace-list", href);
    expect(before.status).toBe(200);
    expect(after.status).toBe(200);
    const beforeBytes = (await before.arrayBuffer()).byteLength;
    const afterBytes = (await after.arrayBuffer()).byteLength;
    const sizes = `folder switch: workspace-route ${beforeBytes} bytes; workspace-list ${afterBytes} bytes`;
    expect(afterBytes, sizes).toBeLessThanOrEqual(WORKSPACE_LIST_FOLDER_SWITCH_MAX_BYTES);
    expect(WORKSPACE_LIST_FOLDER_SWITCH_MAX_BYTES, sizes).toBeLessThan(beforeBytes);
  });

  test("resolves public list IDs once and never resolves the selection", async () => {
    const spy = spyOn(publicResources, "resolveMailboxPublicId");
    try {
      const href = hrefFor(scopes()[0]!);
      expect((await request("workspace-route", href)).status).toBe(200);
      expect(spy.mock.calls.some(([table]) => table === "conversations")).toBe(true);
      expect(spy.mock.calls.some(([table]) => table === "messages")).toBe(true);
      spy.mockClear();
      expect((await request("workspace-list", href)).status).toBe(200);
      expect(spy.mock.calls.filter(([table]) => table === "folders")).toHaveLength(1);
      expect(spy.mock.calls.some(([table]) => table === "conversations" || table === "messages")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects a foreign mailbox href and hides mailboxes without access", async () => {
    expect((await request("workspace-list", `/app/mail/${newShortId()}`)).status).toBe(400);
    expect((await request("workspace-list", hrefFor(scopes()[0]!), "outsider")).status).toBe(404);
  });

  test("page two with a conversation open stays within the list byte budget", async () => {
    const scope = scopes()[0]!;
    const first = await page("workspace-route", hrefFor(scope), "owner", scope);
    const href = hrefFor(scope, nextCursor(first)!);
    const before = await request("workspace-route", href);
    const after = await request("workspace-list", href);
    expect(before.status).toBe(200);
    expect(after.status).toBe(200);
    const beforeBytes = (await before.arrayBuffer()).byteLength;
    const afterBytes = (await after.arrayBuffer()).byteLength;
    const sizes = `workspace-route page 2: ${beforeBytes} bytes; workspace-list page 2: ${afterBytes} bytes`;
    expect(afterBytes, sizes).toBeLessThan(beforeBytes);
    expect(afterBytes, sizes).toBeLessThanOrEqual(WORKSPACE_LIST_PAGE_TWO_MAX_BYTES);
  });
});
