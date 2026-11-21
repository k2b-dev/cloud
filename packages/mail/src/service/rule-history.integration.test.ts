import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { accounts } from "@k2b/cloud/services";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import historyRoutes from "../api/automation-log";
import type { MailApiContext } from "../api/public-resource-boundary";
import { automationLogItemSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { getAutomationLogItem, listAutomationLog } from "./automation-log";

const suite = suiteFor("database");
suite("Retired Mail rule history", () => {
  let mailboxId: string;
  let mailboxShortId: string;
  let context: MailRequestContext;
  const item = automationLogItemSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    at: "2026-11-01T12:00:00.000Z",
    conversation: { id: "Convo1", subject: "Preserved history", from: { name: null, email: "sender@example.test" }, href: "/app/mail" },
    by: {
      kind: "rule",
      workflowId: "22222222-2222-4222-8222-222222222222",
      name: "Retired rule",
      position: 1,
      version: 1,
      ai: false,
      href: "/app/mail",
    },
    outcome: "effects",
    effects: [{ kind: "comment" }],
    reasons: [],
    undo: { state: "available", reason: null, by: null, at: null },
  });
  const chain = [{ kind: "result", effects: item.effects, unchanged: ["Recorded before the cut"] }];
  beforeAll(async () => {
    await migrate();
    const [mailbox] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.mailboxes(short_id,name)
      VALUES(${newShortId()},'Retired rule history') RETURNING id,short_id`;
    if (!mailbox) throw new Error("Missing history mailbox");
    mailboxId = mailbox.id;
    mailboxShortId = mailbox.short_id;
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
      VALUES(${`rule-history-${crypto.randomUUID()}`},'local','user',false) RETURNING id`;
    const user = person && (await accounts.users.get({ id: person.id }));
    if (!user) throw new Error("Missing history reader");
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission)
      VALUES(${user.id}::uuid,'read') RETURNING id`;
    if (!grant) throw new Error("Missing history read grant");
    await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${mailboxId}::uuid,${grant.id}::uuid)`;
    context = { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
    await sql`INSERT INTO mail.automation_log(id,mailbox_id,item,chain,created_at)
      VALUES(${item.id}::uuid,${mailboxId}::uuid,${item}::jsonb,${chain}::jsonb,${item.at}::timestamptz)`;
  });

  test("frozen entries and their decision chains remain readable, without executable undo state", async () => {
    const page = await listAutomationLog(context, mailboxId, { day: "2026-11-01" });
    expect(page).toMatchObject({ ok: true, data: { items: [{ id: item.id, by: { name: "Retired rule" }, undo: { state: "none" } }] } });
    const detail = await getAutomationLogItem(context, mailboxId, item.id);
    expect(detail).toMatchObject({ ok: true, data: { effects: item.effects, chain, undo: { state: "none" } } });
    const [stored] = await sql<{ item: unknown; chain: unknown }[]>`SELECT item,chain FROM mail.automation_log WHERE id=${item.id}::uuid`;
    expect(stored).toEqual({ item, chain });
  });

  test("historical read routes have no Undo or Redo mutation even for an existing entry", async () => {
    const router = new Hono<MailApiContext>()
      .use("*", async (c, next) => {
        c.set("actor", context.actor);
        c.set("accessSubject", context.accessSubject);
        await next();
      })
      .route("/", historyRoutes);
    for (const action of ["undo", "redo"]) {
      const response = await router.request(`/mailboxes/${mailboxShortId}/automation-log/${item.id}/${action}`, { method: "POST" });
      expect(response.status, `Retired ${action} must have no handler`).toBe(404);
    }
  });
});
