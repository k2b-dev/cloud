import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listUsableSummaries } from "./custom-apps";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("usable custom apps across bases", () => {
  postgresTest("authorizes by app use grants, never by base access, and respects the limit", async () => {
    const [appUserId, outsiderId, deniedUserId] = [testUuid(), testUuid(), testUuid()];
    const baseId = testUuid();
    const [alphaId, betaId, gammaId, draftId, openId] = [testUuid(), testUuid(), testUuid(), testUuid(), testUuid()];
    const accessIds: string[] = [];
    const grant = async (appId: string, principal: { userId?: string; authenticated?: boolean }, permission: string) => {
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (user_id, authenticated_only, permission)
        VALUES (${principal.userId ?? null}::uuid, ${principal.authenticated ?? false}, ${permission})
        RETURNING id::text AS id
      `;
      if (!access) throw new Error("Failed to create access fixture");
      accessIds.push(access.id);
      await sql`INSERT INTO grids.custom_app_access (custom_app_id, access_id) VALUES (${appId}::uuid, ${access.id}::uuid)`;
    };
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
          (${appUserId}::uuid, ${`app-user-${appUserId}`}, 'local', 'user', 'App user', 'App', 'User'),
          (${outsiderId}::uuid, ${`outsider-${outsiderId}`}, 'local', 'user', 'Outsider', 'Out', 'Sider'),
          (${deniedUserId}::uuid, ${`denied-${deniedUserId}`}, 'local', 'user', 'Denied user', 'Denied', 'User')
      `;
      // Nobody in this test has any base grant.
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Loan office')`;
      await sql`
        INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition, published_definition, published_at)
        VALUES
          (${alphaId}::uuid, ${testShortId("A")}, ${baseId}::uuid, 'Alpha desk', '{}'::jsonb, '{}'::jsonb, now()),
          (${betaId}::uuid, ${testShortId("B")}, ${baseId}::uuid, 'Beta desk', '{}'::jsonb, '{}'::jsonb, now()),
          (${gammaId}::uuid, ${testShortId("G")}, ${baseId}::uuid, 'Gamma desk', '{}'::jsonb, '{}'::jsonb, now()),
          (${draftId}::uuid, ${testShortId("D")}, ${baseId}::uuid, 'Draft desk', '{}'::jsonb, NULL, NULL),
          (${openId}::uuid, ${testShortId("O")}, ${baseId}::uuid, 'Open desk', '{}'::jsonb, '{}'::jsonb, now())
      `;
      for (const appId of [alphaId, betaId, gammaId, draftId]) await grant(appId, { userId: appUserId }, "read");
      // An authenticated grant opens the app to everyone except a user whose own tier denies it.
      await grant(openId, { authenticated: true }, "read");
      await grant(openId, { userId: deniedUserId }, "none");

      const mine = (items: { id: string }[]) =>
        items.map((item) => item.id).filter((id) => [alphaId, betaId, gammaId, draftId, openId].includes(id));

      const appUser = await listUsableSummaries({ subject: { type: "user", userId: appUserId }, limit: 50 });
      expect(mine(appUser.items)).toEqual([alphaId, betaId, gammaId, openId]);
      expect(appUser.items.find((item) => item.id === alphaId)?.baseName).toBe("Loan office");

      const limited = await listUsableSummaries({ subject: { type: "user", userId: appUserId }, limit: 2 });
      expect(limited.items).toHaveLength(2);
      expect(limited.total).toBeGreaterThanOrEqual(4);

      expect(mine((await listUsableSummaries({ subject: { type: "user", userId: outsiderId }, limit: 50 })).items)).toEqual([openId]);
      expect(mine((await listUsableSummaries({ subject: { type: "user", userId: deniedUserId }, limit: 50 })).items)).toEqual([]);
      expect(mine((await listUsableSummaries({ subject: null, limit: 50 })).items)).toEqual([]);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      if (accessIds.length > 0) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
      await sql`DELETE FROM auth.users WHERE id IN (${appUserId}::uuid, ${outsiderId}::uuid, ${deniedUserId}::uuid)`;
    }
  });
});
