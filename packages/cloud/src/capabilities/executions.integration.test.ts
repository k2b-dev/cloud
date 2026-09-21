import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import {
  listCapabilityExecutions,
  migrateCloudCapabilities,
  pruneCapabilityExecutions,
  recordCapabilityExecution,
  summarizeCapabilityExecutions,
} from "./executions";

const suite = databaseSuite();
beforeAll(async () => {
  if (!testInfra.database) return;
  await migrateCloudCapabilities();
});

const at = (minutesAgo: number): Date => new Date(Date.now() - minutesAgo * 60_000);

suite("capability execution store", () => {
  test("records, filters, summarizes, and prunes execution history", async () => {
    const requestId = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`caps-${requestId.slice(0, 8)}`}, 'local', 'user', 'Ada') RETURNING id
    `;
    const userId = user!.id;
    try {
      const succeeded = await recordCapabilityExecution({
        requestId,
        origin: "assistant",
        appId: "contacts",
        capability: "contacts.list",
        kind: "query",
        destructive: false,
        actorKind: "user",
        actorId: userId,
        userId,
        status: "succeeded",
        inputMeta: { type: "object", keys: ["query"], omittedKeys: 0 },
        outputMeta: { type: "array", length: 3 },
        startedAt: at(1),
        completedAt: new Date(at(1).getTime() + 40),
      });
      await recordCapabilityExecution({
        requestId: crypto.randomUUID(),
        origin: "mcp",
        appId: "mail",
        capability: "mail.send",
        kind: "action",
        destructive: true,
        actorKind: "user",
        actorId: userId,
        userId,
        status: "denied",
        errorCode: "FORBIDDEN",
        idempotencyKey: "mail-1",
        startedAt: at(2),
        completedAt: at(2),
      });
      await recordCapabilityExecution({
        requestId: crypto.randomUUID(),
        origin: "http",
        appId: "mail",
        capability: "mail.list",
        kind: "query",
        destructive: false,
        status: "failed",
        errorCode: "APP_UNAVAILABLE",
        startedAt: at(200_000),
        completedAt: at(200_000),
      });

      const all = await listCapabilityExecutions({ limit: 10 });
      expect(all.items[0]?.id).toBe(succeeded);
      expect(all.items.map((row) => row.capability)).toEqual(["contacts.list", "mail.send", "mail.list"]);
      expect(all.items[0]).toMatchObject({ origin: "assistant", status: "succeeded", outputMeta: { type: "array", length: 3 } });

      expect((await listCapabilityExecutions({ appId: "mail" })).items).toHaveLength(2);
      expect((await listCapabilityExecutions({ origin: "mcp" })).items.map((row) => row.capability)).toEqual(["mail.send"]);
      expect((await listCapabilityExecutions({ destructive: true })).items.map((row) => row.status)).toEqual(["denied"]);
      expect((await listCapabilityExecutions({ requestId })).items.map((row) => row.capability)).toEqual(["contacts.list"]);
      expect((await listCapabilityExecutions({ userId })).items).toHaveLength(2);
      expect((await listCapabilityExecutions({ since: at(10) })).items).toHaveLength(2);

      const firstPage = await listCapabilityExecutions({ limit: 1 });
      expect(firstPage.nextCursor).toBeString();
      const secondPage = await listCapabilityExecutions({ limit: 1, cursor: firstPage.nextCursor });
      expect(secondPage.items.map((row) => row.capability)).toEqual(["mail.send"]);

      const summary = await summarizeCapabilityExecutions({ since: at(10) });
      expect(summary).toMatchObject({ executions: 2, failed: 0, denied: 1, destructive: 1 });
      expect(summary.avgDurationMs).toBeGreaterThanOrEqual(0);
      expect(summary.apps.map((row) => row.id).toSorted()).toEqual(["contacts", "mail"]);
      expect(summary.capabilities.find((row) => row.id === "mail.send")).toMatchObject({ executions: 1, denied: 1 });

      expect(await pruneCapabilityExecutions(at(1000))).toBe(1);
      expect((await listCapabilityExecutions()).items.map((row) => row.capability)).toEqual(["contacts.list", "mail.send"]);
    } finally {
      await sql`DELETE FROM capabilities.executions`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
