import { expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import accountsCli from "../cli";
import groups from "./groups";

suiteFor(
  "database",
  "valkey",
  "nats",
)("personal-group exports through API and CLI", () => {
  test("all list scopes, legacy query flags, exact group IDs and CLI JSON exclude personal groups", async () => {
    const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
      VALUES('export_personal_fixture','local','user',true) RETURNING id`;
    const [personal] = await sql<{ id: string }[]>`INSERT INTO auth.groups(cn,name,provider,gid_number)
      VALUES('local:export_personal_fixture','export_personal_fixture','local',1500003) RETURNING id`;
    const [team] = await sql<{ id: string }[]>`INSERT INTO auth.groups(cn,name,provider)
      VALUES('local:export_personal_team','export_personal_team','local') RETURNING id`;
    try {
      await sql`INSERT INTO auth.user_groups_v2 VALUES(${owner!.id}::uuid,${personal!.id}::uuid)`;
      await sql`INSERT INTO auth.group_groups_v2 VALUES(${team!.id}::uuid,${personal!.id}::uuid)`;
      await sql`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,primary_group_id,home_directory,login_shell)
        VALUES(${owner!.id}::uuid,'local',1500003,1500003,${personal!.id}::uuid,'/home/fixture','/bin/bash')`;
      const headers = { cookie: `session_token=${await createTestSession(owner!.id)}`, "x-forwarded-for": uniqueCallerAddress() };
      const routes = new Hono().route("/api/accounts/groups", groups);
      for (const scope of ["all", "member", "managed"]) {
        const response = await routes.request(`/api/accounts/groups?scope=${scope}&search=export_personal&include_personal=true`, {
          headers,
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.groups.map((group: { id: string }) => group.id)).toEqual(scope === "managed" ? [] : [team!.id]);
        expect(body.pagination.total).toBe(scope === "managed" ? 0 : 1);
      }
      for (const relation of ["members", "managers"]) {
        const response = await routes.request(`/api/accounts/groups/${team!.id}/${relation}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ type: "group", id: personal!.id }),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ message: "Personal Linux groups cannot be used in group relationships" });
      }
      for (const relation of ["members", "managers"]) {
        for (const principal of [
          { type: "user", id: owner!.id },
          { type: "group", id: team!.id },
        ]) {
          const response = await routes.request(`/api/accounts/groups/${personal!.id}/${relation}`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(principal),
          });
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ message: "Personal Linux groups cannot be used in group relationships" });
        }
      }
      const output: unknown[] = [];
      const ctx: CloudCliContext = {
        args: ["groups", "list"],
        flags: { scope: "all", search: "export_personal" },
        options: { profile: "test", server: "http://cloud.test", token: "fixture", output: "json" },
        getDefault: async () => undefined,
        setDefault: async () => undefined,
        createApiClient: () => {
          throw new Error("Unused typed client");
        },
        fetch: async (path, init) => routes.request(path, { ...init, headers }),
        readJson: async (response) => {
          if (!response.ok) throw new Error(`Export failed: ${response.status}`);
          return response.json();
        },
        print: () => {},
        write: async () => {},
        error: () => {},
        table: () => {},
        json: (value) => output.push(value),
        jsonLine: (value) => output.push(value),
      };
      await accountsCli.run(ctx);
      expect(output).toEqual([expect.objectContaining({ groups: [expect.objectContaining({ id: team!.id })] })]);
      ctx.args = ["groups", "get", "export_personal_fixture"];
      ctx.flags = {};
      await expect(accountsCli.run(ctx)).rejects.toThrow("was not found");
      expect(output).toHaveLength(1);
      for (const relation of ["members", "managers"]) {
        await sql`INSERT INTO auth.group_manager_groups_v2(group_id,manager_group_id)
          VALUES(${team!.id}::uuid,${personal!.id}::uuid) ON CONFLICT DO NOTHING`;
        ctx.args = ["groups", relation, "remove", team!.id];
        ctx.flags = { group: personal!.id, yes: true };
        await accountsCli.run(ctx);
      }
      expect(
        await sql`SELECT 1 FROM auth.group_groups_v2 WHERE parent_group_id=${team!.id}::uuid AND child_group_id=${personal!.id}::uuid`,
      ).toHaveLength(0);
      expect(
        await sql`SELECT 1 FROM auth.group_manager_groups_v2 WHERE group_id=${team!.id}::uuid AND manager_group_id=${personal!.id}::uuid`,
      ).toHaveLength(0);
      await sql`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES(${personal!.id}::uuid,${team!.id}::uuid)`;
      ctx.args = ["groups", "members", "remove", personal!.id];
      ctx.flags = { group: team!.id, yes: true };
      await accountsCli.run(ctx);
      expect(await sql`SELECT 1 FROM auth.group_groups_v2 WHERE parent_group_id=${personal!.id}::uuid`).toHaveLength(0);
    } finally {
      await sql`DELETE FROM auth.user_posix WHERE user_id=${owner!.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${personal!.id}::uuid,${team!.id}::uuid)`;
      await sql`DELETE FROM auth.personal_groups WHERE group_id=${personal!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${owner!.id}::uuid`;
    }
  });
});
