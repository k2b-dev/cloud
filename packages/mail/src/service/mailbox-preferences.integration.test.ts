import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { MAX_MAILBOX_PREFERENCES } from "../contracts";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { importBrowserMailboxPreferences, listMailboxPreferences, setMailboxPreference } from "./mailbox-preferences";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

// The overview page renders Solid JSX on the server.
const root = mkdtempSync(join(tmpdir(), "mail-preferences-ssr-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

type Person = { id: string; uid: string };
type FixtureMailbox = { id: string; shortId: string };

const contextFor = (user: Person): MailRequestContext => ({
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

const browserCookie = (lists: { pinnedMailboxIds?: string[]; hiddenMailboxIds?: string[] }) =>
  `cloud_mail_workspace=${encodeURIComponent(JSON.stringify({ listMode: "messages", pinnedMailboxIds: [], hiddenMailboxIds: [], ...lists }))}`;

/** The mailbox rows of the overview sidebar, in order, as the first paint renders them. */
const sidebarRows = (html: string) =>
  [...html.matchAll(/<[^>]*\bdata-mailbox="([0-9A-Za-z]{6})"[^>]*>/g)].map((match) => ({
    id: match[1],
    pinned: match[0].includes('data-pinned="true"'),
    hidden: match[0].includes('data-hidden="true"'),
  }));

suite("mailbox preferences per person", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  let ada: Person;
  let grace: Person;
  let lin: Person;
  let support: FixtureMailbox;
  let sales: FixtureMailbox;
  let billing: FixtureMailbox;
  let archive: FixtureMailbox;
  let bulk: FixtureMailbox[];

  const createUser = async (label: string): Promise<Person> => {
    const uid = `mail-prefs-${label}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    userIds.push(row!.id);
    return { id: row!.id, uid };
  };
  const createFixtureMailbox = async (owner: Person, name: string): Promise<FixtureMailbox> => {
    const created = await createMailbox(contextFor(owner), { name: `${name} ${suffix}` });
    if (!created.ok) throw new Error(created.error.message);
    mailboxIds.push(created.data.id);
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${created.data.id}::uuid`;
    return { id: created.data.id, shortId: row!.short_id };
  };
  const overviewFor = async (person: Person) => {
    const { default: overviewPage } = await import("../frontend/page");
    const context = contextFor(person);
    return new Hono<AuthContext>()
      .use(async (c, next) => {
        c.set("actor", context.actor as never);
        c.set("accessSubject", context.accessSubject as never);
        // The Cloud page frame needs the app registry; this overview needs no other app.
        c.set("runtime" as never, { apps: [] } as never);
        await next();
      })
      .get("/", ...overviewPage);
  };
  const clearPreferences = (person: Person) => sql`DELETE FROM mail.personal_mailbox_preferences WHERE user_id = ${person.id}::uuid`;

  beforeAll(async () => {
    await migrate();
    ada = await createUser("ada");
    grace = await createUser("grace");
    lin = await createUser("lin");
    support = await createFixtureMailbox(ada, "Support");
    sales = await createFixtureMailbox(ada, "Sales");
    billing = await createFixtureMailbox(grace, "Billing");
    // Lin reads more mailboxes than the overview lists; Archive, created first, is the one updated longest ago.
    archive = await createFixtureMailbox(lin, "Archive");
    bulk = [];
    for (let start = 0; start < MAX_MAILBOX_PREFERENCES; start += 25) {
      const size = Math.min(25, MAX_MAILBOX_PREFERENCES - start);
      bulk.push(...(await Promise.all(Array.from({ length: size }, (_, index) => createFixtureMailbox(lin, `Team ${start + index}`)))));
    }
  }, 60_000);

  afterAll(async () => {
    const access = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ANY(${toPgUuidArray(mailboxIds)}::uuid[])
    `;
    await sql`DELETE FROM mail.mailboxes WHERE id = ANY(${toPgUuidArray(mailboxIds)}::uuid[])`;
    if (access.length > 0) {
      await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(access.map((row) => row.access_id))}::uuid[])`;
    }
    await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(userIds)}::uuid[])`;
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
    expect(await listMailboxPreferences(contextFor(ada))).toEqual({
      pinnedMailboxIds: [sales.id, support.id],
      hiddenMailboxIds: [support.id],
    });
    // Another person with access to nothing pinned sees none of it.
    expect(await listMailboxPreferences(contextFor(grace))).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [] });

    await setMailboxPreference(contextFor(ada), support.id, { pinned: false, hidden: false });
    expect(await listMailboxPreferences(contextFor(ada))).toEqual({ pinnedMailboxIds: [sales.id], hiddenMailboxIds: [] });
    const [rows] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mail.personal_mailbox_preferences
      WHERE user_id = ${ada.id}::uuid AND mailbox_id = ${support.id}::uuid
    `;
    expect(rows?.count).toBe(0);
    await setMailboxPreference(contextFor(ada), sales.id, { pinned: false });
  });

  test("refuses mailboxes the person cannot read and lists only readable ones", async () => {
    const denied = await setMailboxPreference(contextFor(ada), billing.id, { hidden: true });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);
    expect(await listMailboxPreferences(contextFor(ada))).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [] });

    // A row of a mailbox that is gone from the person's reach stays, but is not listed.
    await setMailboxPreference(contextFor(ada), sales.id, { hidden: true });
    await sql`UPDATE mail.mailboxes SET deleted_at = now() WHERE id = ${sales.id}::uuid`;
    try {
      expect(await listMailboxPreferences(contextFor(ada))).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [] });
    } finally {
      await sql`UPDATE mail.mailboxes SET deleted_at = NULL WHERE id = ${sales.id}::uuid`;
    }
    expect(await listMailboxPreferences(contextFor(ada))).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [sales.id] });
    await clearPreferences(ada);
  });

  test("keeps each list within the limit and counts only mailboxes the person can still read", async () => {
    await clearPreferences(lin);
    // 199 hidden mailboxes, oldest first; Archive and the last team mailbox are not hidden yet.
    const [first, ...rest] = bulk;
    const hiddenBefore = [first!, ...rest.slice(0, MAX_MAILBOX_PREFERENCES - 2)];
    await sql`
      INSERT INTO mail.personal_mailbox_preferences (mailbox_id, user_id, hidden_at)
      SELECT item.mailbox_id, ${lin.id}::uuid, now() - interval '1 hour' + item.position * interval '1 second'
      FROM unnest(${toPgUuidArray(hiddenBefore.map((mailbox) => mailbox.id))}::uuid[]) WITH ORDINALITY AS item(mailbox_id, position)
    `;
    const last = bulk.at(-1)!;

    // A browser's list fills the remaining place newest first and leaves the rest out.
    await importBrowserMailboxPreferences(contextFor(lin), { pinnedMailboxIds: [], hiddenMailboxIds: [archive.shortId, last.shortId] });
    let stored = await listMailboxPreferences(contextFor(lin));
    expect(stored.hiddenMailboxIds).toHaveLength(MAX_MAILBOX_PREFERENCES);
    expect(stored.hiddenMailboxIds[0]).toBe(archive.id);
    expect(stored.hiddenMailboxIds).not.toContain(last.id);

    const full = await setMailboxPreference(contextFor(lin), last.id, { hidden: true });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error).toMatchObject({ status: 400, message: `At most ${MAX_MAILBOX_PREFERENCES} mailboxes can be hidden` });
    // Pins have their own limit.
    expect(await setMailboxPreference(contextFor(lin), last.id, { pinned: true })).toEqual({
      ok: true,
      data: { pinned: true, hidden: false },
    });

    // A mailbox the person can no longer read frees its place, and its row waits for the grant to return.
    await sql`UPDATE mail.mailboxes SET deleted_at = now() WHERE id = ${first!.id}::uuid`;
    try {
      expect(await setMailboxPreference(contextFor(lin), last.id, { hidden: true })).toEqual({
        ok: true,
        data: { pinned: true, hidden: true },
      });
      stored = await listMailboxPreferences(contextFor(lin));
      expect(stored.hiddenMailboxIds).toHaveLength(MAX_MAILBOX_PREFERENCES);
      expect(stored.hiddenMailboxIds[0]).toBe(last.id);
      expect(stored.hiddenMailboxIds).not.toContain(first!.id);
    } finally {
      await sql`UPDATE mail.mailboxes SET deleted_at = NULL WHERE id = ${first!.id}::uuid`;
    }
    // With the grant back, 201 are hidden; the oldest stays stored but past the list Focus receives.
    stored = await listMailboxPreferences(contextFor(lin));
    expect(stored.hiddenMailboxIds).toHaveLength(MAX_MAILBOX_PREFERENCES);
    expect(stored.hiddenMailboxIds).not.toContain(first!.id);
    await clearPreferences(lin);
  });

  test("adds a browser's stored lists in their order and keeps what another device stored", async () => {
    await clearPreferences(ada);
    await setMailboxPreference(contextFor(ada), sales.id, { hidden: true });
    await importBrowserMailboxPreferences(contextFor(ada), {
      pinnedMailboxIds: [support.shortId, sales.shortId],
      hiddenMailboxIds: [support.shortId, billing.shortId, "Gone01"],
    });
    // Billing belongs to someone else and Gone01 does not exist, so neither is stored.
    expect(await listMailboxPreferences(contextFor(ada))).toEqual({
      pinnedMailboxIds: [support.id, sales.id],
      hiddenMailboxIds: expect.arrayContaining([support.id, sales.id]),
    });
    expect((await listMailboxPreferences(contextFor(ada))).hiddenMailboxIds).toHaveLength(2);
    // A second browser with the same lists changes nothing.
    const before = await sql`SELECT * FROM mail.personal_mailbox_preferences WHERE user_id = ${ada.id}::uuid ORDER BY mailbox_id`;
    await importBrowserMailboxPreferences(contextFor(ada), { pinnedMailboxIds: [sales.shortId], hiddenMailboxIds: [support.shortId] });
    expect(await sql`SELECT * FROM mail.personal_mailbox_preferences WHERE user_id = ${ada.id}::uuid ORDER BY mailbox_id`).toEqual(before);
    await clearPreferences(ada);
  });

  test("forgets preferences of a deleted mailbox", async () => {
    const gone = await createFixtureMailbox(ada, "Gone");
    await setMailboxPreference(contextFor(ada), gone.id, { pinned: true });
    const [grant] = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${gone.id}::uuid`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${gone.id}::uuid`;
    await sql`DELETE FROM auth.access WHERE id = ${grant!.access_id}::uuid`;
    const [rows] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mail.personal_mailbox_preferences WHERE mailbox_id = ${gone.id}::uuid
    `;
    expect(rows?.count).toBe(0);
  });

  test("the overview moves a browser's lists to the person once and renders them on the first paint", async () => {
    const router = await overviewFor(ada);
    await clearPreferences(ada);

    const response = await router.request("/", {
      headers: { cookie: browserCookie({ hiddenMailboxIds: [billing.shortId, sales.shortId] }) },
    });
    expect(response.status).toBe(200);
    // Billing belongs to someone else, so only Sales moves; the cookie keeps the other preferences.
    expect(await listMailboxPreferences(contextFor(ada))).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [sales.id] });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/app/mail");
    expect(JSON.parse(decodeURIComponent(setCookie.split(";")[0]!.split("=")[1]!))).toMatchObject({
      listMode: "messages",
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
    });
    expect(sidebarRows(await response.text())).toContainEqual({ id: sales.shortId, pinned: false, hidden: true });

    // Without lists in the cookie, the stored preferences alone decide the first paint.
    const later = await router.request("/", { headers: { cookie: setCookie.split(";")[0]! } });
    expect(later.headers.get("set-cookie")).toBeNull();
    expect(sidebarRows(await later.text())).toContainEqual({ id: sales.shortId, pinned: false, hidden: true });
    await clearPreferences(ada);
  });

  test("two browsers of one person show the same mailbox list once both moved their lists", async () => {
    const router = await overviewFor(ada);
    await clearPreferences(ada);
    const open = async (cookie: string) => {
      const response = await router.request("/", { headers: { cookie } });
      expect(response.status).toBe(200);
      return sidebarRows(await response.text());
    };

    // The laptop pinned Sales; the phone pinned Support and hid Sales. Each moves its lists once.
    await open(browserCookie({ pinnedMailboxIds: [sales.shortId] }));
    await Bun.sleep(5);
    await open(browserCookie({ pinnedMailboxIds: [support.shortId], hiddenMailboxIds: [sales.shortId] }));
    const laptop = await open(browserCookie({}));
    const phone = await open(browserCookie({}));
    expect(laptop).toEqual(phone);
    expect(laptop.filter((row) => row.id === support.shortId || row.id === sales.shortId)).toEqual([
      { id: support.shortId, pinned: true, hidden: false },
      // A hidden mailbox keeps its pin and waits under Hidden.
      { id: sales.shortId, pinned: false, hidden: true },
    ]);

    // Showing Sales again on the laptop shows it on the phone's next load too, still pinned below Support.
    await setMailboxPreference(contextFor(ada), sales.id, { hidden: false });
    expect((await open(browserCookie({}))).filter((row) => row.id === support.shortId || row.id === sales.shortId)).toEqual([
      { id: support.shortId, pinned: true, hidden: false },
      { id: sales.shortId, pinned: true, hidden: false },
    ]);
    await clearPreferences(ada);
  });

  test("the overview moves a browser's lists for mailboxes beyond the ones it lists", async () => {
    const router = await overviewFor(lin);
    await clearPreferences(lin);
    // Lin reads 201 mailboxes; the overview lists the 200 most recently updated, without Archive.
    const response = await router.request("/", { headers: { cookie: browserCookie({ hiddenMailboxIds: [archive.shortId] }) } });
    expect(response.status).toBe(200);
    expect(sidebarRows(await response.text()).map((row) => row.id)).not.toContain(archive.shortId);
    expect(await listMailboxPreferences(contextFor(lin))).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [archive.id] });
    await clearPreferences(lin);
  });
});
