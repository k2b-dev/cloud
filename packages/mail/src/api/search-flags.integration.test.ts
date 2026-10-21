import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailSearchExpression } from "../contracts";
import { projectMailboxPageData } from "../frontend/ssr-public-boundary";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { MAIL_SEARCH_MATCHES_NOTHING } from "../search-state";
import type { MailRequestContext } from "../service/auth";
import { createMailbox } from "../service/mailboxes";
import { searchMessages } from "../service/search";
import { loadMailboxPageData, resolveWorkspaceRequest } from "../service/workspace";
import app from ".";

const suite = suiteFor("database", "nats", "valkey");
type Resource = { id: string; shortId: string };
const and = (...expressions: MailSearchExpression[]): MailSearchExpression => ({ type: "and", expressions });
const subject = (query: string): MailSearchExpression => ({ type: "text", field: "subject", query, match: "exact" });

suite("Mail flags belong to an included placement of the same message", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let owner: User;
  let context: MailRequestContext;
  let verifyAccessToken: { mockRestore: () => void } | undefined;
  const mailboxes: Resource[] = [];
  const folders = new Map<string, Resource>();
  const conversations = new Map<string, Resource>();
  let messageIndex = 0;
  const mailbox = () => mailboxes[0]!;
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    app.request(`/mailboxes/${mailbox().shortId}${path}`, {
      method,
      headers: { authorization: "Bearer flag-owner", "x-forwarded-for": uniqueCallerAddress(), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const folderExpression = (key: string, internal = false): MailSearchExpression => ({
    type: "folder_id",
    folderId: internal ? folders.get(key)!.id : folders.get(key)!.shortId,
  });
  const flagExpression = (type: "unread" | "flagged", key?: string, internal = false): MailSearchExpression => ({
    type,
    ...(key ? { folderId: internal ? folders.get(key)!.id : folders.get(key)!.shortId } : {}),
  });
  const searchHref = (expression: MailSearchExpression) =>
    `/app/mail/${mailbox().shortId}?${new URLSearchParams({ search: JSON.stringify({ expression, sort: "newest" }) })}`;
  const search = async (expression: MailSearchExpression) => {
    const response = await request("/search", { expression, sort: "newest" });
    expect(response.status).toBe(200);
    return (await response.json()) as { items: Array<{ conversationId: string | null; unread: boolean; flagged: boolean }> };
  };
  const addMailbox = async () => {
    const result = await createMailbox(context, { name: `Flags ${suffix} ${mailboxes.length}` });
    if (!result.ok) throw new Error(result.error.message);
    const [row] = await sql<{ id: string; short_id: string }[]>`SELECT id, short_id FROM mail.mailboxes WHERE id = ${result.data.id}::uuid`;
    const resource = { id: row!.id, shortId: row!.short_id };
    mailboxes.push(resource);
    const [remote] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${resource.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 'active') RETURNING id
    `;
    return remote!.id;
  };
  const addFolder = async (remote: string, key: string, role = "other") => {
    const shortId = newShortId();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${shortId}, ${remote}::uuid, ${key}, ${key}, ${role}, 'current') RETURNING id
    `;
    folders.set(key, { id: row!.id, shortId });
  };
  const addMessage = async (
    conversationKey: string,
    title: string,
    placements: Array<{ folder: string; flags: string[]; deleted?: boolean }>,
  ) => {
    messageIndex += 1;
    const at = new Date(Date.parse("2026-10-10T12:00:00Z") - messageIndex * 60_000);
    if (!conversations.has(conversationKey)) {
      const shortId = newShortId();
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
        VALUES (${shortId}, ${mailbox().id}::uuid, ${title}, 'Synthetic sender', ${at}) RETURNING id
      `;
      conversations.set(conversationKey, { id: row!.id, shortId });
    }
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at,
        size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailbox().id}::uuid, ${`<flags-${suffix}-${messageIndex}@example.test>`}, ${title}, ${title.toLowerCase()},
        ${at}, ${at}, 1024, ${String(messageIndex).padStart(64, "0")}, 'complete', 'Synthetic flag fixture') RETURNING id
    `;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversations.get(conversationKey)!.id}::uuid, ${message!.id}::uuid, ${messageIndex}, 'headers')`;
    for (const placement of placements) {
      const folderId = folders.get(placement.folder)!.id;
      const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${messageIndex}) RETURNING id`;
      await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords, deleted_at, updated_at)
        VALUES (${ref!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid, ${sql.array(placement.flags, "TEXT")}, ARRAY[]::text[],
          ${placement.deleted ? at : null}::timestamptz, ${new Date(at.getTime() + placements.indexOf(placement) * 1000)})`;
    }
  };

  beforeAll(async () => {
    await migrate();
    const [row] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-flags-${suffix}`}, 'local', 'user', 'Flag owner', false) RETURNING id, uid`;
    owner = {
      id: row!.id,
      uid: row!.uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Flag",
      sn: "Owner",
      displayName: "Flag owner",
      mail: "flags@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    context = { actor: { kind: "user", user: owner }, accessSubject: { type: "user", userId: owner.id }, requestId: null };
    verifyAccessToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) =>
      token === "flag-owner" ? { kind: "user", payload: {}, user: owner, scopes: [] } : null,
    );
    const remote = await addMailbox();
    for (const key of ["A", "B", "Stale"]) await addFolder(remote, key);
    await addFolder(remote, "Trash", "trash");
    await addFolder(remote, "Junk", "junk");
    await addFolder(await addMailbox(), "Foreign");
    const read = ["\\Seen"];
    const flagged = ["\\Flagged"];
    await addMessage("split", "alpha", [
      { folder: "B", flags: flagged },
      { folder: "A", flags: read },
    ]);
    await addMessage("pair", "pair text", [{ folder: "A", flags: read }]);
    await addMessage("pair", "pair flagged", [{ folder: "A", flags: flagged }]);
    await addMessage("deleted", "deleted", [
      { folder: "A", flags: read },
      { folder: "B", flags: flagged, deleted: true },
    ]);
    await addMessage("excluded", "excluded", [
      { folder: "A", flags: read },
      { folder: "Trash", flags: flagged },
      { folder: "Junk", flags: flagged },
    ]);
  }, 60_000);
  afterAll(async () => {
    verifyAccessToken?.mockRestore();
    for (const resource of mailboxes) await sql`DELETE FROM mail.mailboxes WHERE id = ${resource.id}::uuid`;
    if (owner) await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("scoped flags cannot borrow another folder's state or an OR branch's scope", async () => {
    for (const type of ["unread", "flagged"] as const) {
      expect((await search(and(subject("alpha"), flagExpression(type, "A")))).items).toEqual([]);
      expect((await search(and(subject("alpha"), flagExpression(type, "B")))).items.map((x) => x.conversationId)).toEqual([
        conversations.get("split")!.shortId,
      ]);
      expect((await search(and(subject("alpha"), folderExpression("A"), flagExpression(type)))).items).toHaveLength(1);
      expect(
        (
          await search(
            and(subject("alpha"), {
              type: "or",
              expressions: [and(folderExpression("A"), flagExpression(type, "A")), and(folderExpression("B"), subject("invoice"))],
            }),
          )
        ).items,
      ).toEqual([]);
      expect(
        (await search(and(subject("alpha"), folderExpression("A"), { type: "not", expression: flagExpression(type, "A") }))).items,
      ).toHaveLength(1);
    }
    expect((await search(and(subject("alpha"), folderExpression("A"), folderExpression("B")))).items).toHaveLength(1);
  });

  test("deleted and explicitly excluded placements never witness flags; ordinary searches still include Trash and Junk", async () => {
    for (const type of ["unread", "flagged"] as const) {
      expect((await search(and(subject("deleted"), flagExpression(type)))).items).toEqual([]);
      expect((await search(and(subject("excluded"), flagExpression(type, "Trash")))).items).toHaveLength(1);
      expect((await search(and(subject("excluded"), flagExpression(type, "Junk")))).items).toHaveLength(1);
      for (const key of [undefined, "Trash", "Junk"]) {
        const result = await searchMessages({
          context,
          mailboxId: mailbox().id,
          request: { expression: and(subject("excluded"), flagExpression(type, key, true)), sort: "newest", limit: 20 },
          excludedFolderIds: [folders.get("Trash")!.id, folders.get("Junk")!.id],
        });
        if (!result.ok) throw new Error(result.error.message);
        expect(result.data.items).toEqual([]);
      }
    }
  });

  test("message results keep the newest included placement's flag independently of the matching placement", async () => {
    // B is older and flagged; A is newer and unflagged. A flag predicate may
    // match B without changing the placement whose state an old search returns.
    const cases: Array<{ expression: MailSearchExpression; flagged: boolean }> = [
      { expression: subject("alpha"), flagged: false },
      { expression: and(subject("alpha"), folderExpression("B", true)), flagged: false },
      { expression: and(subject("alpha"), flagExpression("flagged", undefined, true)), flagged: false },
      { expression: and(subject("alpha"), flagExpression("flagged", "B", true)), flagged: false },
    ];
    for (const entry of cases) {
      const result = await searchMessages({
        context,
        mailboxId: mailbox().id,
        groupByConversation: false,
        request: { expression: entry.expression, sort: "newest", limit: 20 },
      });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0]!.flagged).toBe(entry.flagged);
    }
    const result = await searchMessages({
      context,
      mailboxId: mailbox().id,
      groupByConversation: false,
      request: { expression: subject("alpha"), sort: "newest", limit: 20 },
      excludedFolderIds: [folders.get("B")!.id],
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]!.flagged).toBe(false);
    const onlyFlaggedPlacement = await searchMessages({
      context,
      mailboxId: mailbox().id,
      groupByConversation: false,
      request: { expression: subject("alpha"), sort: "newest", limit: 20 },
      excludedFolderIds: [folders.get("A")!.id],
    });
    if (!onlyFlaggedPlacement.ok) throw new Error(onlyFlaggedPlacement.error.message);
    expect(onlyFlaggedPlacement.data.items).toHaveLength(1);
    expect(onlyFlaggedPlacement.data.items[0]!.flagged).toBe(true);
  });

  test("AND applies to one message before grouping and pagination in either list mode", async () => {
    for (const groupByConversation of [true, false]) {
      const noMatch = await searchMessages({
        context,
        mailboxId: mailbox().id,
        groupByConversation,
        request: { expression: and(subject("pair text"), flagExpression("flagged", "A", true)), sort: "newest", limit: 1 },
      });
      if (!noMatch.ok) throw new Error(noMatch.error.message);
      expect(noMatch.data.items).toEqual([]);
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await searchMessages({
          context,
          mailboxId: mailbox().id,
          groupByConversation,
          request: { expression: flagExpression("flagged"), sort: "newest", limit: 1, cursor },
        });
        if (!result.ok) throw new Error(result.error.message);
        ids.push(...result.data.items.map((item) => item.conversationId!));
        cursor = result.data.nextCursor ?? undefined;
        expect(ids.length).toBeLessThanOrEqual(3);
      } while (cursor);
      expect(ids.sort()).toEqual(["split", "pair", "excluded"].map((key) => conversations.get(key)!.id).sort());
    }
  });

  test("public scope survives saved views, SSR, workspace navigation, and stale-reference recovery", async () => {
    const expression = and(subject("alpha"), flagExpression("unread", "B"));
    const href = searchHref(expression);
    const response = await request(`/workspace-route?${new URLSearchParams({ href })}`);
    expect(response.status).toBe(200);
    const route = (await response.json()) as { listItems: Array<{ conversationId: string }>; search: { expression: MailSearchExpression } };
    expect(route.listItems.map((x) => x.conversationId)).toEqual([conversations.get("split")!.shortId]);
    expect(route.search.expression).toEqual(expression);
    const resolved = await resolveWorkspaceRequest(new URL(href, "https://cloud.test"), mailbox().id);
    expect(resolved).not.toBeNull();
    const initial = await loadMailboxPageData({ context, mailboxId: mailbox().id, ...resolved! });
    if (!initial.ok) throw new Error(initial.error.message);
    expect((await projectMailboxPageData(initial.data)).listItems.map((x) => x.conversationId)).toEqual(
      route.listItems.map((x) => x.conversationId),
    );
    const stale = { type: "not" as const, expression: flagExpression("flagged", "Stale") };
    const created = await request("/saved-views", {
      name: "Scoped flags",
      scope: "private",
      filter: { expression: stale, sort: "newest" },
    });
    expect(created.status).toBe(200);
    const view = (await created.json()) as { id: string; filter: { expression: MailSearchExpression } };
    expect(view.filter.expression).toEqual(stale);
    const saved = await resolveWorkspaceRequest(
      new URL(`/app/mail/${mailbox().shortId}?savedView=${view.id}`, "https://cloud.test"),
      mailbox().id,
    );
    const savedPage = await loadMailboxPageData({ context, mailboxId: mailbox().id, ...saved! });
    if (!savedPage.ok) throw new Error(savedPage.error.message);
    expect((await projectMailboxPageData(savedPage.data)).savedViews.find((x) => x.id === view.id)?.filter.expression).toEqual(stale);
    await sql`DELETE FROM mail.folders WHERE id = ${folders.get("Stale")!.id}::uuid`;
    const listed = await request("/saved-views");
    expect(listed.status).toBe(200);
    const recovered = (await listed.json()) as Array<{ id: string; filter: { expression: MailSearchExpression } }>;
    expect(recovered.find((x) => x.id === view.id)?.filter.expression).toEqual({ type: "not", expression: MAIL_SEARCH_MATCHES_NOTHING });
    const staleRoute = await resolveWorkspaceRequest(new URL(searchHref(stale), "https://cloud.test"), mailbox().id);
    expect(staleRoute?.search.expression).toEqual({ type: "not", expression: MAIL_SEARCH_MATCHES_NOTHING });
  });

  test("transport rejects internal and foreign scope instead of silently widening it", async () => {
    expect((await request("/search", { expression: flagExpression("unread", "A", true) })).status).toBe(400);
    expect((await request("/search", { expression: flagExpression("flagged", "Foreign") })).status).toBe(404);
    const foreign = await request("/saved-views", {
      name: "Foreign",
      scope: "private",
      filter: { expression: flagExpression("unread", "Foreign"), sort: "newest" },
    });
    expect(foreign.status).toBe(404);
    const attachments = await search({ type: "size", field: "attachment", operator: "at_least", bytes: 0 });
    expect(attachments.items).toEqual([]);
  });
});
