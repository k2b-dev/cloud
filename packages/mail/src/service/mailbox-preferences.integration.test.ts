import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { importBrowserMailboxPreferences, listMailboxPreferences, setMailboxPreference } from "./mailbox-preferences";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

// The overview page renders Solid JSX on the server.
const root = mkdtempSync(join(tmpdir(), "mail-preferences-ssr-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
});

suite("mailbox preferences per person", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  let ada: { id: string; uid: string };
  let grace: { id: string; uid: string };
  let support: { id: string; shortId: string };
  let sales: { id: string; shortId: string };
  let billing: { id: string; shortId: string };

  const createUser = async (label: string) => {
    const uid = `mail-prefs-${label}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    userIds.push(row!.id);
    return { id: row!.id, uid };
  };
  const createFixtureMailbox = async (owner: { id: string; uid: string }, name: string) => {
    const created = await createMailbox(contextFor(owner), { name: `${name} ${suffix}` });
    if (!created.ok) throw new Error(created.error.message);
    mailboxIds.push(created.data.id);
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${created.data.id}::uuid`;
    return { id: created.data.id, shortId: row!.short_id };
  };

  beforeAll(async () => {
    await migrate();
    ada = await createUser("ada");
    grace = await createUser("grace");
    support = await createFixtureMailbox(ada, "Support");
    sales = await createFixtureMailbox(ada, "Sales");
    billing = await createFixtureMailbox(grace, "Billing");
  });

  afterAll(async () => {
    const access = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access
      WHERE mailbox_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))
    `;
    await sql`DELETE FROM mail.mailboxes WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxIds}::jsonb))`;
    if (access.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))`;
    }
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  test("keeps pins and hidden mailboxes for the person, newest first, and changes only the given flag", async () => {
    expect(await setMailboxPreference(contextFor(ada), support.id, { pinned: true })).toEqual({
      ok: true,
      data: { pinned: true, hidden: false },
    });
    await Bun.sleep(5);
    await setMailboxPreference(contextFor(ada), sales.id, { pinned: true });
    // Hiding a pinned mailbox keeps its pin, so showing it again puts it back at the top.
    expect(await setMailboxPreference(contextFor(ada), support.id, { hidden: true })).toEqual({
      ok: true,
      data: { pinned: true, hidden: true },
    });
    expect(await listMailboxPreferences(ada.id)).toEqual({ pinnedMailboxIds: [sales.id, support.id], hiddenMailboxIds: [support.id] });
    // Another person with access to nothing pinned sees none of it.
    expect(await listMailboxPreferences(grace.id)).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [] });

    await setMailboxPreference(contextFor(ada), support.id, { pinned: false, hidden: false });
    expect(await listMailboxPreferences(ada.id)).toEqual({ pinnedMailboxIds: [sales.id], hiddenMailboxIds: [] });
    const [rows] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mail.user_mailbox_preferences WHERE user_id = ${ada.id}::uuid AND mailbox_id = ${support.id}::uuid
    `;
    expect(rows?.count).toBe(0);
    await setMailboxPreference(contextFor(ada), sales.id, { pinned: false });
  });

  test("refuses mailboxes the person cannot read and principals that are not people", async () => {
    const denied = await setMailboxPreference(contextFor(ada), billing.id, { hidden: true });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);
    const serviceAccount: MailRequestContext = {
      actor: { kind: "service_account", serviceAccount: { id: crypto.randomUUID(), kind: "standalone" }, delegatedUser: null } as never,
      accessSubject: { type: "service_account", serviceAccountId: crypto.randomUUID() },
    };
    const notPerson = await setMailboxPreference(serviceAccount, support.id, { pinned: true });
    expect(notPerson.ok).toBe(false);
    if (!notPerson.ok) expect(notPerson.error.status).toBe(403);
    expect(await listMailboxPreferences(ada.id)).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [] });
  });

  test("adds a browser's stored lists in their order and keeps what another device stored", async () => {
    await setMailboxPreference(contextFor(ada), sales.id, { hidden: true });
    await importBrowserMailboxPreferences(ada.id, {
      pinnedMailboxIds: [support.shortId, sales.shortId],
      hiddenMailboxIds: [support.shortId, "Gone01"],
    });
    expect(await listMailboxPreferences(ada.id)).toEqual({
      pinnedMailboxIds: [support.id, sales.id],
      hiddenMailboxIds: expect.arrayContaining([support.id, sales.id]),
    });
    // A second browser with the same lists changes nothing.
    const before = await sql`SELECT * FROM mail.user_mailbox_preferences WHERE user_id = ${ada.id}::uuid ORDER BY mailbox_id`;
    await importBrowserMailboxPreferences(ada.id, { pinnedMailboxIds: [sales.shortId], hiddenMailboxIds: [support.shortId] });
    expect(await sql`SELECT * FROM mail.user_mailbox_preferences WHERE user_id = ${ada.id}::uuid ORDER BY mailbox_id`).toEqual(before);
  });

  test("forgets preferences of a deleted mailbox", async () => {
    const archive = await createFixtureMailbox(ada, "Archive");
    await setMailboxPreference(contextFor(ada), archive.id, { pinned: true });
    await sql`DELETE FROM mail.mailboxes WHERE id = ${archive.id}::uuid`;
    expect((await listMailboxPreferences(ada.id)).pinnedMailboxIds).not.toContain(archive.id);
  });

  test("the overview moves a browser's lists to the person once and renders them on the first paint", async () => {
    const { default: overviewPage } = await import("../frontend/page");
    const context = contextFor(ada);
    const router = new Hono<AuthContext>()
      .use(async (c, next) => {
        c.set("actor", context.actor as never);
        c.set("accessSubject", context.accessSubject as never);
        // The Cloud page frame needs the app registry; this overview needs no other app.
        c.set("runtime" as never, { apps: [] } as never);
        await next();
      })
      .get("/", ...overviewPage);
    const cookie = `cloud_mail_workspace=${encodeURIComponent(
      JSON.stringify({ listMode: "messages", pinnedMailboxIds: [], hiddenMailboxIds: [billing.shortId, sales.shortId] }),
    )}`;
    await sql`DELETE FROM mail.user_mailbox_preferences WHERE user_id = ${ada.id}::uuid`;

    const response = await router.request("/", { headers: { cookie } });
    expect(response.status).toBe(200);
    // Billing belongs to someone else, so only Sales moves; the cookie keeps the other preferences.
    expect(await listMailboxPreferences(ada.id)).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [sales.id] });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/app/mail");
    expect(JSON.parse(decodeURIComponent(setCookie.split(";")[0]!.split("=")[1]!))).toMatchObject({
      listMode: "messages",
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
    });
    const html = await response.text();
    expect(html).toMatch(
      new RegExp(`data-mailbox="${sales.shortId}"[^>]*data-hidden="true"|data-hidden="true"[^>]*data-mailbox="${sales.shortId}"`),
    );

    // Without lists in the cookie, the stored preferences alone decide the first paint.
    const later = await router.request("/", { headers: { cookie: setCookie.split(";")[0]! } });
    expect(later.headers.get("set-cookie")).toBeNull();
    expect(await later.text()).toContain(`data-mailbox="${sales.shortId}"`);
  });
});
