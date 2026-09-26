import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { serviceAccounts } from "./service-accounts";

const suite = databaseSuite();

suite("standalone service accounts (integration)", () => {
  test("creates unbound principals of kind standalone or agent with a unique name and lists them apart from bound accounts", async () => {
    const suffix = crypto.randomUUID();
    const created: string[] = [];
    try {
      const agent = await serviceAccounts.createStandalone({ name: `Release agent ${suffix}`, kind: "agent" });
      expect(agent.ok).toBe(true);
      if (!agent.ok) return;
      created.push(agent.data.id);
      expect(agent.data).toMatchObject({
        kind: "agent",
        status: "active",
        delegatedUserId: null,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: null,
      });

      const integration = await serviceAccounts.createStandalone({ name: `Integration ${suffix}`, kind: "standalone" });
      expect(integration.ok).toBe(true);
      if (integration.ok) created.push(integration.data.id);

      const duplicate = await serviceAccounts.createStandalone({ name: `release AGENT ${suffix}`, kind: "standalone" });
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) expect(duplicate.error.code).toBe("CONFLICT");

      const bound = await serviceAccounts.createResourceBound({
        name: `Release agent ${suffix}`,
        appId: "sa-test",
        resourceType: "fixture",
        resourceId: suffix,
      });
      expect(bound.ok).toBe(true);
      if (bound.ok) created.push(bound.data.id);

      const agents = await serviceAccounts.listStandalone({ kind: "agent", search: suffix });
      expect(agents.items.map((item) => item.id)).toEqual([agent.data.id]);
      const all = await serviceAccounts.listStandalone({ search: suffix });
      expect(all.total).toBe(2);
      expect(all.items.map((item) => item.kind).sort()).toEqual(["agent", "standalone"]);

      // The database rejects a standalone account that smuggles a binding.
      await expect(
        (async () => {
          await sql`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id) VALUES (${`Bad ${suffix}`}, 'agent', 'x', 'y', 'z')`;
        })(),
      ).rejects.toThrow();

      const disabled = await serviceAccounts.setStatus({ id: agent.data.id, status: "disabled" });
      expect(disabled.ok).toBe(true);
      const disabledOnly = await serviceAccounts.listStandalone({ status: "disabled", search: suffix });
      expect(disabledOnly.items.map((item) => item.id)).toEqual([agent.data.id]);
    } finally {
      for (const id of created) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });
});
