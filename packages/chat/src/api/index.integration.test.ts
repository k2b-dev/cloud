import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { migrate } from "../migrate";
import { chatService } from "../service";
import chatApi from ".";

const suite = suiteFor("database", "nats");
setDefaultTimeout(30_000);

suite("chat skeleton", () => {
  const accountIds: string[] = [];

  beforeAll(async () => {
    // Setup runs on every start; a second run must change nothing.
    await migrate();
    await migrate();
  });

  afterAll(async () => {
    for (const id of accountIds) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
  });

  test("reports a healthy database once the chat schema exists", async () => {
    const health = await chatService.health();
    expect(health.status).toBe("ok");
    expect(health.database.status).toBe("ok");
    expect(health.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(health.observedAt))).toBeFalse();
  });

  test("keeps the health endpoint for administrators", async () => {
    expect((await chatApi.request("/admin/health")).status).toBe(401);

    const [account] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`Chat test ${crypto.randomUUID().slice(0, 8)}`}, 'standalone') RETURNING id`;
    accountIds.push(account!.id);
    const created = await serviceAccountCredentials.createApiToken({
      serviceAccountId: account!.id,
      name: "chat test",
      scopes: ["openid", "read"],
    });
    if (!created.ok) throw new Error(created.error.message);
    const response = await chatApi.request("/admin/health", { headers: { authorization: `Bearer ${created.data.token}` } });
    expect(response.status).toBe(403);
  });
});
