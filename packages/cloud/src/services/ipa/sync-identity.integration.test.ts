import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { suiteFor, testInfra, useMigratedDatabase } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { freeipa } from "../../server/services";
import * as settings from "../settings";
import { preserveTestSettings } from "../settings/settings.test-fixture";
import { syncFromIpa, syncUser } from "./sync";

// A full sync reconciles every FreeIPA account in the database, so this suite owns its database.
if (testInfra.database && testInfra.valkey && testInfra.nats) {
  const database = await useMigratedDatabase("ipa_identity");
  afterAll(() => database.drop());
}
await import("../../../../../scripts/fixtures/authorization-preload");

const config = {
  "freeipa.enable": true,
  "freeipa.url": "ipa.example.test",
  "freeipa.service_user": "example",
  "freeipa.service_password": "fictional",
  "freeipa.groups.base_sync": ["cloud"],
  "freeipa.groups.base_ipa_realm": ["people"],
  "freeipa.user_match_mode": "ignore",
  "freeipa.account_transition_policy": "demote_to_local",
  "freeipa.sync_guard.max_user_change_percent": 100,
};

type Entry = { uid: string; mail: string; entry: string | null; locked?: boolean };

suiteFor(
  "database",
  "valkey",
  "nats",
)("FreeIPA sync account identity", () => {
  preserveTestSettings(Object.keys(config));
  let directory: Entry[] = [];
  let teams: Record<string, string[]> = {};
  let rpc: ReturnType<typeof spyOn<typeof freeipa.client, "call">>;
  let ipaSession: ReturnType<typeof spyOn<typeof freeipa.session, "getServiceSession">>;
  const list = (result: unknown) => ({ id: 0, error: null, result: { truncated: false, result } });
  const record = (user: Entry) => ({
    uid: [user.uid],
    givenname: ["Example"],
    sn: ["Person"],
    mail: [user.mail],
    nsaccountlock: user.locked === true,
    ...(user.entry ? { ipauniqueid: [user.entry] } : {}),
  });
  const insertAccount = async (uid: string, provider: "ipa" | "local", mail: string) =>
    (
      await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, given_name, sn, display_name, mail)
        VALUES (${uid}, ${provider}, 'user', 'Example', 'Person', ${uid}, ${mail})
        RETURNING id
      `
    )[0]!.id;
  const groupsOf = async (userId: string) =>
    (
      await sql<{ name: string }[]>`
        SELECT g.name FROM auth.user_groups_v2 ug JOIN auth.groups g ON g.id = ug.group_id
        WHERE ug.user_id = ${userId}::uuid ORDER BY g.name
      `
    ).map((row) => row.name);
  const account = async (uid: string) =>
    (
      await sql<{ id: string; provider: string; mail: string | null; ipa_entry_id: string | null }[]>`
        SELECT u.id, u.provider, u.mail, ui.ipa_entry_id
        FROM auth.users u LEFT JOIN auth.user_ipa_data ui ON ui.user_id = u.id
        WHERE u.uid = ${uid}
      `
    )[0];

  beforeEach(async () => {
    directory = [];
    teams = {};
    for (const [key, value] of Object.entries(config)) await settings.set(key, value);
    ipaSession = spyOn(freeipa.session, "getServiceSession").mockResolvedValue("fictional-session");
    rpc = spyOn(freeipa.client, "call").mockImplementation(async ({ method, args }) => {
      const uids = directory.map((user) => user.uid);
      if (method === "user_find") return list(directory.map(record));
      if (method === "group_find")
        return list([
          { cn: ["cloud"], member_user: uids },
          { cn: ["people"], member_user: uids },
          ...Object.entries(teams).map(([cn, members]) => ({ cn: [cn], member_user: members })),
        ]);
      if (method === "user_show") {
        const user = directory.find((entry) => entry.uid === args?.[0]);
        if (user) return { id: 0, error: null, result: { result: record(user) } };
      }
      throw new Error(`Unexpected FreeIPA call ${method}`);
    });
  });
  afterEach(async () => {
    rpc.mockRestore();
    ipaSession.mockRestore();
    await sql`DELETE FROM auth.users`;
    await sql`DELETE FROM auth.groups WHERE provider = 'ipa'`;
  });

  test("a new directory user with the email of an existing account gets a separate account", async () => {
    const existing = await insertAccount("ada", "ipa", "shared@example.test");
    directory = [{ uid: "grace", mail: "shared@example.test", entry: "entry-grace" }];

    await syncFromIpa();
    expect((await account("ada"))?.id).toBe(existing);
    expect(await account("grace")).toBeUndefined();
    expect(await syncUser("grace")).toEqual({ status: "not_found_local" });

    // The previous account left sync scope; the next sync gives the new user an account of its own.
    await syncFromIpa();
    const created = await account("grace");
    expect(created?.provider).toBe("ipa");
    expect(created?.id).not.toBe(existing);
    expect(await syncUser("grace")).toEqual({ status: "synced", userId: created!.id });
  });

  test("a renamed directory user keeps its account through the directory entry ID", async () => {
    directory = [{ uid: "ada", mail: "ada@example.test", entry: "entry-ada" }];
    await syncFromIpa();
    const original = await account("ada");
    expect(original?.ipa_entry_id).toBe("ipauniqueid:entry-ada");

    directory = [{ uid: "ada.l", mail: "ada.l@example.test", entry: "entry-ada" }];
    await syncFromIpa();
    expect(await account("ada")).toBeUndefined();
    expect(await account("ada.l")).toMatchObject({ id: original!.id, provider: "ipa", mail: "ada.l@example.test" });
  });

  test("an existing account without a stored entry ID is bound by username", async () => {
    const existing = await insertAccount("ada", "ipa", "ada@example.test");
    directory = [{ uid: "ada", mail: "ada@example.test", entry: "entry-ada" }];

    await syncFromIpa();
    expect(await account("ada")).toMatchObject({ id: existing, provider: "ipa", ipa_entry_id: "ipauniqueid:entry-ada" });
  });

  test("a username reused by another directory entry gets no access to the previous account", async () => {
    directory = [{ uid: "ada", mail: "ada@example.test", entry: "entry-ada" }];
    await syncFromIpa();
    const previous = await account("ada");

    directory = [{ uid: "ada", mail: "ada@example.test", entry: "entry-other" }];
    expect(await syncUser("ada")).toEqual({ status: "not_found_local" });
    await syncFromIpa();
    expect(await account("ada")).toMatchObject({ id: previous!.id, provider: "local" });
  });

  test("an email collision is reported and the rest of the sync continues", async () => {
    directory = [
      { uid: "ada", mail: "ada@example.test", entry: "entry-ada" },
      { uid: "grace", mail: "grace@example.test", entry: "entry-grace" },
    ];
    await syncFromIpa();
    const ada = await account("ada");
    const grace = await account("grace");

    directory = [
      { uid: "ada", mail: "ada@example.test", entry: "entry-ada" },
      { uid: "grace", mail: "ada@example.test", entry: "entry-grace" },
      { uid: "linus", mail: "linus@example.test", entry: "entry-linus" },
    ];
    await syncFromIpa();
    expect(await account("ada")).toMatchObject({ id: ada!.id, mail: "ada@example.test" });
    expect(await account("grace")).toMatchObject({ id: grace!.id, mail: "grace@example.test" });
    expect((await account("linus"))?.provider).toBe("ipa");
    expect(await syncUser("grace")).toEqual({ status: "synced", userId: grace!.id });
    expect((await account("grace"))?.mail).toBe("grace@example.test");
  });

  test("a directory record without an entry ID neither replaces nor removes a bound account", async () => {
    directory = [{ uid: "ada", mail: "ada@example.test", entry: "entry-ada" }];
    await syncFromIpa();
    const bound = await account("ada");

    directory = [{ uid: "ada", mail: "ada@example.test", entry: null }];
    await syncFromIpa();
    expect(await account("ada")).toMatchObject({ id: bound!.id, provider: "ipa", ipa_entry_id: "ipauniqueid:entry-ada" });
    expect((await syncUser("ada")).status).toBe("fetch_failed");

    directory = [{ uid: "ada", mail: "ada@example.test", entry: null, locked: true }];
    await syncFromIpa();
    const [lock] = await sql<{ locked_at: Date | null }[]>`SELECT locked_at FROM auth.user_ipa_data WHERE user_id = ${bound!.id}::uuid`;
    expect(lock?.locked_at).not.toBeNull();
  });

  test("group memberships follow the directory identity, not the stored username", async () => {
    directory = [{ uid: "ada", mail: "ada@example.test", entry: "entry-ada" }];
    await syncFromIpa();
    const ada = await account("ada");
    await insertAccount("ada.l", "local", "ada.l@example.test");

    // The rename is held back because a local account uses the new username; another entry now uses the old one.
    directory = [
      { uid: "ada.l", mail: "ada@example.test", entry: "entry-ada" },
      { uid: "ada", mail: "other@example.test", entry: "entry-other" },
    ];
    teams = { "team-of-other": ["ada"], "team-of-ada": ["ada.l"] };
    await syncFromIpa();
    expect(await account("ada")).toMatchObject({ id: ada!.id, provider: "ipa" });
    expect(await groupsOf(ada!.id)).toEqual(["cloud", "people", "team-of-ada"]);
  });

  test("a transition blocked by a local account with the same email does not stop the sync", async () => {
    directory = [{ uid: "ada", mail: "shared@example.test", entry: "entry-ada" }];
    await syncFromIpa();
    const ada = await account("ada");
    await insertAccount("ada-local", "local", "shared@example.test");

    directory = [
      { uid: "ada", mail: "other@example.test", entry: "entry-other" },
      { uid: "grace", mail: "grace@example.test", entry: "entry-grace" },
    ];
    await syncFromIpa();
    expect(await account("ada")).toMatchObject({ id: ada!.id, provider: "ipa" });
    expect((await account("grace"))?.provider).toBe("ipa");
    expect(await syncUser("ada")).toEqual({ status: "not_found_local" });
  });

  test("migrate mode proposes a local account link and does not link it", async () => {
    await settings.set("freeipa.user_match_mode", "migrate");
    const local = await insertAccount("ada-local", "local", "ada@example.test");
    directory = [{ uid: "ada", mail: "ada@example.test", entry: "entry-ada" }];

    await syncFromIpa();
    expect(await account("ada-local")).toMatchObject({ id: local, provider: "local" });
    expect(await account("ada")).toBeUndefined();
  });
});
