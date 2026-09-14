import { expect, test } from "bun:test";
import { UpdateDashboardSchema } from "../../api/schemas";
import type { PulseDashboard } from "../../contracts";
import { savePulseDashboardConfig } from "./dashboard-actions";

test("dashboard save sends source only through the strict API boundary", async () => {
  const original = globalThis.fetch;
  const config = { dsl: 'dashboard "Ops" {}', refreshIntervalSeconds: 5 as const, layout: { version: 1 as const, sections: [] } };
  const dashboard: PulseDashboard = {
    id: "Dash01",
    baseId: "Base01",
    name: "Ops",
    config,
    publicEnabled: false,
    createdAt: "",
    updatedAt: "",
  };
  globalThis.fetch = Object.assign(
    async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(UpdateDashboardSchema.safeParse(body).success).toBe(true);
      expect(body.config).toEqual({ dsl: config.dsl, refreshIntervalSeconds: 5 });
      return Response.json(dashboard);
    },
    { preconnect: original.preconnect },
  );
  try {
    await savePulseDashboardConfig(dashboard, config);
  } finally {
    globalThis.fetch = original;
  }
});
