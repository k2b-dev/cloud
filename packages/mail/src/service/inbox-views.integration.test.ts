import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { accounts, coreSettings } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import viewRoutes from "../api/mailbox-preferences";
import type { MailApiContext } from "../api/public-resource-boundary";
import { projectMailboxPageData } from "../frontend/ssr-public-boundary";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { getMailboxDoneTodayCounts } from "./done-today";
import { getMailboxViewPreference, setMailboxPreference, setMailboxViewPreference } from "./mailbox-preferences";
import { createMailbox, deleteMailbox } from "./mailboxes";
import { loadMailboxPageData, resolveWorkspaceRequest } from "./workspace";

const suite = suiteFor("database", "nats", "valkey");
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
});
const defaults = { large: "auto", phone: "compact" } as const;

suite("personal inbox views and today's completed conversations", () => {
  const people: User[] = [];
  const groups: string[] = [];
  const mailboxes: { id: string; shortId: string }[] = [];
  let owner: MailRequestContext;
  let reader: MailRequestContext;
  let assigned: MailRequestContext;
  let box: { id: string; shortId: string };
  let other: { id: string; shortId: string };
  let settingsSpy: ReturnType<typeof spyOn<typeof coreSettings, "get">>;
  const makeUser = async (): Promise<User> => {
    const uid = `inbox-${crypto.randomUUID()}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${uid}, 'local', 'user', ${uid}) RETURNING id`;
    const user = await accounts.users.get({ id: row!.id });
    if (!user) throw new Error("Missing fixture user");
    people.push(user);
    return user;
  };
  const makeMailbox = async () => {
    const created = unwrap(await createMailbox(owner, { name: `Inbox ${newShortId()}` }));
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${created.id}::uuid`;
    const mailbox = { id: created.id, shortId: row!.short_id };
    mailboxes.push(mailbox);
    return mailbox;
  };
  const makeConversation = async (mailbox = box) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations (short_id, mailbox_id, latest_message_at)
      VALUES (${newShortId()}, ${mailbox.id}::uuid, '2026-10-25T12:00:00Z') RETURNING id`;
    return row!.id;
  };
  const event = async (
    conversationId: string,
    at: string,
    actor: "user" | "workflow" | "system" | "service_account",
    options: { before?: string; after?: string; outcome?: string; mailbox?: typeof box; action?: string } = {},
  ) => {
    await sql`INSERT INTO mail.activity_events (mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, metadata, created_at)
      VALUES (${(options.mailbox ?? box).id}::uuid, ${conversationId}::uuid, ${actor}, NULL,
        ${options.action ?? "conversation.collaboration_updated"}, ${options.outcome ?? "confirmed"},
        ${{ before: { workStatus: options.before ?? "needs_action" }, after: { workStatus: options.after ?? "done" } }}::jsonb, ${at}::timestamptz)`;
  };
  const routerFor = (context: MailRequestContext) =>
    new Hono<MailApiContext>()
      .use(async (c, next) => {
        c.set("actor", context.actor);
        c.set("accessSubject", context.accessSubject);
        await next();
      })
      .route("/", viewRoutes);

  beforeAll(async () => {
    await migrate();
    owner = contextFor(await makeUser());
    reader = contextFor(await makeUser());
    assigned = contextFor(await makeUser());
    box = await makeMailbox();
    other = await makeMailbox();
    unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId: box.id,
        principal: { type: "user", userId: people[1]!.id },
        permission: "read",
      }),
    );
    unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId: box.id,
        principal: { type: "user", userId: people[2]!.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    settingsSpy = spyOn(coreSettings, "get").mockResolvedValue("Europe/Berlin");
  });
  afterEach(() => {
    setSystemTime();
    settingsSpy?.mockResolvedValue("Europe/Berlin");
  });
  afterAll(async () => {
    settingsSpy?.mockRestore();
    for (const mailbox of mailboxes) {
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailbox.id}::uuid
        UNION SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailbox.id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox.id}::uuid`;
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    }
    for (const person of people) await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
    for (const group of groups) await sql`DELETE FROM auth.groups WHERE id = ${group}::uuid`;
  });

  test("defaults to auto/compact without creating a row", async () => {
    expect(unwrap(await getMailboxViewPreference(owner, box.id))).toEqual(defaults);
    expect(await sql`SELECT 1 FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${box.id}::uuid`).toHaveLength(0);
  });
  test("isolates people, mailboxes and device classes; unpinning preserves the view", async () => {
    expect(unwrap(await setMailboxViewPreference(reader, box.id, { large: "split" }))).toEqual({ large: "split", phone: "compact" });
    expect(unwrap(await getMailboxViewPreference(owner, box.id))).toEqual(defaults);
    expect(unwrap(await getMailboxViewPreference(owner, other.id))).toEqual(defaults);
    await Promise.all([
      setMailboxViewPreference(owner, box.id, { large: "columns" }),
      setMailboxViewPreference(owner, box.id, { phone: "detailed" }),
    ]);
    expect(unwrap(await getMailboxViewPreference(owner, box.id))).toEqual({ large: "columns", phone: "detailed" });
    unwrap(await setMailboxPreference(owner, box.id, { pinned: true }));
    unwrap(await setMailboxPreference(owner, box.id, { pinned: false }));
    expect(unwrap(await getMailboxViewPreference(owner, box.id))).toEqual({ large: "columns", phone: "detailed" });
    expect(
      await sql`SELECT 1 FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${box.id}::uuid AND user_id = ${people[0]!.id}::uuid`,
    ).toHaveLength(1);
  });
  test("allows assigned-only readers to choose their view but denies another mailbox", async () => {
    expect(unwrap(await setMailboxViewPreference(assigned, box.id, { phone: "detailed" }))).toEqual({ large: "auto", phone: "detailed" });
    expect((await getMailboxViewPreference(reader, other.id)).ok).toBe(false);
    expect((await setMailboxViewPreference(reader, other.id, { large: "split" })).ok).toBe(false);
    expect((await setMailboxViewPreference(reader, box.id, {})).ok).toBe(false);
  });
  test("cleans the view immediately on lost access, without disturbing another person's choice", async () => {
    const grant = unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId: other.id,
        principal: { type: "user", userId: people[1]!.id },
        permission: "read",
      }),
    );
    unwrap(await setMailboxViewPreference(reader, other.id, { large: "split", phone: "detailed" }));
    unwrap(await revokeMailboxAccess({ context: owner, mailboxId: other.id, accessId: grant.id }));
    expect(
      await sql`SELECT 1 FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${other.id}::uuid AND user_id = ${people[1]!.id}::uuid`,
    ).toHaveLength(0);
    unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId: other.id,
        principal: { type: "user", userId: people[1]!.id },
        permission: "read",
      }),
    );
    expect(unwrap(await getMailboxViewPreference(reader, other.id))).toEqual(defaults);
    expect(unwrap(await getMailboxViewPreference(owner, box.id))).toEqual({ large: "columns", phone: "detailed" });
  });
  test("group removal keeps views backed by another grant and forgets a view on observed membership loss", async () => {
    const isolated = await makeMailbox();
    const name = `inbox-group-${crypto.randomUUID()}`;
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups (cn, provider, name) VALUES (${name}, 'local', ${name}) RETURNING id`;
    groups.push(group!.id);
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${people[1]!.id}::uuid, ${group!.id}::uuid)`;
    const groupGrant = unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId: isolated.id,
        principal: { type: "group", groupId: group!.id },
        permission: "read",
      }),
    );
    const direct = unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId: isolated.id,
        principal: { type: "user", userId: people[1]!.id },
        permission: "read",
      }),
    );
    unwrap(await setMailboxViewPreference(reader, isolated.id, { phone: "detailed" }));
    unwrap(await revokeMailboxAccess({ context: owner, mailboxId: isolated.id, accessId: groupGrant.id }));
    expect(unwrap(await getMailboxViewPreference(reader, isolated.id))).toEqual({ large: "auto", phone: "detailed" });
    unwrap(
      await grantMailboxAccess({
        context: owner,
        mailboxId: isolated.id,
        principal: { type: "group", groupId: group!.id },
        permission: "read",
      }),
    );
    unwrap(await revokeMailboxAccess({ context: owner, mailboxId: isolated.id, accessId: direct.id }));
    expect(unwrap(await getMailboxViewPreference(reader, isolated.id))).toEqual({ large: "auto", phone: "detailed" });
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${people[1]!.id}::uuid AND group_id = ${group!.id}::uuid`;
    expect((await getMailboxViewPreference(reader, isolated.id)).ok).toBe(false);
    expect(
      await sql`SELECT 1 FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${isolated.id}::uuid AND user_id = ${people[1]!.id}::uuid`,
    ).toHaveLength(0);
  });
  test("deletes preferences with a mailbox, including recoverable deletion", async () => {
    const gone = await makeMailbox();
    unwrap(await setMailboxViewPreference(owner, gone.id, { large: "split" }));
    unwrap(await deleteMailbox(owner, gone.id));
    expect(await sql`SELECT 1 FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${gone.id}::uuid`).toHaveLength(0);
    const physical = await makeMailbox();
    unwrap(await setMailboxViewPreference(owner, physical.id, { phone: "detailed" }));
    await sql`DELETE FROM mail.mailboxes WHERE id = ${physical.id}::uuid`;
    expect(await sql`SELECT 1 FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${physical.id}::uuid`).toHaveLength(0);
  });
  test("GET/PATCH validate public IDs, partial choices and empty changes", async () => {
    const router = routerFor(reader);
    const path = `/mailboxes/${box.shortId}/view`;
    expect(await (await router.request(path)).json()).toEqual({ large: "split", phone: "compact" });
    const response = await router.request(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "detailed" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ large: "split", phone: "detailed" });
    for (const change of [{}, { large: "compact" }, { phone: "auto" }]) {
      expect(
        (await router.request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) }))
          .status,
      ).toBe(400);
    }
    expect((await router.request(`/mailboxes/${box.id}/view`)).status).toBe(404);
  });
  test("publishes authenticated view and count endpoints with response schemas", async () => {
    const spec = await generateSpecs(routerFor(reader));
    for (const [path, method] of [
      ["/mailboxes/{mailboxId}/view", "get"],
      ["/mailboxes/{mailboxId}/view", "patch"],
      ["/mailboxes/{mailboxId}/done-today", "get"],
    ] as const) {
      const operation = spec.paths?.[path]?.[method];
      expect(operation?.security).toHaveLength(1);
      expect(operation?.responses?.["200"]).toBeDefined();
      expect(operation?.responses?.["403"]).toBeDefined();
      expect(operation?.responses?.["404"]).toBeDefined();
    }
  });
  test("counts distinct completed conversations by actor within the mailbox and local day", async () => {
    setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const person = await makeConversation();
    const automated = await makeConversation();
    const system = await makeConversation();
    const service = await makeConversation();
    const unchanged = await makeConversation();
    const wrongDay = await makeConversation();
    const elsewhere = await makeConversation(other);
    await event(person, "2026-10-25T08:00:00Z", "workflow");
    await event(person, "2026-10-25T09:00:00Z", "user");
    await event(person, "2026-10-25T10:00:00Z", "workflow", { before: "done", after: "needs_action" });
    await event(automated, "2026-10-25T09:00:00Z", "workflow");
    await event(system, "2026-10-25T10:00:00Z", "system");
    await event(service, "2026-10-25T10:00:00Z", "service_account");
    await event(unchanged, "2026-10-25T10:00:00Z", "workflow", { before: "done" });
    await event(unchanged, "2026-10-25T10:00:00Z", "workflow", { outcome: "failed" });
    await event(unchanged, "2026-10-25T10:00:00Z", "workflow", { action: "conversation.something_else" });
    await event(wrongDay, "2026-10-24T21:59:59.999Z", "workflow");
    await event(wrongDay, "2026-10-25T23:00:00Z", "workflow");
    await event(elsewhere, "2026-10-25T09:00:00Z", "workflow", { mailbox: other });
    expect(unwrap(await getMailboxDoneTodayCounts(owner, box.id))).toEqual({ doneToday: 4, doneByAutomation: 2 });
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${automated}::uuid, ${people[2]!.id}::uuid)`;
    expect(unwrap(await getMailboxDoneTodayCounts(assigned, box.id))).toEqual({ doneToday: 1, doneByAutomation: 1 });
    const response = await routerFor(assigned).request(`/mailboxes/${box.shortId}/done-today`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ doneToday: 1, doneByAutomation: 1 });
  });
  test("Berlin DST boundaries include the full 25-hour day; Core timezone overrides the fallback", async () => {
    setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const isolated = await makeMailbox();
    const a = await makeConversation(isolated);
    const b = await makeConversation(isolated);
    const c = await makeConversation(isolated);
    await event(a, "2026-10-24T22:00:00Z", "user", { mailbox: isolated });
    await event(b, "2026-10-25T22:59:59.999Z", "workflow", { mailbox: isolated });
    await event(c, "2026-10-25T23:00:00Z", "workflow", { mailbox: isolated });
    settingsSpy.mockResolvedValue("");
    expect(unwrap(await getMailboxDoneTodayCounts(owner, isolated.id))).toEqual({ doneToday: 2, doneByAutomation: 1 });
    settingsSpy.mockResolvedValue("UTC");
    expect(unwrap(await getMailboxDoneTodayCounts(owner, isolated.id))).toEqual({ doneToday: 2, doneByAutomation: 2 });
  });
  test("SSR data carries both classes and counts across the public resource boundary", async () => {
    setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const request = await resolveWorkspaceRequest(new URL(`http://localhost/mail/${box.shortId}?view=needs_action`), box.id);
    if (!request) throw new Error("Workspace route not resolved");
    const data = unwrap(await loadMailboxPageData({ context: owner, mailboxId: box.id, ...request }));
    expect(data.viewPreference).toEqual({ large: "columns", phone: "detailed" });
    expect(data.doneTodayCounts).toEqual({ doneToday: 4, doneByAutomation: 2 });
    const projected = await projectMailboxPageData(data);
    expect(projected.mailbox.id).toBe(box.shortId);
    expect(projected.viewPreference).toEqual(data.viewPreference);
    expect(projected.doneTodayCounts).toEqual(data.doneTodayCounts);
    expect(JSON.stringify(projected)).not.toContain(box.id);
  });
});
