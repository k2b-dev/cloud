import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../scripts/fixtures/test-infra";

let pulseCapabilities: typeof import("./capabilities")["pulseCapabilities"];
let migrate: typeof import("./migrate")["migrate"];
let lifecycle: typeof import("./service/base-lifecycle");
let clearBaseData: typeof import("./service/base-management")["clearBaseData"];
let deleteBase: typeof import("./service/base-management")["deleteBase"];
let settingsFixture: typeof import("./store/settings.test-fixture")["settingsFixture"];

suiteFor("database")("agent base actions enforce current policy, grants and revisions", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let settings: ReturnType<typeof settingsFixture>;
  beforeAll(async () => {
    database = await useFreshDatabase("pulse_agent_actions");
    // Domain singletons may capture Bun.sql during import; bind the disposable database first.
    ({ pulseCapabilities } = await import("./capabilities"));
    ({ migrate } = await import("./migrate"));
    lifecycle = await import("./service/base-lifecycle");
    ({ clearBaseData, deleteBase } = await import("./service/base-management"));
    ({ settingsFixture } = await import("./store/settings.test-fixture"));
    await (await import("../../core/src/runtime-helpers")).runCoreSetup();
    settings = settingsFixture();
    settings.values["pulse.clickhouse_connection"] = JSON.stringify({ url: "http://127.0.0.1:1", user: "fixture", password: "fixture" });
    await migrate();
  }, 30_000);
  afterAll(async () => {
    settings?.restore();
    await sql.close();
    await database?.drop();
  });

  test("agent creates a base as its admin; changed review state and revoked grants stop destruction", async () => {
    const agentId = "c1111111-1111-4111-8111-111111111111";
    await sql`INSERT INTO auth.service_accounts(id,name,kind) VALUES(${agentId}::uuid,'Willow agent','agent')`;
    const context: CapabilityExecutionContext = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: agentId,
          name: "Willow agent",
          kind: "agent",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-10-20T12:00:00Z",
        },
        delegatedUser: null,
        scopes: ["admin"],
      },
      accessSubject: { type: "service_account", serviceAccountId: agentId },
      user: null,
      locale: "en",
      requestId: "agent-base-actions",
      origin: "assistant",
      signal: new AbortController().signal,
      idempotencyKey: "create-willow-base",
    };
    const queued = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    const input = { name: "Willow telemetry", description: "Fictional backend traffic" };
    const creation = pulseCapabilities.actions["base.create"];
    try {
      settings.values["pulse.base_creation"] = "people";
      expect(await creation.review(input, context)).toMatchObject({ ok: false, error: { status: 403 } });
      expect(await creation.run(input, context)).toMatchObject({ ok: false, error: { status: 403 } });
      settings.values["pulse.base_creation"] = "everyone";
      const review = await creation.review(input, context);
      expect(review).toEqual(await creation.review(input, context));
      expect(review).toMatchObject({ ok: true, data: { approvalScope: "pulse:base:create" } });
      const made = await creation.run(input, context);
      if (!made.ok) throw new Error(made.error.message);
      const [base] = await sql<{ id: string }[]>`SELECT id FROM pulse.bases WHERE short_id=${made.data.data.id}`;
      expect(
        await sql<
          { permission: string }[]
        >`SELECT permission FROM auth.access a JOIN pulse.base_access ba ON ba.access_id=a.id WHERE ba.base_id=${base!.id}::uuid AND a.service_account_id=${agentId}::uuid`,
      ).toEqual([{ permission: "admin" }]);
      await sql`UPDATE pulse.base_stores SET state='active',operation=NULL WHERE base_id=${base!.id}::uuid`;
      await sql`UPDATE pulse.bases SET updated_at='2026-10-20T12:00:00.123456Z' WHERE id=${base!.id}::uuid`;
      const read = await pulseCapabilities.queries["base.read"].run({ id: made.data.data.id }, context);
      if (!read.ok) throw new Error(read.error.message);
      expect(read.data.data.updatedAt).toBe("2026-10-20T12:00:00.123456Z");
      const destroy = { baseId: made.data.data.id, expectedUpdatedAt: read.data.data.updatedAt };
      for (const name of ["base.clear_data", "base.delete"] as const) {
        const action = pulseCapabilities.actions[name];
        const review = await action.review(destroy, context);
        expect(review).toEqual(await action.review(destroy, context));
        expect(review.ok && "approvalScope" in review.data).toBe(false);
        await sql`UPDATE auth.access SET permission='write' WHERE service_account_id=${agentId}::uuid`;
        expect(await action.run(destroy, context)).toMatchObject({ ok: false, error: { status: 403 } });
        await sql`UPDATE auth.access SET permission='admin' WHERE service_account_id=${agentId}::uuid`;
      }
      // A change smaller than a JS millisecond must still invalidate the approved revision.
      await sql`UPDATE pulse.bases SET updated_at='2026-10-20T12:00:00.123457Z' WHERE id=${base!.id}::uuid`;
      for (const name of ["base.clear_data", "base.delete"] as const) {
        expect(await pulseCapabilities.actions[name].review(destroy, context)).toMatchObject({ ok: false, error: { status: 409 } });
        expect(await pulseCapabilities.actions[name].run(destroy, context)).toMatchObject({ ok: false, error: { status: 409 } });
      }
      const user = {
        subject: { type: "service_account" as const, serviceAccountId: agentId },
        serviceAccount: { kind: "agent" as const, appId: null, resourceType: null, resourceId: null },
        scopes: ["admin"],
      };
      for (const operation of [clearBaseData, deleteBase]) {
        expect(await operation({ baseId: base!.id, user, expectedUpdatedAt: destroy.expectedUpdatedAt })).toMatchObject({
          ok: false,
          error: { status: 409 },
        });
      }
      // Exercise the real lifecycle service through the Action; no background process is started.
      const fresh = { ...destroy, expectedUpdatedAt: "2026-10-20T12:00:00.123457Z" };
      expect(await pulseCapabilities.actions["base.clear_data"].run(fresh, context)).toMatchObject({
        ok: true,
        data: { data: { started: true } },
      });
      expect((await sql`SELECT state FROM pulse.base_stores WHERE base_id=${base!.id}::uuid`)[0]?.state).toBe("clearing");
      const reread = await pulseCapabilities.queries["base.read"].run({ id: made.data.data.id }, context);
      if (!reread.ok) throw new Error(reread.error.message);
      expect(
        await pulseCapabilities.actions["base.delete"].run({ ...fresh, expectedUpdatedAt: reread.data.data.updatedAt }, context),
      ).toMatchObject({ ok: true, data: { data: { started: true } } });
      expect((await sql`SELECT state FROM pulse.base_stores WHERE base_id=${base!.id}::uuid`)[0]?.state).toBe("deleting");
      await sql`DELETE FROM auth.access WHERE id IN(SELECT access_id FROM pulse.base_access WHERE base_id=${base!.id}::uuid)`;
      await sql`DELETE FROM pulse.bases WHERE id=${base!.id}::uuid`;
    } finally {
      queued.mockRestore();
      await sql`DELETE FROM auth.service_accounts WHERE id=${agentId}::uuid`;
    }
  });
});
