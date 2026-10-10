import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import { getFreeIpaConfig } from "@k2b/cloud/services";
import { registerNotificationDefinitions } from "@k2b/cloud/services/notifications/catalog";
import * as platform from "@k2b/cloud/services/notifications/platform";
import * as deliveryRuntime from "@k2b/cloud/services/notifications/runtime";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { createAiNotificationService } from "./ai-notifications";
import { app } from "./config";
import { runCoreSetup } from "./runtime-helpers";

// Recovery crosses every cost alert with every admin in the database. On the shared
// integration database that fans out to the admins and alerts of every other test,
// including leftovers of aborted runs, so this suite owns a private database: it sees
// only its own rows, and dropping the database cleans up even after a timeout.
suiteFor("database", "valkey")("background cost alert recovery", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
  beforeAll(async () => {
    fresh = await useFreshDatabase("core_cost_alerts");
    await runCoreSetup();
    await registerNotificationDefinitions(app.meta.id, app.notifications);
  });
  afterAll(async () => {
    await fresh?.drop();
  });

  test("sends only to current local and IPA admins; partial delivery retries do not duplicate events", async () => {
    const enqueue = spyOn(deliveryRuntime, "enqueueNotificationDeliveries").mockResolvedValue();
    const enqueueOne = spyOn(deliveryRuntime, "enqueueNotificationDelivery").mockResolvedValue();
    let recover: ((context: { runId: string }) => Promise<void>) | undefined;
    const scheduler = {
      create: async (input: { process: (context: { runId: string }) => Promise<void> }) => {
        recover = input.process;
      },
      process: async () => ({ stop: () => {}, drain: async () => {} }),
    };
    // Keep the existing recovery callback and real notification persistence, only isolate its scheduler transport.
    const lazy = spyOn(cloud, "lazySync").mockReturnValue(() => scheduler);
    const service = createAiNotificationService(app.notifications);
    const users = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,admin)
      VALUES('local-admin','local','user','Cost local admin',true),
        ('local-user','local','user','Cost local user',false),
        ('ipa-admin','ipa','user','Cost IPA admin',false),
        ('ipa-not-admin','ipa','user','Cost IPA member',false)
      RETURNING id,uid`;
    const localAdmin = users.find((user) => user.uid === "local-admin")!;
    const ipaAdmin = users.find((user) => user.uid === "ipa-admin")!;
    const adminGroup = (await getFreeIpaConfig()).groupsAdmin[0]!;
    await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${ipaAdmin.id}::uuid,${adminGroup})`;
    await sql`INSERT INTO ai.cost_alerts(id,kind,cost,unit) VALUES(${crypto.randomUUID()}::uuid,'warning',2.5,'EUR'),(${crypto.randomUUID()}::uuid,'stop',5,'EUR')`;
    let sendFailure: ReturnType<typeof spyOn<typeof platform, "sendTypedNotification">> | undefined;
    try {
      await service.start();
      if (!recover) throw new Error("Recovery scheduler callback was not registered.");
      const send = platform.sendTypedNotification;
      let sends = 0;
      // The first notification is stored, the second fails: the retry must finish the rest without duplicating the first.
      sendFailure = spyOn(platform, "sendTypedNotification").mockImplementation((definition, input) => {
        sends += 1;
        if (sends !== 2) return send(definition, input);
        return Promise.reject(new Error("Injected recoverable notification failure"));
      });
      await expect(recover({ runId: crypto.randomUUID() })).rejects.toThrow("Injected recoverable notification failure");
      sendFailure.mockRestore();
      sendFailure = undefined;
      await recover({ runId: crypto.randomUUID() });
      await recover({ runId: crypto.randomUUID() });
      const events = await sql<{ recipient_user_id: string; idempotency_key: string; title: string; target_href: string }[]>`
        SELECT recipient_user_id,idempotency_key,title,target_href FROM notifications.events
        WHERE definition_id=${app.notifications.backgroundCosts.id}`;
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.recipient_user_id).sort()).toEqual(
        [localAdmin.id, localAdmin.id, ipaAdmin.id, ipaAdmin.id].sort(),
      );
      expect(new Set(events.map((event) => event.idempotency_key)).size).toBe(4);
      expect(events.every((event) => event.target_href === "/admin/settings?tab=ai-quotas&view=rules")).toBe(true);
      expect(events.map((event) => event.title).sort()).toEqual(
        ["Background AI cost warning", "Background AI cost warning", "Background AI stopped", "Background AI stopped"].sort(),
      );
      const deliveries = await sql<{ channel: string; status: string; error_code: string | null }[]>`
        SELECT d.channel,d.status,d.error_code FROM notifications.deliveries d
        JOIN notifications.events e ON e.id=d.event_id WHERE e.definition_id=${app.notifications.backgroundCosts.id}`;
      expect(deliveries).toHaveLength(4);
      expect(
        deliveries.every(
          (delivery) => delivery.channel === "browser" && delivery.status === "suppressed" && delivery.error_code === "no_endpoint",
        ),
      ).toBe(true);
    } finally {
      sendFailure?.mockRestore();
      await service.stop();
      lazy.mockRestore();
      enqueue.mockRestore();
      enqueueOne.mockRestore();
    }
  });
});
