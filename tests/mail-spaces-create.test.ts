import { beforeEach, expect, mock, test } from "bun:test";
import { compileCapabilityManifest } from "../packages/cloud/src/capabilities/testing";
import { spacesCapabilities } from "../packages/spaces/src/capabilities";

const manifest = compileCapabilityManifest("spaces", spacesCapabilities);
const calls: Array<{ capabilityId: string; idempotencyKey?: string }> = [];
mock.module(new URL("../packages/cloud/src/capabilities/server.ts", import.meta.url).pathname, () => ({
  getCapabilityCatalogApp: async () => ({ ok: true, data: { manifest } }),
  invokeCapabilityWithDataSchema: async (call: { capabilityId: string; idempotencyKey?: string }) => {
    const action = manifest.actions.find((entry) => entry.localId === call.capabilityId);
    expect(action).toBeDefined();
    if (action?.idempotency === "required") expect(call.idempotencyKey).toBeTruthy();
    calls.push(call);
    return { ok: true, data: { data: { id: "Event1" } } };
  },
}));
const { createCalendarEvent, createSpaceEventOnce, createSpaceItemForResource, getSpacesMailIntegrationAvailability } =
  await import("../packages/mail/src/service/app-integrations");
beforeEach(() => { calls.length = 0; });

test("Mail discovery accepts the current Spaces context contract", async () => {
  expect((await getSpacesMailIntegrationAvailability()).context).toBe(true);
});

test("automations retain their durable key while using the current event action", async () => {
  await createSpaceEventOnce({ title: "Meeting" }, "workflow-step-key", {});
  expect(calls[0]).toMatchObject({ capabilityId: "event.create", idempotencyKey: "workflow-step-key" });
});

test("manual composer and conversation creates supply keys to the current actions", async () => {
  const request = { requestId: crypto.randomUUID() };
  await createCalendarEvent({ spaceId: "Space1", columnId: "Column", title: "Meeting", startsAt: "2026-09-14T10:00:00Z", endsAt: "2026-09-14T11:00:00Z" }, request);
  await createSpaceItemForResource("event", { title: "Meeting" }, request);
  await createSpaceItemForResource("task", { title: "Task" }, {});
  expect(calls.map((call) => call.capabilityId)).toEqual(["event.create", "event.create", "task.create"]);
  expect(calls[0]?.idempotencyKey).toBe(request.requestId);
  expect(calls[1]?.idempotencyKey).toBe(request.requestId);
  expect(calls[2]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});
