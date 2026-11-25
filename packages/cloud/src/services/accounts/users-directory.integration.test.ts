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
    const user = async (name: string, values: { profile?: "user" | "guest"; admin?: boolean; login?: string; expires?: string }) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, mail, admin, last_login_local, account_expires)
        VALUES (${`dir-${name.toLowerCase()}-${tag}`}, 'local', ${values.profile ?? "user"}, ${`${name} ${tag}`},
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
    const list = (query: Omit<Parameters<typeof accountsAppService.user.directory>[0], "search"> = {}) =>
      accountsAppService.user
        .directory({ search: tag, ...query })
        .then((page) => page.items.map((entry) => entry.displayName.split(" ")[0]));

    try {
      // what a row shows: role, state, groups without the personal one, the passkey
      const all = await accountsAppService.user.directory({ search: tag });
      expect(all.total).toBe(4);
      const byName: Record<string, UserDirectoryEntry> = Object.fromEntries(all.items.map((entry) => [entry.displayName.split(" ")[0], entry]));
      expect(byName.Ada).toMatchObject({ role: "admin", status: "active", passkey: false, groupCount: 2 });
      expect(byName.Ada!.groups.map((entry) => entry.name)).toEqual([`board ${tag}`, `sales ${tag}`]);
      expect(byName.Ben).toMatchObject({ role: "member", status: "active", passkey: true, groupCount: 1 });
      expect(byName.Cleo).toMatchObject({ role: "guest", status: "invited", lastLogin: null, groups: [] });
      expect(byName.Dora).toMatchObject({ role: "member", status: "expired" });

      expect(await list()).toEqual(["Ada", "Ben", "Cleo", "Dora"]);
      expect(await list({ sort: { field: "name", direction: "desc" } })).toEqual(["Dora", "Cleo", "Ben", "Ada"]);
      expect(await list({ sort: { field: "lastLogin", direction: "desc" } })).toEqual(["Ada", "Dora", "Ben", "Cleo"]);
      expect(await list({ sort: { field: "lastLogin", direction: "asc" } })).toEqual(["Cleo", "Ben", "Dora", "Ada"]);
      expect(await list({ roles: ["admin", "guest"] })).toEqual(["Ada", "Cleo"]);
      expect(await list({ roles: ["member"] })).toEqual(["Ben", "Dora"]);
      expect(await list({ groupIds: [board] })).toEqual(["Ada"]);
      expect(await list({ groupIds: [sales, board] })).toEqual(["Ada", "Ben"]);
      expect(await list({ statuses: ["invited", "expired"] })).toEqual(["Cleo", "Dora"]);
      expect(await list({ lastLogin: "never" })).toEqual(["Cleo"]);
      expect(await list({ lastLogin: { since: new Date(day(30)) } })).toEqual(["Ada"]);
      expect(await list({ lastLogin: { until: new Date(day(90)) } })).toEqual(["Ben"]);
      expect(await list({ passkey: true })).toEqual(["Ben"]);
      expect(await list({ passkey: false, roles: ["member"] })).toEqual(["Dora"]);
      expect(await list({ pagination: { page: 2, perPage: 3 } })).toEqual(["Dora"]);

      // the list costs what it cost before v2: one count and one page, whatever the filters (the FreeIPA settings
      // it reads come from the settings cache, warmed here as on every running server)
      await getFreeIpaConfig();
      const meter = await meterSql();
      try {
        const statements = await meter.during(() =>
          accountsAppService.user.directory({
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
});
