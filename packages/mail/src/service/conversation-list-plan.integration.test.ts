import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { anchor, planLargeMailbox, seedLargeMailbox } from "../../test/fixtures/large-mailbox";
import type { ConversationView } from "../contracts";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { conversationCandidatesQuery, listConversations } from "./messages";

const suite = suiteFor("database", "nats", "valkey");
const CONVERSATIONS = 2_000;
const PAGE = 51;

const planNode: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    "Node Type": z.string(),
    "Relation Name": z.string().optional(),
    "Actual Rows": z.number(),
    "Actual Loops": z.number(),
    Plans: z.array(planNode).optional(),
  }),
);
type PlanNode = { "Node Type": string; "Relation Name"?: string; "Actual Rows": number; "Actual Loops": number; Plans?: PlanNode[] };
const explainResult = z.array(z.object({ "QUERY PLAN": z.array(z.object({ Plan: planNode })) }));

const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

let userId: string;
let mailboxId: string;
let context: MailRequestContext;

// Production reuses prepared statements behind PgBouncer, so the plan that counts is the generic one.
const genericPlan = (view: ConversationView | null, cursor: { date: string; id: string } | null = null) =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
    const query = conversationCandidatesQuery({
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
    });
    const rows = await tx`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`;
    const [row] = explainResult.parse(rows);
    if (!row?.["QUERY PLAN"][0]) throw new Error("EXPLAIN returned no plan");
    return nodes(row["QUERY PLAN"][0].Plan);
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

  const expectPageRead = (plan: PlanNode[]) => {
    expect(plan.filter((node) => node["Node Type"] === "Sort")).toEqual([]);
    const read = plan.filter((node) => node["Relation Name"] === "conversations");
    expect(read.length).toBeGreaterThan(0);
    // A page reads about a page of a 2,000-conversation mailbox, not all of it.
    for (const node of read) expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThan(PAGE * 4);
  };

  test("the unfiltered list reads one page in index order, whatever the mailbox size", async () => {
    expectPageRead(await genericPlan(null));
  });

  test("recently active reads one page of its own index", async () => {
    expectPageRead(await genericPlan("recently_active"));
  });

  test("a later page starts at its cursor instead of reading the pages before it", async () => {
    const first = await listConversations({ context, mailboxId, limit: 50 });
    if (!first.ok) throw new Error(first.error.message);
    const last = first.data.items.at(-1);
    if (!last) throw new Error("The fixture has no conversations");
    expectPageRead(await genericPlan(null, { date: last.latestMessageAt, id: last.id }));
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
