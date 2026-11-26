import { expect, test } from "bun:test";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import type { UserDirectoryEntry } from "../../contracts/shared";
import { sql } from "../../runtime/clients";
import { getFreeIpaConfig } from "../freeipa-config";
import { accountsAppService } from "./app";

const suite = databaseSuite();

suite("the administration's user list (integration)", () => {
  test("filters, sorts and names each account's groups, in two statements", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const user = async (
      name: string,
      values: { provider?: "local" | "ipa"; profile?: "user" | "guest"; admin?: boolean; login?: string; expires?: string },
    ) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, mail, admin, last_login_local, account_expires)
        VALUES (${`dir-${name.toLowerCase()}-${tag}`}, ${values.provider ?? "local"}, ${values.profile ?? "user"}, ${`${name} ${tag}`},
          ${`${name.toLowerCase()}-${tag}@example.test`}, ${values.admin ?? false}, ${values.login ?? null}, ${values.expires ?? null})
        RETURNING id
      `;
      return row!.id;
    };
    const group = async (name: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.groups (cn, provider, name) VALUES (${`dir-${name}-${tag}`}, 'local', ${`${name} ${tag}`}) RETURNING id
      `;
      return row!.id;
    };
    const day = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const ada = await user("Ada", { admin: true, login: day(2) });
    const ben = await user("Ben", { login: day(120) });
    await user("Cleo", { profile: "guest" });
    await user("Dora", { login: day(40), expires: day(1) });
    // a FreeIPA guest in an administrators' group stays a guest, as `buildRoles` decides for the session
    const ivo = await user("Ivo", { provider: "ipa", profile: "guest", login: day(10) });
    const [adminGroup] = (await getFreeIpaConfig()).groupsAdmin;
    await sql`INSERT INTO auth.ipa_user_effective_groups (user_id, group_name) VALUES (${ivo}::uuid, ${adminGroup!})`;
    const admin = { userId: ada, uid: `dir-ada-${tag}`, roles: ["user", "admin"], provider: "local" };
    const sales = await group("sales");
    const board = await group("board");
    const personal = await group("ada-personal");
    const gid = 400_000 + Math.floor(Math.random() * 500_000);
    await sql`INSERT INTO auth.personal_groups (group_id, owner_id, group_name, gid_number)
      VALUES (${personal}::uuid, ${ada}::uuid, ${`dir-ada-personal-${tag}`}, ${gid})`;
    for (const [member, of] of [
      [ada, sales],
      [ada, board],
      [ada, personal],
      [ben, sales],
    ] as const)
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${member}::uuid, ${of}::uuid)`;
    await sql`
      INSERT INTO auth.webauthn_credentials (user_id, name, credential_id, public_key)
      VALUES (${ben}::uuid, 'key', ${`dir-cred-${tag}`}, '\\x00'::bytea)
    `;
    const read = async (query: Omit<Parameters<typeof accountsAppService.user.directory>[0], "search" | "actor"> = {}) => {
      const result = await accountsAppService.user.directory({ actor: admin, search: tag, ...query });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    };
    const list = (query: Parameters<typeof read>[0] = {}) =>
      read(query).then((page) => page.items.map((entry) => entry.displayName.split(" ")[0]));

    try {
      // what a row shows: role, state, groups without the personal one, the passkey
      const all = await read();
      expect(all.total).toBe(5);
      const byName: Record<string, UserDirectoryEntry> = Object.fromEntries(
        all.items.map((entry) => [entry.displayName.split(" ")[0], entry]),
      );
      expect(byName.Ada).toMatchObject({ role: "admin", status: "active", passkey: false, groupCount: 2 });
      expect(byName.Ada!.groups.map((entry) => entry.name)).toEqual([`board ${tag}`, `sales ${tag}`]);
      expect(byName.Ben).toMatchObject({ role: "member", status: "active", passkey: true, groupCount: 1 });
      expect(byName.Cleo).toMatchObject({ role: "guest", status: "invited", lastLogin: null, groups: [] });
      expect(byName.Dora).toMatchObject({ role: "member", status: "expired" });
      expect(byName.Ivo).toMatchObject({ role: "guest", profile: "guest" });
      expect(byName.Ivo!.roles).not.toContain("admin");

      expect(await list()).toEqual(["Ada", "Ben", "Cleo", "Dora", "Ivo"]);
      expect(await list({ sort: { field: "name", direction: "desc" } })).toEqual(["Ivo", "Dora", "Cleo", "Ben", "Ada"]);
      expect(await list({ sort: { field: "lastLogin", direction: "desc" } })).toEqual(["Ada", "Ivo", "Dora", "Ben", "Cleo"]);
      expect(await list({ sort: { field: "lastLogin", direction: "asc" } })).toEqual(["Cleo", "Ben", "Dora", "Ivo", "Ada"]);
      expect(await list({ roles: ["admin", "guest"] })).toEqual(["Ada", "Cleo", "Ivo"]);
      expect(await list({ roles: ["admin"] })).toEqual(["Ada"]);
      expect(await list({ roles: ["guest"] })).toEqual(["Cleo", "Ivo"]);
      expect(await list({ roles: ["member"] })).toEqual(["Ben", "Dora"]);
      expect(await list({ groupIds: [board] })).toEqual(["Ada"]);
      expect(await list({ groupIds: [sales, board] })).toEqual(["Ada", "Ben"]);
      expect(await list({ statuses: ["invited", "expired"] })).toEqual(["Cleo", "Dora"]);
      expect(await list({ lastLogin: "never" })).toEqual(["Cleo"]);
      expect(await list({ lastLogin: { since: new Date(day(30)) } })).toEqual(["Ada", "Ivo"]);
      expect(await list({ lastLogin: { until: new Date(day(90)) } })).toEqual(["Ben"]);
      expect(await list({ passkey: true })).toEqual(["Ben"]);
      expect(await list({ passkey: false, roles: ["member"] })).toEqual(["Dora"]);
      expect(await list({ pagination: { page: 2, perPage: 3 } })).toEqual(["Dora", "Ivo"]);

      // the service checks the administrator role itself: a full account without it learns nothing
      const member = { userId: ben, uid: `dir-ben-${tag}`, roles: ["user"], provider: "local" };
      const refused = await accountsAppService.user.directory({ actor: member, search: tag });
      expect(refused.ok ? "ok" : refused.error.status).toBe(403);

      // the list costs what it cost before v2: one count and one page, whatever the filters (the FreeIPA settings
      // it reads come from the settings cache, warmed here as on every running server)
      await getFreeIpaConfig();
      const meter = await meterSql();
      try {
        const statements = await meter.during(() =>
          accountsAppService.user.directory({
            actor: admin,
            search: tag,
            roles: ["admin", "member"],
            groupIds: [sales],
            statuses: ["active"],
            lastLogin: { since: new Date(day(365)) },
            passkey: false,
            sort: { field: "lastLogin", direction: "desc" },
          }),
        );
        expect(statements).toHaveLength(2);
      } finally {
        await meter.close();
      }
    } finally {
      await sql`DELETE FROM auth.users WHERE uid LIKE ${`dir-%-${tag}`}`;
      await sql`DELETE FROM auth.personal_groups WHERE group_id = ${personal}::uuid`;
      await sql`DELETE FROM auth.groups WHERE cn LIKE ${`dir-%-${tag}`}`;
    }
  }, 60_000);

  test("lists people, agents (agent and standalone) and API key accounts (resource-bound), never personal keys or code accounts", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const day = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    // what matters today counts every account, so the test reads it before and after its own accounts
    const today = new Date(day(4));
    const summaryNow = async () => {
      const result = await accountsAppService.account.directory({
        actor: { userId: crypto.randomUUID(), uid: "acc-reader", roles: ["user", "admin"], provider: "local" },
        kinds: [],
        summary: { today },
      });
      if (!result.ok || !result.data.summary) throw new Error("no summary");
      return result.data.summary;
    };
    const before = await summaryNow();
    const user = async (name: string, values: { mail?: string | null; login?: string; admin?: boolean } = {}) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, mail, admin, last_login_local)
        VALUES (${`acc-${name.toLowerCase()}-${tag}`}, 'local', 'user', ${`${name} ${tag}`},
          ${values.mail === undefined ? `${name.toLowerCase()}-${tag}@example.test` : values.mail}, ${values.admin ?? false}, ${values.login ?? null})
        RETURNING id
      `;
      return row!.id;
    };
    const ada = await user("Ada", { admin: true, login: day(3) });
    // Jonas twice: the same address, written once with other case and spaces
    await user("Jonas", { mail: `jonas-${tag}@example.test`, login: day(20) });
    await user("Jonny", { mail: `  JONAS-${tag}@Example.test `, login: day(200) });
    await user("Noor", { mail: null });
    const service = async (name: string, kind: string, extra: { status?: string; delegated?: string; app?: boolean } = {}) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind, status, delegated_user_id, app_id, resource_type, resource_id)
        VALUES (${`${name} ${tag}`}, ${kind}, ${extra.status ?? "active"}, ${extra.delegated ?? null}::uuid,
          ${extra.app ? "spaces" : null}, ${extra.app ? "space" : null}, ${extra.app ? `space-${tag}` : null})
        RETURNING id
      `;
      return row!.id;
    };
    const bot = await service("Bot", "agent");
    const importer = await service("Importer", "standalone", { status: "disabled" });
    await service("Personal", "user_delegated", { delegated: ada });
    const space = await service("Space", "resource_bound", { app: true });
    await service("Code", "code");
    await sql`
      INSERT INTO auth.service_account_credentials (service_account_id, name, token_prefix, secret_hash, last_used_at)
      VALUES (${bot}::uuid, 'key', ${`acc-${tag}`}, 'x', ${day(1)})
    `;
    const admin = { userId: ada, uid: `acc-ada-${tag}`, roles: ["user", "admin"], provider: "local" };
    const read = async (query: Omit<Parameters<typeof accountsAppService.account.directory>[0], "search" | "actor"> = {}) => {
      const result = await accountsAppService.account.directory({ actor: admin, search: tag, ...query });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    };
    const list = (query: Parameters<typeof read>[0] = {}) =>
      read(query).then((page) =>
        page.items.map((entry) => `${entry.kind}:${(entry.kind === "person" ? entry.displayName : entry.name).split(" ")[0]}`),
      );

    try {
      const all = await read();
      expect(all.total).toBe(7);
      expect(all.items.map((entry) => `${entry.kind}:${(entry.kind === "person" ? entry.displayName : entry.name).split(" ")[0]}`)).toEqual(
        // a standalone account from before agents existed is an agent; a resource-bound one is an API key account
        ["person:Ada", "agent:Bot", "agent:Importer", "person:Jonas", "person:Jonny", "person:Noor", "api-key:Space"],
      );
      // what a service account row shows: its state, its app resource, and when one of its keys was used last
      const bots = all.items.filter((entry) => entry.kind !== "person");
      expect(bots).toMatchObject([
        { kind: "agent", id: bot, status: "active", resource: null, lastUsed: expect.any(String) },
        { kind: "agent", id: importer, status: "disabled", resource: null, lastUsed: null },
        { kind: "api-key", id: space, status: "active", resource: { appId: "spaces", type: "space", id: `space-${tag}` } },
      ]);
      // personal keys (user-delegated) and code accounts never appear, whatever the filter
      for (const kinds of [undefined, ["agent", "api-key"] as const])
        expect((await list({ kinds: kinds ? [...kinds] : undefined })).some((name) => /Personal|Code/.test(name))).toBe(false);

      expect(await list({ kinds: ["agent"] })).toEqual(["agent:Bot", "agent:Importer"]);
      expect(await list({ kinds: ["api-key"] })).toEqual(["api-key:Space"]);
      expect(await list({ statuses: ["disabled"] })).toEqual(["agent:Importer"]);
      expect(await list({ statuses: ["invited"] })).toEqual(["person:Noor"]);
      // a filter only a person has narrows the list to people
      expect(await list({ passkey: false, kinds: ["person", "agent"] })).toEqual([
        "person:Ada",
        "person:Jonas",
        "person:Jonny",
        "person:Noor",
      ]);
      // a shared address: trimmed and in any case, as the duplicate address page matched it
      expect(await list({ duplicateMail: true })).toEqual(["person:Jonas", "person:Jonny"]);
      expect((await read({ duplicateMail: true })).items.every((entry) => entry.kind === "person" && entry.duplicateMail)).toBe(true);
      expect(await list({ duplicateMail: false })).toEqual(["person:Ada", "person:Noor"]);
      expect(await list({ sort: { field: "mail", direction: "asc" } })).toEqual([
        "person:Ada",
        "person:Jonas",
        "person:Jonny",
        "agent:Bot",
        "agent:Importer",
        "person:Noor",
        "api-key:Space",
      ]);
      // last activity: a person's sign-in, an agent's last key use; never counts as the oldest
      const byActivity = await list({ sort: { field: "lastLogin", direction: "desc" } });
      expect(byActivity.slice(0, 4)).toEqual(["agent:Bot", "person:Ada", "person:Jonas", "person:Jonny"]);
      expect(byActivity.slice(4).sort()).toEqual(["agent:Importer", "api-key:Space", "person:Noor"]);
      expect(await list({ pagination: { page: 2, perPage: 4 } })).toEqual(["person:Jonny", "person:Noor", "api-key:Space"]);

      // what matters today: Ada signed in since then; Noor never did; Ada, Jonas and Jonny are active without a
      // passkey; Jonas and Jonny share one address
      const after = await summaryNow();
      expect({
        signedInToday: after.signedInToday - before.signedInToday,
        invited: after.invited - before.invited,
        expired: after.expired - before.expired,
        withoutPasskey: after.withoutPasskey - before.withoutPasskey,
        sharedAddresses: after.sharedAddresses - before.sharedAddresses,
      }).toEqual({ signedInToday: 1, invited: 1, expired: 0, withoutPasskey: 3, sharedAddresses: 1 });
      const withSummary = await accountsAppService.account.directory({ actor: admin, search: tag, summary: { today } });
      expect(withSummary.ok && withSummary.data.summary).toEqual(after);

      // the service checks the administrator role itself: a full account without it learns nothing
      const member = { userId: ada, uid: `acc-ada-${tag}`, roles: ["user"], provider: "local" };
      const refused = await accountsAppService.account.directory({ actor: member, search: tag });
      expect(refused.ok ? "ok" : refused.error.status).toBe(403);

      // one count and one page for people and service accounts together, whatever the filters
      await getFreeIpaConfig();
      const meter = await meterSql();
      try {
        const counted = [
          await meter.during(() => accountsAppService.account.directory({ actor: admin, search: tag, statuses: ["active", "disabled"] })),
          await meter.during(() => accountsAppService.account.directory({ actor: admin, kinds: ["agent", "api-key"] })),
          await meter.during(() =>
            accountsAppService.account.directory({ actor: admin, duplicateMail: true, sort: { field: "mail", direction: "asc" } }),
          ),
        ];
        // what matters today rides on the count statement: still one count and one page, and one alone when nothing can match
        counted.push(
          await meter.during(() => accountsAppService.account.directory({ actor: admin, search: tag, summary: { today } })),
          await meter.during(() => accountsAppService.account.directory({ actor: admin, kinds: [], summary: { today } })),
        );
        expect(counted.map((statements) => statements.length)).toEqual([2, 2, 2, 2, 1]);
      } finally {
        await meter.close();
      }
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE name LIKE ${`% ${tag}`}`;
      await sql`DELETE FROM auth.users WHERE uid LIKE ${`acc-%-${tag}`}`;
    }
  }, 60_000);
});
