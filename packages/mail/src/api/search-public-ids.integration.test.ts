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
import type { MailListError } from "../service/workspace";
import { loadMailboxPageData, resolveWorkspaceRequest } from "../service/workspace";
import app from ".";

// The production API stack includes the Valkey-backed rate limit, so these requests need all three services.
const suite = suiteFor("database", "nats", "valkey");

const userFor = (row: { id: string; uid: string }): User => ({
  id: row.id,
  uid: row.uid,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: row.uid,
  sn: "Test",
  displayName: row.uid,
  mail: `${row.uid}@example.test`,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});

type WorkspaceRoute = {
  listItems: Array<{ id: string; conversationId: string | null }>;
  listError: MailListError | null;
  savedViews: Array<{ id: string; filter: { expression: MailSearchExpression } }>;
};

suite("Mail search by public folder and tag IDs", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let owner: User;
  let context: MailRequestContext;
  let verifyAccessToken: { mockRestore: () => void } | undefined;
  let mailboxId = "";
  let mailboxShortId = "";
  let folderShortId = "";
  let conversationShortId = "";
  let tagShortId = "";

  const request = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`/mailboxes/${mailboxShortId}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: "Bearer owner", "x-forwarded-for": uniqueCallerAddress(), "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const workspaceRoute = async (href: string): Promise<WorkspaceRoute> => {
    const response = await request(`/workspace-route?${new URLSearchParams({ href })}`);
    expect(response.status).toBe(200);
    return (await response.json()) as WorkspaceRoute;
  };
  const searchHref = (expression: MailSearchExpression) =>
    `/app/mail/${mailboxShortId}?${new URLSearchParams({ search: JSON.stringify({ expression, sort: "newest" }) })}`;
  const tagged = (): MailSearchExpression => ({ type: "local_tag_id", tagId: tagShortId });
  const inFolder = (): MailSearchExpression => ({ type: "folder_id", folderId: folderShortId });

  beforeAll(async () => {
    await migrate();
    const [row] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-search-ids-${suffix}`}, 'local', 'user', 'Search owner', false)
      RETURNING id, uid
    `;
    owner = userFor(row!);
    context = { actor: { kind: "user", user: owner }, accessSubject: { type: "user", userId: owner.id }, requestId: null };
    verifyAccessToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) =>
      token === "owner" ? { kind: "user", payload: {}, user: owner, scopes: [] } : null,
    );

    const mailbox = await createMailbox(context, { name: `Search IDs ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailboxRow!.short_id;

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"c".repeat(64)}, 'active')
      RETURNING id
    `;
    folderShortId = newShortId();
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${folderShortId}, ${resource!.id}::uuid, 'inbox', 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    const internalDate = new Date(Date.now() - 60_000);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at, size_bytes,
        content_hash, hydration_status, plain_text
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, ${`<search-ids-${suffix}@example.test>`}, 'Quarterly order', 'quarterly order',
        ${internalDate}, ${internalDate}, 2048, ${"d".repeat(64)}, 'complete', 'Order confirmation for the harbor office'
      )
      RETURNING id
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 1, 1)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${remoteRef!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid, ARRAY['\\Seen']::text[], ARRAY[]::text[])
    `;
    conversationShortId = newShortId();
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${conversationShortId}, ${mailboxId}::uuid, 'Quarterly order', 'Harbor Supplies', ${internalDate})
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 1, 'headers')
    `;

    const created = await request("/local-tags", { method: "POST", body: { name: "Invoices", color: "#0f766e" } });
    expect(created.status).toBe(200);
    tagShortId = ((await created.json()) as { id: string }).id;
    const assigned = await request(`/conversations/${conversationShortId}/local-tags`, {
      method: "PUT",
      body: { tagIds: [tagShortId], expectedRevision: 1 },
    });
    expect(assigned.status).toBe(200);
  });

  afterAll(async () => {
    verifyAccessToken?.mockRestore();
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (owner) await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("the search API finds a tagged conversation by public tag and folder IDs", async () => {
    for (const expression of [tagged(), inFolder(), { type: "and" as const, expressions: [tagged(), inFolder()] }]) {
      const response = await request("/search", { method: "POST", body: { expression, sort: "newest" } });
      expect(response.status, JSON.stringify(expression)).toBe(200);
      const page = (await response.json()) as { items: Array<{ conversationId: string | null }> };
      expect(page.items.map((item) => item.conversationId)).toEqual([conversationShortId]);
    }
  });

  test("a filtered workspace search finds the tagged conversation on navigation and on the first render", async () => {
    const nestedTag: MailSearchExpression = { type: "not", expression: { type: "not", expression: tagged() } };
    for (const expression of [tagged(), inFolder(), nestedTag]) {
      const route = await workspaceRoute(searchHref(expression));
      expect(route.listError, JSON.stringify(expression)).toBeNull();
      expect(route.listItems.map((item) => item.conversationId)).toEqual([conversationShortId]);

      const resolved = await resolveWorkspaceRequest(new URL(searchHref(expression), "https://cloud.test"), mailboxId);
      expect(resolved).not.toBeNull();
      const data = await loadMailboxPageData({ context, mailboxId, ...resolved! });
      expect(data.ok && data.data.listError).toBeNull();
      if (!data.ok) return;
      const projected = await projectMailboxPageData(data.data);
      expect(projected.listItems.map((item) => item.conversationId)).toEqual([conversationShortId]);
    }
  });

  test("a saved view with a tag condition lists the tagged conversation", async () => {
    const created = await request("/saved-views", {
      method: "POST",
      body: { name: "Tagged invoices", scope: "private", filter: { expression: tagged(), sort: "newest" } },
    });
    expect(created.status).toBe(200);
    const view = (await created.json()) as { id: string; filter: { expression: MailSearchExpression } };
    expect(view.filter.expression).toEqual(tagged());

    const listed = await request("/saved-views");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as Array<{ id: string }>).map((item) => item.id)).toContain(view.id);

    const conversations = await request(`/saved-views/${view.id}/conversations`);
    expect(conversations.status).toBe(200);
    expect(((await conversations.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([conversationShortId]);

    const route = await workspaceRoute(`/app/mail/${mailboxShortId}?savedView=${view.id}`);
    expect(route.listError).toBeNull();
    expect(route.listItems.map((item) => item.conversationId)).toEqual([conversationShortId]);
    expect(route.savedViews.find((item) => item.id === view.id)?.filter.expression).toEqual(tagged());
  });

  test("a condition on a deleted tag matches nothing instead of failing", async () => {
    const created = await request("/local-tags", { method: "POST", body: { name: "Old projects", color: "#6b7280" } });
    const oldTag = (await created.json()) as { id: string; revision: number };
    const oldTagged: MailSearchExpression = { type: "local_tag_id", tagId: oldTag.id };
    const saved = await request("/saved-views", {
      method: "POST",
      body: { name: "Old projects", scope: "private", filter: { expression: oldTagged, sort: "newest" } },
    });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as { id: string };
    const deleted = await request(`/local-tags/${oldTag.id}`, { method: "DELETE", body: { expectedRevision: oldTag.revision } });
    expect(deleted.status).toBe(200);

    const listed = await request("/saved-views");
    expect(listed.status).toBe(200);
    const views = (await listed.json()) as Array<{ id: string; filter: { expression: MailSearchExpression } }>;
    expect(views.find((item) => item.id === view.id)?.filter.expression).toEqual(MAIL_SEARCH_MATCHES_NOTHING);

    const savedRoute = await workspaceRoute(`/app/mail/${mailboxShortId}?savedView=${view.id}`);
    expect(savedRoute.listError).toBeNull();
    expect(savedRoute.listItems).toEqual([]);

    const staleLink = await workspaceRoute(searchHref(oldTagged));
    expect(staleLink.listError).toBeNull();
    expect(staleLink.listItems).toEqual([]);
    const withoutStaleTag = await workspaceRoute(searchHref({ type: "not", expression: oldTagged }));
    expect(withoutStaleTag.listItems.map((item) => item.conversationId)).toEqual([conversationShortId]);
  });

  test("the workspace route titles the list in the request locale", async () => {
    const titleFor = async (href: string, locale: string) => {
      const response = await app.request(`/mailboxes/${mailboxShortId}/workspace-route?${new URLSearchParams({ href })}`, {
        headers: { authorization: "Bearer owner", "x-forwarded-for": uniqueCallerAddress(), "x-cloud-locale": locale },
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { listTitle: string }).listTitle;
    };
    const mailboxHref = `/app/mail/${mailboxShortId}`;

    expect(await titleFor(searchHref(tagged()), "en")).toBe("Filtered search");
    expect(await titleFor(searchHref(tagged()), "de")).toBe("Gefilterte Suche");
    expect(await titleFor(`${mailboxHref}?q=order`, "de")).toBe("Ergebnisse für „order“");
    expect(await titleFor(`${mailboxHref}?view=needs_action`, "de")).toBe("Handlungsbedarf");
    expect(await titleFor(`${mailboxHref}?scheduled=1`, "de")).toBe("Geplant");
    expect(await titleFor(`${mailboxHref}?search=${encodeURIComponent("{not json")}`, "de")).toBe("Suche");
    expect(await titleFor(mailboxHref, "de")).toBe("Alle E-Mails");
  });

  test("a failing list reports a stable code instead of raw service text", async () => {
    const invalid = await workspaceRoute(`/app/mail/${mailboxShortId}?search=${encodeURIComponent("{not json")}`);
    expect(invalid.listError).toBe("invalid_search");
    expect(invalid.listItems).toEqual([]);
  });
});
