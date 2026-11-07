import { expect, test } from "bun:test";
import { defineCapabilities } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { appEventFixture, deliverAppEvent } from "@k2b/cloud/events/testing";
import { z } from "zod";
import { gridsEvents } from "./app-events";
import { gridsCapabilities } from "./capabilities";

for (const name of Object.keys(gridsEvents) as Array<keyof typeof gridsEvents>) {
  test(`${name} declares versioned, reference-only resource events`, async () => {
    const manifest = compileCapabilityManifest("grids", gridsCapabilities);
    expect(manifest.events?.find((event) => event.localId === name)).toMatchObject({
      version: 1,
      subject: "record",
      place: "base",
      dataSchema: { type: "object", additionalProperties: false },
    });
    const event = appEventFixture(gridsCapabilities, name, { subject: "Rec001", place: "Base01", data: {} }, { appId: "grids" });
    expect(event).toMatchObject({
      type: `grids.${name}`,
      version: 1,
      source: "grids",
      subject: { type: "grids.record", id: "Rec001" },
      place: { type: "grids.base", id: "Base01" },
      data: {},
    });
    expect(JSON.stringify(event).length).toBeLessThan(300);
    expect(gridsEvents[name].schema.safeParse({ value: "private" }).success).toBe(false);
    const subscriber = defineCapabilities({
      protocolVersion: 2,
      subscribes: {
        [`grids.${name}`]: {
          version: 1,
          schema: z.strictObject({}),
          run: async () => {
            throw new Error("must not run");
          },
        },
      },
    });
    await expect(deliverAppEvent(subscriber, event.type, event, { appId: "consumer" })).rejects.toThrow("resource_events_unsupported");
  });
}
