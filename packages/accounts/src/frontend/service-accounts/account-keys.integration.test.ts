import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { accounts, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { KEYS_PER_PAGE } from "./account-keys";
import { firstKeyPage } from "./account-keys.server";

const suite = suiteFor("database", "nats", "valkey");
const context = { locale: "de", timeZone: "Europe/Berlin", now: new Date() };

suite("an account's first key page (integration)", () => {
  test("`?key=` finds a key beyond the first page with exactly one more statement, and only for its own account", async () => {
    const suffix = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid,provider,profile,admin) VALUES (${`key-page-admin-${suffix}`},'local','user',true) RETURNING id`;
    const agent = await serviceAccounts.createStandalone({ name: `Key page ${suffix}`, kind: "agent", createdBy: row!.id });
    const other = await serviceAccounts.createStandalone({ name: `Other ${suffix}`, kind: "agent", createdBy: row!.id });
    if (!agent.ok || !other.ok) throw new Error("Fixture accounts failed");
    const meter = await meterSql();
    try {
      const actor = await accounts.users.get({ id: row!.id });
      if (!actor) throw new Error("Fixture administrator missing");
      const keys: string[] = [];
      for (let index = 0; index < KEYS_PER_PAGE + 2; index++) {
        const key = await serviceAccountCredentials.createStandaloneApiToken({
          actor,
          serviceAccountId: agent.data.id,
          name: `Gerät ${index + 1}`,
        });
        if (!key.ok) throw new Error("Fixture key failed");
        keys.push(key.data.credential.id);
      }
      const foreign = await serviceAccountCredentials.createStandaloneApiToken({ actor, serviceAccountId: other.data.id, name: "Fremd" });
      if (!foreign.ok) throw new Error("Fixture key failed");
      // the newest first: the oldest key stands on the second page
      const deep = keys[0]!;
      const owner = { kind: "agent" as const, id: agent.data.id };

      let plain: Awaited<ReturnType<typeof firstKeyPage>> = null;
      const without = await meter.during(async () => {
        plain = await firstKeyPage(owner, context);
      });
      expect(plain!.keys.map((key) => key.id)).not.toContain(deep);
      expect(plain!.open).toBeUndefined();

      let opened: Awaited<ReturnType<typeof firstKeyPage>> = null;
      const withKey = await meter.during(async () => {
        opened = await firstKeyPage(owner, context, deep);
      });
      expect(withKey).toHaveLength(without.length + 1);
      expect(opened!.open).toMatchObject({ id: deep, name: "Gerät 1", active: true });
      expect(opened!.total).toBe(KEYS_PER_PAGE + 2);

      // another account's key, an unknown id and "new" are no key of this account
      expect((await firstKeyPage(owner, context, foreign.data.credential.id))!.open).toBeNull();
      expect((await firstKeyPage(owner, context, crypto.randomUUID()))!.open).toBeNull();
      const fresh = await meter.during(async () => {
        expect((await firstKeyPage(owner, context, "new"))!.open).toBeUndefined();
      });
      expect(fresh).toHaveLength(without.length);
    } finally {
      await meter.close();
      await sql`DELETE FROM auth.service_accounts WHERE id IN (${agent.data.id}::uuid, ${other.data.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id=${row!.id}::uuid`;
    }
  });
});
