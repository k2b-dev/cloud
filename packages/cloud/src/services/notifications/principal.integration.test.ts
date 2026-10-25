import { expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { defineApp, notification } from "../..";
import { notificationRoutes } from "../../api/notifications";
import { NotificationInboxContentSchema } from "../../contracts/notification-inbox";
import type { RequestAuthority } from "../../server/middleware/auth";
import { decryptSecret } from "../secrets";
import { createApiToken } from "../service-account-credentials";
import { serviceAccounts } from "../service-accounts";
import * as settings from "../settings";
import { notifications } from ".";
import { getNotificationChannel } from "./channels";
import { processNotificationDelivery, recoverNotificationDeliveries } from "./dispatcher";

const suite = suiteFor("database", "nats", "valkey");
const app = defineApp({
  id: "principal-notification-test",
  name: "Principal notices",
  icon: "ti ti-bell",
  description: "Principal notification integration fixture.",
  baseUrl: "http://principal-notification-test:3000",
  routes: ["/principal-notification-test"],
  notifications: {
    changed: notification({
      recipient: "principal",
      label: "Changed",
      description: "An assignment changed.",
      data: z.object({ body: z.string() }),
      delivery: { recommended: ["browser", "email", "inbox"] },
      render: ({ body }) => ({ title: "Assignment changed", body, preview: "Browser preview only", targetHref: "/app/example/task" }),
    }),
    empty: notification({
      recipient: "principal",
      label: "Empty",
      description: "No delivery policy.",
      data: z.object({}),
      render: () => ({ title: "No channels" }),
    }),
    required: notification({
      recipient: "principal",
      label: "Required inbox",
      description: "Synchronous inbox acceptance.",
      data: z.object({}),
      delivery: { required: ["inbox"] },
      render: () => ({ title: "Required inbox", body: "Private required content" }),
    }),
  },
});

suite("principal notifications and own inbox", () => {
  test("isolates people and independent agents; keeps encrypted, durable, idempotent content across retries and reads", async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    const suffix = crypto.randomUUID();
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name, mail)
      VALUES (${`principal-person-${suffix}`}, 'local', 'user', 'Creator', ${`creator-${suffix}@example.test`}) RETURNING id
    `;
    const userId = person!.id;
    const ids: string[] = [];
    const create = async (kind: "agent" | "standalone") => {
      const result = await serviceAccounts.createStandalone({ name: `principal-${kind}-${suffix}`, kind, createdBy: userId });
      if (!result.ok) throw new Error(result.error.message);
      ids.push(result.data.id);
      return result.data;
    };
    const agent = await create("agent");
    const other = await create("standalone");
    const authority: RequestAuthority = {
      actor: { kind: "service_account", serviceAccount: agent, delegatedUser: null, scopes: ["read"] },
      accessSubject: { type: "service_account", serviceAccountId: agent.id },
      credentialKind: "api_key",
      scopes: ["read"],
    };
    const read = () => notifications.inbox.list({ authority });
    const router = new Hono().route("/api/notifications", notificationRoutes);
    const call = (token: string, query = "") =>
      router.request(`/api/notifications/inbox${query}`, { headers: { authorization: `Bearer ${token}` } });
    const token = async (serviceAccountId: string, scopes: string[] = ["read"]) => {
      const result = await createApiToken({ serviceAccountId, name: "Inbox test", scopes });
      if (!result.ok) throw new Error(result.error.message);
      return result.data.token;
    };
    const send = () =>
      notifications.send(app.notifications.changed, {
        recipient: { serviceAccountId: agent.id },
        data: { body: "Only the assigned agent may read this body" },
        idempotencyKey: suffix,
      });
    try {
      const first = await send();
      expect(first.status).toBe("queued");
      expect(first.deliveries).toEqual([expect.objectContaining({ channel: "inbox", status: "pending" })]);
      const [event] = await sql<Record<string, unknown>[]>`SELECT * FROM notifications.events WHERE id = ${first.id}::uuid`;
      expect(event).toMatchObject({ recipient_user_id: null, recipient_email: null, recipient_service_account_id: agent.id });
      expect(JSON.stringify(event)).not.toContain("Only the assigned");
      const [stored] = await sql<
        { payload_encrypted: string }[]
      >`SELECT payload_encrypted FROM notifications.deliveries WHERE event_id = ${first.id}::uuid`;
      expect(stored!.payload_encrypted).not.toContain("Only the assigned");
      expect(NotificationInboxContentSchema.parse(await decryptSecret(stored!.payload_encrypted))).toEqual({
        title: "Assignment changed",
        body: "Only the assigned agent may read this body",
        targetHref: "/app/example/task",
      });
      expect(await read()).toMatchObject({ ok: true, data: { items: [], total: 0 } });
      const deliveryId = first.deliveries[0]!.id;
      const driver = getNotificationChannel("inbox")!;
      const deliver = spyOn(driver, "deliver").mockRejectedValueOnce(new Error("Temporary inbox failure"));
      try {
        expect((await processNotificationDelivery(deliveryId)).status).toBe("retry");
        const duplicate = await send();
        expect(duplicate).toMatchObject({ id: first.id, created: false, status: "queued" });
        expect(duplicate.deliveries).toHaveLength(1);
        // A worker stopped during its next attempt: the existing lease recovery must resume it.
        await sql`UPDATE notifications.deliveries SET status = 'sending', last_attempt_at = now() - INTERVAL '6 minutes' WHERE id = ${deliveryId}::uuid`;
        expect(await recoverNotificationDeliveries()).toContain(deliveryId);
        expect((await processNotificationDelivery(deliveryId)).status).toBe("delivered");
        expect((await processNotificationDelivery(deliveryId)).status).toBe("skipped");
      } finally {
        deliver.mockRestore();
      }
      const duplicate = await Promise.all([send(), send()]);
      expect(duplicate.every((item) => item.id === first.id && !item.created && item.status === "delivered")).toBe(true);
      const [finished] = await sql<
        { payload_encrypted: string; attempt_count: number }[]
      >`SELECT payload_encrypted, attempt_count FROM notifications.deliveries WHERE id = ${deliveryId}::uuid`;
      expect(finished!.payload_encrypted).toBe(stored!.payload_encrypted);
      expect(finished!.attempt_count).toBe(2);
      expect(await read()).toMatchObject({
        ok: true,
        data: { total: 1, items: [{ eventId: first.id, body: "Only the assigned agent may read this body" }] },
      });
      const key = await token(agent.id);
      const response = await call(key);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("private, no-store");
      expect(response.headers.get("cache-control")).toContain("no-transform");
      const responseBody = await response.json();
      expect(responseBody.items).toHaveLength(1);
      expect(responseBody.items[0]).not.toHaveProperty("payload_encrypted");
      expect(responseBody.items[0]).not.toHaveProperty("preview");
      expect(await (await call(await token(other.id))).json()).toMatchObject({ items: [], total: 0 });
      expect((await call(await token(agent.id, ["write"]))).status).toBe(403);
      expect((await call(await token(agent.id, []))).status).toBe(403);
      expect((await router.request("/api/notifications/inbox")).status).toBe(401);
      for (const query of ["?perPage=101", "?page=0", `?serviceAccountId=${other.id}`, `?userId=${userId}`])
        expect((await call(key, query)).status).toBe(400);

      const required = await notifications.send(app.notifications.required, {
        recipient: { serviceAccountId: agent.id },
        data: {},
        idempotencyKey: suffix,
      });
      expect(required.status).toBe("delivered");
      expect(
        (await notifications.user.preferences.set({ userId, definitionId: app.notifications.required.id, channels: ["inbox"] })).ok,
      ).toBe(false);
      // Stable fixture dates make page ordering independent of the day this suite runs.
      await sql`UPDATE notifications.events SET created_at = '2026-10-20T00:00:00Z' WHERE id = ${first.id}::uuid`;
      await sql`UPDATE notifications.events SET created_at = '2026-10-21T00:00:00Z' WHERE id = ${required.id}::uuid`;
      const paged = await (await call(key, "?page=2&perPage=1")).json();
      expect(paged).toMatchObject({ page: 2, perPage: 1, total: 2, totalPages: 2, items: [{ eventId: first.id }] });
      expect(await (await call(key, "?page=3&perPage=1")).json()).toMatchObject({ items: [], total: 2 });
      const empty = await notifications.send(app.notifications.empty, {
        recipient: { serviceAccountId: agent.id },
        data: {},
        idempotencyKey: suffix,
      });
      expect(empty).toMatchObject({ status: "suppressed", deliveries: [{ channel: "none", errorCode: "no_preferred_channel" }] });

      const human = await notifications.send(app.notifications.changed, {
        recipient: { userId },
        data: { body: "Human content" },
        idempotencyKey: suffix,
      });
      expect(human.deliveries.map((item) => item.channel)).toEqual(["browser", "email"]);
      expect(human.deliveries.find((item) => item.channel === "email")?.status).toBe("pending");
      const preferences = await notifications.user.preferences.list(userId);
      expect(preferences.availableChannels).not.toContain("inbox");
      const preference = preferences.definitions.find((entry) => entry.id === app.notifications.changed.id);
      expect(preference).toMatchObject({ selectedChannels: ["browser", "email"], effectiveChannels: ["browser", "email"] });
      expect(
        (await notifications.user.preferences.set({ userId, definitionId: app.notifications.changed.id, channels: ["inbox"] })).ok,
      ).toBe(false);
      expect((await notifications.user.preferences.set({ userId, definitionId: app.notifications.changed.id, channels: [] })).ok).toBe(
        true,
      );
      const muted = await notifications.send(app.notifications.changed, {
        recipient: { userId },
        data: { body: "Muted" },
        idempotencyKey: `${suffix}:muted`,
      });
      expect(muted).toMatchObject({ status: "suppressed", deliveries: [{ channel: "none", errorCode: "disabled_by_user" }] });
      expect(
        (await notifications.user.history.list({ userId, page: 1, perPage: 100 })).items.some((entry) => entry.eventId === first.id),
      ).toBe(false);
      expect(await read()).toMatchObject({ ok: true, data: { total: 2 } });

      const bound = await serviceAccounts.createResourceBound({
        name: `Bound-${suffix}`,
        appId: app.meta.id,
        resourceType: "space",
        resourceId: suffix,
        createdBy: userId,
      });
      if (!bound.ok) throw new Error(bound.error.message);
      ids.push(bound.data.id);
      const boundKey = await token(bound.data.id);
      const boundInput = { recipient: { serviceAccountId: bound.data.id }, data: {}, idempotencyKey: suffix };
      await expect(notifications.send(app.notifications.required, boundInput)).rejects.toThrow("exact app, type and resource binding");
      for (const resource of [
        { type: `${app.meta.id}.space`, id: "other-space" },
        { type: `${app.meta.id}.task`, id: suffix },
        { type: "other.space", id: suffix },
      ]) {
        await expect(notifications.send(app.notifications.required, { ...boundInput, resource })).rejects.toThrow();
      }
      const boundNotice = await notifications.send(app.notifications.required, {
        ...boundInput,
        resource: { type: `${app.meta.id}.space`, id: suffix },
      });
      expect(boundNotice.status).toBe("delivered");
      expect(await (await call(boundKey)).json()).toMatchObject({
        total: 1,
        items: [{ eventId: boundNotice.id, body: "Private required content" }],
      });
      expect((await call(await token(bound.data.id, ["write"]))).status).toBe(403);
      expect(await (await call(boundKey, `?resourceId=${suffix}`)).json()).toHaveProperty("message");
      // Binding changes never unlock notices from the preceding resource.
      await sql`UPDATE auth.service_accounts SET resource_id = 'other-space' WHERE id = ${bound.data.id}::uuid`;
      expect(await (await call(boundKey)).json()).toMatchObject({ total: 0, items: [] });
      await sql`UPDATE auth.service_accounts SET resource_id = ${suffix} WHERE id = ${bound.data.id}::uuid`;
      await sql`UPDATE notifications.events SET resource_type = 'task' WHERE id = ${boundNotice.id}::uuid`;
      expect(await (await call(boundKey)).json()).toMatchObject({ total: 0, items: [] });
      await sql`UPDATE notifications.events SET resource_type = 'space' WHERE id = ${boundNotice.id}::uuid`;
      expect(await (await call(boundKey)).json()).toMatchObject({ total: 1 });
      // Runtime callers get the same exclusivity as TypeScript callers.
      await expect(
        notifications.send(app.notifications.changed, {
          // @ts-expect-error Intentional invalid transport shape.
          recipient: { userId, serviceAccountId: agent.id },
          data: { body: "Mixed" },
          idempotencyKey: suffix,
        }),
      ).rejects.toThrow("exactly one recipient");
      await expect(
        notifications.send(app.notifications.changed, {
          // @ts-expect-error A direct email cannot bypass principal preferences.
          recipient: { email: "creator@example.test" },
          data: { body: "Wrong kind" },
          idempotencyKey: suffix,
        }),
      ).rejects.toThrow("match the definition");
      const delegated = await serviceAccounts.createUserDelegated({ name: `Delegated-${suffix}`, delegatedUserId: userId });
      if (!delegated.ok) throw new Error(delegated.error.message);
      ids.push(delegated.data.id);
      expect((await call(await token(delegated.data.id))).status).toBe(403);
      await expect(
        notifications.send(app.notifications.changed, {
          recipient: { serviceAccountId: delegated.data.id },
          data: { body: "Delegate" },
          idempotencyKey: suffix,
        }),
      ).rejects.toThrow("existing non-delegated");
      await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${agent.id}::uuid`;
      expect((await call(key)).status).toBe(401);
      expect(await read()).toMatchObject({ ok: true, data: { items: [], total: 0 } });
      const suppressedInput = { recipient: { serviceAccountId: agent.id }, data: {}, idempotencyKey: `${suffix}:inactive` };
      const suppressed = await notifications.send(app.notifications.required, suppressedInput);
      expect(suppressed).toMatchObject({
        status: "suppressed",
        created: true,
        deliveries: [{ channel: "none", status: "suppressed", errorCode: "recipient_inactive" }],
      });
      expect(await notifications.send(app.notifications.required, suppressedInput)).toMatchObject({
        id: suppressed.id,
        created: false,
        status: "suppressed",
      });
      const [suppressedPayload] =
        await sql`SELECT payload_encrypted, attempt_count FROM notifications.deliveries WHERE event_id = ${suppressed.id}::uuid`;
      expect(suppressedPayload).toEqual({ payload_encrypted: null, attempt_count: 0 });
      await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${agent.id}::uuid`;
      expect(await notifications.send(app.notifications.required, suppressedInput)).toMatchObject({
        id: suppressed.id,
        created: false,
        status: "suppressed",
      });
      expect(
        await notifications.send(app.notifications.required, { ...suppressedInput, idempotencyKey: `${suffix}:reactivated` }),
      ).toMatchObject({ status: "delivered", created: true });
      const observed = await notifications.observability.deliveries.list({ filter: { appIds: [app.meta.id], search: agent.name } });
      expect(observed.total).toBeGreaterThan(0);
      expect(observed.items.every((entry) => entry.recipientLabel === agent.name && entry.recipientReference === agent.name)).toBe(true);
      expect(observed.items.every((entry) => !("body" in entry) && !("payload_encrypted" in entry))).toBe(true);
      expect(await notifications.observability.deliveries.summary({ filter: { appIds: [app.meta.id], search: agent.name } })).toMatchObject(
        { total: observed.total },
      );
    } finally {
      for (const id of ids) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      await sql`DELETE FROM notifications.definitions WHERE app_id = ${app.meta.id}`;
    }
  });
});
