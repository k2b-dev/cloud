import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { anchor, planLargeMailbox, seedLargeMailbox } from "../../test/fixtures/large-mailbox";
import type { ConversationView } from "../contracts";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { conversationCandidatesQuery, listConversations } from "./messages";

const suite = suiteFor("database", "nats", "valkey");
const CONVERSATIONS = 2_000;
const PAGE = 51;

let userId: string;
let mailboxId: string;
let context: MailRequestContext;

// Production reuses prepared statements behind PgBouncer, so the plan that counts is the generic one. An ordinary
// EXPLAIN would plan with the bound values, so this executes the statement and reads what the transaction examined.
const conversationsExamined = (view: ConversationView | null, cursor: { date: string; id: string } | null = null) =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
    // The view also holds counts this connection has not flushed yet, so only the difference belongs to the query.
    const examined = async () => {
      const [stats] = await tx<{ examined: number }[]>`
        SELECT (seq_tup_read + idx_tup_fetch)::int AS examined
        FROM pg_stat_xact_user_tables
        WHERE schemaname = 'mail' AND relname = 'conversations'
      `;
      return stats?.examined ?? 0;
    };
    const before = await examined();
    const page = await tx`${conversationCandidatesQuery({
      mailboxId,
      visibility: { scope: "mailbox", permission: "admin" },
      currentUserId: userId,
      folderId: null,
      excludedFolderIds: [],
      status: null,
      view,
      unread: null,
      lapsedAssignees: [],
      aggregatedScope: null,
      cursor,
      limit: PAGE,
    })}`;
    expect(page).toHaveLength(PAGE);
    return (await examined()) - before;
  });

suite("conversation list plan", () => {
  beforeAll(async () => {
    const uid = `list-plan-${crypto.randomUUID()}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'List reader', true)
      RETURNING id
    `;
    if (!user) throw new Error("User was not created");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid,
          provider: "local",
          profile: "user",
          displayName: "List reader",
          givenname: "List",
          sn: "Reader",
          mail: "list@example.test",
          avatarHash: null,
          roles: ["admin", "user"],
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
    const created = await createMailbox(context, { name: "List plan", description: "Disposable list plan fixture" });
    if (!created.ok) throw new Error(created.error.message);
    mailboxId = created.data.id;
    const plan = planLargeMailbox({ seed: 20261101, anchor, messages: CONVERSATIONS + 200, conversations: CONVERSATIONS, folders: 6 });
    await seedLargeMailbox(sql, plan, { mailboxId, userIds: [userId] });
    await sql`ANALYZE mail.conversations`;
    await sql`ANALYZE mail.conversation_messages`;
    await sql`ANALYZE mail.message_placements`;
  }, 120_000);

  afterAll(async () => {
    const access = mailboxId
      ? await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`
      : [];
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (access.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(access.map((row) => row.access_id))}`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  }, 30_000);

  // A page examines about a page of a 2,000-conversation mailbox, not all of it.
  const ABOUT_ONE_PAGE = PAGE * 4;

  test("the unfiltered list examines one page, whatever the mailbox size", async () => {
    expect(await conversationsExamined(null)).toBeLessThan(ABOUT_ONE_PAGE);
  });

  test("recently active examines one page of its own index", async () => {
    expect(await conversationsExamined("recently_active")).toBeLessThan(ABOUT_ONE_PAGE);
  });

  test("a later page starts at its cursor instead of examining the pages before it", async () => {
    let cursor: { date: string; id: string } | null = null;
    let token: string | undefined;
    // Far enough in that walking the earlier pages would exceed the bound.
    for (let page = 0; page < 6; page++) {
      const result = await listConversations({ context, mailboxId, limit: 50, cursor: token });
      if (!result.ok) throw new Error(result.error.message);
      const last = result.data.items.at(-1);
      if (!last || !result.data.nextCursor) throw new Error("The fixture has too few conversations");
      cursor = { date: last.latestMessageAt, id: last.id };
      token = result.data.nextCursor;
    }
    expect(await conversationsExamined(null, cursor)).toBeLessThan(ABOUT_ONE_PAGE);
  });

  test("consecutive pages list every conversation once and enrich each row", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await listConversations({ context, mailboxId, limit: 50, cursor });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.data.items).toHaveLength(50);
      for (const item of result.data.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        expect(item.messageCount).toBeGreaterThan(0);
      }
      cursor = result.data.nextCursor ?? undefined;
      expect(cursor).toBeDefined();
    }
  });
});
