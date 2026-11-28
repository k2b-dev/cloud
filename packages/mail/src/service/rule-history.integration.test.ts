import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { accounts } from "@k2b/cloud/services";
import { Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor, testFor } from "../../../../scripts/fixtures/test-infra";
import historyRoutes from "../api/automation-log";
import type { MailApiContext } from "../api/public-resource-boundary";
import { automationLogItemSchema } from "../contracts";
import { loadMailCodeHistory } from "../frontend/mail-code-history-data";
import { loadMailSidebarData } from "../frontend/mail-sidebar-data";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { getAutomationLogItem, listAutomationLog } from "./automation-log";
import { loadMailboxCodePageData } from "./workspace";

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

  test("the history step of the Code page reads one day, its entry and the runs in a fixed number of statements", async () => {
    const meter = await meterSql();
    try {
      const code = `/app/mail/${mailboxShortId}/code`;
      let day: Awaited<ReturnType<typeof loadMailCodeHistory>> | undefined;
      const byDay = await meter.during(async () => {
        day = await loadMailCodeHistory(context, mailboxId, new URL(`https://cloud.test${code}?history=1&day=2026-11-01`), code);
      });
      expect(day).toMatchObject({ ok: true, data: { day: "2026-11-01", items: [{ id: item.id }], entry: null, run: null } });
      // a link to one entry without a day opens that entry's day
      let entry: Awaited<ReturnType<typeof loadMailCodeHistory>> | undefined;
      const byEntry = await meter.during(async () => {
        entry = await loadMailCodeHistory(context, mailboxId, new URL(`https://cloud.test${code}?history=1&entry=${item.id}`), code);
      });
      expect(entry).toMatchObject({ ok: true, data: { day: "2026-11-01", entry: item.id } });
      // one access read for the step; the log page with its counts, the runs; the entry adds its own read
      expect({ byDay: byDay.length, byEntry: byEntry.length }).toEqual({ byDay: 10, byEntry: 12 });
    } finally {
      await meter.close();
    }
  });

  // The counts come from the workspace's cached snapshot (Valkey); without it every load would count the mailbox.
  testFor("valkey")(
    "the whole Code page with its history step reads in a fixed number of statements; the next step reuses the counts",
    async () => {
      const meter = await meterSql();
      try {
        const code = `/app/mail/${mailboxShortId}/code`;
        // Mail's part of the page: the mailbox with its counts, the sidebar, and the history step the address asks for
        const page = async (query: string) => {
          const [mailbox, , history] = await Promise.all([
            loadMailboxCodePageData(context, mailboxId),
            loadMailSidebarData(context),
            loadMailCodeHistory(context, mailboxId, new URL(`https://cloud.test${code}?history=1&${query}`), code),
          ]);
          expect(mailbox.ok && history.ok).toBe(true);
        };
        const first = await meter.during(() => page("day=2026-11-01"));
        const next = await meter.during(() => page(`day=2026-11-01&entry=${item.id}`));
        // the first load counts the mailbox once (its count transaction); the next step reads the counts from the cache
        expect({ first: first.length, next: next.length }).toEqual({ first: 55, next: 48 });
      } finally {
        await meter.close();
      }
    },
  );
});
