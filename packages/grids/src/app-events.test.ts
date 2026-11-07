import { expect, test } from "bun:test";
import { defineCapabilities } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { appEventFixture, deliverAppEvent } from "@k2b/cloud/events/testing";
import { z } from "zod";
import { gridsEvents } from "./app-events";
import { gridsCapabilities } from "./capabilities";

for (const name of ["record.created", "record.updated", "record.deleted", "record.finalized"] as const) {
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

for (const name of ["table.deleted", "table.restored", "base.deleted", "base.restored"] as const) {
  test(`${name} declares one reference-only lifecycle event`, () => {
    const subject = name.startsWith("table.") ? "table" : "base";
    const event = appEventFixture(gridsCapabilities, name, { subject: "Ref001", place: "Base01", data: {} }, { appId: "grids" });
    expect(event.subject).toEqual({ type: `grids.${subject}`, id: "Ref001" });
    expect(event.place).toEqual({ type: "grids.base", id: "Base01" });
    expect(event.data).toEqual({});
    expect(gridsEvents[name].schema.safeParse({ recordIds: ["Rec001"] }).success).toBe(false);
  });
}

test("overflow summary is bounded, versioned and identifies the table without record IDs or values", () => {
  const data = { counts: { created: 100_000, updated: 2, deleted: 3, finalized: 4 } };
  const event = appEventFixture(gridsCapabilities, "records.changed", { subject: "Table1", place: "Base01", data }, { appId: "grids" });
  expect(event).toMatchObject({ type: "grids.records.changed", version: 1, subject: { type: "grids.table", id: "Table1" }, data });
  expect(JSON.stringify(event).length).toBeLessThan(500);
  expect(gridsEvents["records.changed"].schema.safeParse({ ...data, recordIds: ["Rec001"] }).success).toBe(false);
  expect(gridsEvents["records.changed"].schema.safeParse({ counts: { ...data.counts, updated: -1 } }).success).toBe(false);
});
