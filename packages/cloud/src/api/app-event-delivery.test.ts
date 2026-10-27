import { expect, test } from "bun:test";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import { createAppEventDeliveryRoutes } from "./app-event-delivery";

const id = "00000000-0000-4000-8000-000000000001";
const envelope = {
  id,
  type: "producer.changed",
  version: 1,
  source: "producer",
  time: "2000-01-01T00:00:00.000Z",
  subject: { type: "producer.item", id },
  data: { id },
};
const setup = (run: () => Promise<void> = async () => {}) => {
  const compiled = compileCapabilities(
    "subscriber",
    defineCapabilities({ protocolVersion: 2, subscribes: { "producer.changed": { version: 1, schema: z.object({ id: z.uuid() }), run } } }),
  );
  const make = (authorized: boolean) => createAppEventDeliveryRoutes(compiled, async () => authorized);
  const send = (app: ReturnType<typeof make>, overrides: Record<string, unknown> = {}, token = true) =>
    app.request("/deliver", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer fixture" } : {}) },
      body: JSON.stringify({ envelope, subscriptionId: "subscriber:producer.changed@1", attempt: 1, ...overrides }),
    });
  return { make, send };
};
test("delivery requires a verified Core invocation before running the subscriber", async () => {
  let calls = 0;
  const { make, send } = setup(async () => {
    calls++;
  });
  expect((await send(make(false))).status).toBe(401);
  expect((await send(make(true), {}, false)).status).toBe(401);
  expect(calls).toBe(0);
  expect((await send(make(true))).status).toBe(200);
  expect(calls).toBe(1);
});
test("schema mismatch is permanent; removed subscription and resource delivery stop; thrown handlers retry", async () => {
  const { make, send } = setup(async () => {
    throw new Error("failed");
  });
  expect((await send(make(true), { envelope: { ...envelope, data: { id: "bad" } } })).status).toBe(422);
  expect((await send(make(true), { envelope: { ...envelope, version: 2 } })).status).toBe(410);
  expect((await send(make(true), { envelope: { ...envelope, place: { type: "producer.item", id } } })).status).toBe(410);
  expect((await send(make(true))).status).toBe(503);
});

test("subscription handlers receive schema-inferred parsed data", async () => {
  let received = "";
  const schema = z.strictObject({ id: z.uuid(), label: z.string().max(40).optional() });
  const declarations = defineCapabilities({
    protocolVersion: 2,
    subscribes: {
      "producer.changed": {
        version: 1,
        schema,
        async run(event, context) {
          const userId: string = event.data.id;
          const label: string | undefined = event.data.label;
          // @ts-expect-error A schema-inferred handler rejects unknown data properties.
          event.data.missing;
          received = `${userId}:${label ?? "absent"}:${context.attempt}`;
        },
      },
    },
  });
  const routes = createAppEventDeliveryRoutes(compileCapabilities("subscriber", declarations), async () => true);
  const response = await routes.request("/deliver", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture",
      "content-type": "application/json",
    },
    body: JSON.stringify({ envelope, subscriptionId: "subscriber:producer.changed@1", attempt: 1 }),
  });
  expect(response.status).toBe(200);
  expect(received).toBe(`${id}:absent:1`);
});
