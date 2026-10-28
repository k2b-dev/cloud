import { afterEach, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import { z } from "zod";
import { appEventJsonbBytes, assertAppEventSize } from "../_internal/app-event-schemas";
import {
  capabilityHash,
  compileCapabilities,
  parseCapabilityManifest,
  resolveCapabilityManifestPresentation,
} from "../_internal/capabilities";
import { AppEventEnvelopeSchema } from "../contracts/app-events";
import { defineCapabilities } from "../contracts/capabilities";
import { appEventFromOutbox, appEventTopicConfig } from "./app-event-delivery";
import { appEventBinding, appEvents, bindAppEvents, deliverAppEvent } from "./app-events";
import { appEventFixture, createAppEventTestHarness, deliverAppEvent as deliverTestAppEvent } from "./app-events.testing";

afterEach(() => setSystemTime());

const event = {
  version: 1,
  title: "User created",
  description: "A user was created.",
  subject: "user",
  schema: z.strictObject({ userId: z.uuid(), provider: z.enum(["password", "oidc"]) }),
};
const capabilities = () =>
  defineCapabilities({
    protocolVersion: 2,
    types: { user: { title: "User", description: "An account." } },
    events: { "user.created": event },
  });
const userId = "00000000-0000-4000-8000-000000000002";
const fixtureCapabilities = capabilities();
bindAppEvents("core", fixtureCapabilities);
const envelope = () => appEventFixture(fixtureCapabilities, "user.created", { subject: userId, data: { userId, provider: "password" } });

test("event declarations compile deterministically and preserve old manifest shapes", () => {
  const original = compileCapabilities("core", { protocolVersion: 2 });
  expect(Object.hasOwn(original.manifest, "events")).toBe(false);
  expect(Object.hasOwn(original.manifest, "subscribes")).toBe(false);
  const compiled = compileCapabilities("core", capabilities());
  const manifest = compiled.manifest;
  expect(manifest.events?.[0]).toMatchObject({ localId: "user.created", version: 1, subject: "user", title: "User created" });
  expect(parseCapabilityManifest(manifest, "core")).toEqual(manifest);
  expect(compileCapabilities("core", capabilities()).manifest).toEqual(manifest);
  expect(() => compileCapabilities("core", { ...capabilities(), events: { "user.created": { ...event, subject: "missing" } } })).toThrow(
    "local Type",
  );
  expect(() => compileCapabilities("core", { ...capabilities(), events: { "user.created": { ...event, version: 0 } } })).toThrow();
  expect(() => compileCapabilities("core", { ...capabilities(), events: { "user.created": { ...event, place: "user" } } })).toThrow(
    "reader",
  );
  expect(() =>
    compileCapabilities("core", {
      ...capabilities(),
      events: { "user.created": { ...event, schema: z.strictObject({ unbounded: z.string() }) } },
    }),
  ).toThrow("maxLength");
  expect(() =>
    compileCapabilities("core", {
      ...capabilities(),
      events: { "user.created": { ...event, schema: z.strictObject({ unbounded: z.array(z.boolean()) }) } },
    }),
  ).toThrow("maxItems");
});

test("startup rejects required data that cannot fit the complete envelope", () => {
  expect(() =>
    compileCapabilities("core", {
      ...capabilities(),
      events: { "user.created": { ...event, schema: z.strictObject({ value: z.string().min(4000).max(4000) }) } },
    }),
  ).toThrow("4096");
});

test("compatible readers omit unknown event fields and schemas, localize only presentation", () => {
  const declared = capabilities();
  const compiled = compileCapabilities("core", {
    ...declared,
    presentation: { baseLocale: "en", translations: { de: { events: { "user.created": { title: "Benutzer erstellt" } } } } },
  });
  const localized = resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de-DE");
  expect(localized.events?.[0]?.title).toBe("Benutzer erstellt");
  expect(localized.events?.[0]?.schemaHash).toBe(compiled.manifest.events?.[0]?.schemaHash);
  const { manifestHash: _, ...base } = compiled.manifest;
  const future = { ...base, events: base.events?.map((event) => ({ ...event, futureRestriction: true })) };
  expect(parseCapabilityManifest({ ...future, manifestHash: capabilityHash(future) }, "core").events).toEqual([]);
  const broken = { ...base, events: base.events?.map((event) => ({ ...event, schemaHash: "0".repeat(64) })) };
  expect(parseCapabilityManifest({ ...broken, manifestHash: capabilityHash(broken) }, "core").events).toEqual([]);
});

test("publisher enqueues validated original JSON in the supplied transaction", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const definitions = capabilities();
  const publisher = appEvents(definitions);
  const client = new SQL("postgres://localhost/unused_test");
  const writes: { query: string; values: unknown[] }[] = [];
  const tx = new Proxy(client, {
    apply(_target, _receiver, [strings, ...values]) {
      writes.push({ query: strings.join("?"), values });
      return Promise.resolve([]);
    },
  });
  try {
    await expect(publisher.publish(tx, "user.created", { subject: userId, data: { userId, provider: "password" } })).rejects.toThrow(
      "Bind",
    );
    bindAppEvents("core", definitions);
    const sent = await publisher.publish(tx, "user.created", {
      subject: userId,
      data: { provider: "password", userId },
      requestId: "request-1",
    });
    expect(AppEventEnvelopeSchema.safeParse(sent).success).toBe(true);
    expect(sent).toMatchObject({
      source: "core",
      type: "core.user.created",
      time: "2026-01-01T00:00:00.000Z",
      subject: { type: "core.user", id: userId },
      cause: { requestId: "request-1" },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.query).toBe("SELECT events.enqueue(?::uuid, ?, 'event', ?, ?::text::jsonb)");
    expect(writes[0]?.values[2]).toBe(capabilityHash(sent.subject));
    expect(JSON.parse(String(writes[0]?.values[3]))).toEqual(sent);
    await expect(
      publisher.publish(tx, "user.created", { subject: userId, data: { userId, provider: "password" }, requestId: "x".repeat(257) }),
    ).rejects.toThrow();
    expect(writes).toHaveLength(1);
    expect(() => bindAppEvents("other", definitions)).toThrow("already bound");
  } finally {
    await client.close();
  }
});

test("publisher rejects non-JSON originals rather than silently normalizing them", async () => {
  const definitions = defineCapabilities({
    protocolVersion: 2,
    types: { value: { title: "Value", description: "A value." } },
    events: {
      changed: { ...event, subject: "value", schema: z.strictObject({ value: z.union([z.string().max(50), z.number()]).optional() }) },
    },
  });
  bindAppEvents("example", definitions);
  const publisher = appEvents(definitions);
  const client = new SQL("postgres://localhost/unused_test");
  let writes = 0;
  const tx = new Proxy(client, {
    apply() {
      writes++;
      return Promise.resolve([]);
    },
  });
  try {
    await expect(publisher.publish(tx, "changed", { subject: "one", data: { value: undefined } })).rejects.toThrow();
    await expect(publisher.publish(tx, "changed", { subject: "one", data: { value: Number.NaN } })).rejects.toThrow();
    await expect(publisher.publish(tx, "changed", { subject: "one", data: { value: Number.POSITIVE_INFINITY } })).rejects.toThrow();
    // Runtime boundary coverage includes untyped callers.
    await expect(
      Reflect.apply(publisher.publish, undefined, [tx, "changed", { subject: "one", data: { value: new Date("2026-01-01Z") } }]),
    ).rejects.toThrow();
    await expect(publisher.publish(tx, "changed", { subject: "one", data: { value: -0 } })).rejects.toThrow("round-trip");
    await expect(
      Reflect.apply(publisher.publish, undefined, [tx, "changed", { subject: "one", data: { value: "ok", [Symbol("hidden")]: true } }]),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  } finally {
    await client.close();
  }
});

test("4 KiB counts JSONB spaces, UTF-8 and expanded numbers", () => {
  expect(appEventJsonbBytes({ a: 1, b: ["ä", true] })).toBe(new TextEncoder().encode('{"a": 1, "b": ["ä", true]}').byteLength);
  expect(appEventJsonbBytes({ n: 1e21 })).toBe('{"n": 1000000000000000000000}'.length);
  expect(appEventJsonbBytes({ n: 1e-7 })).toBe('{"n": 0.0000001}'.length);
  const fixture = envelope();
  const empty = AppEventEnvelopeSchema.parse({ ...fixture, data: { text: "" } });
  const remaining = 4096 - appEventJsonbBytes(empty);
  const exact = { ...empty, data: { text: "x".repeat(remaining) } };
  expect(appEventJsonbBytes(exact)).toBe(4096);
  expect(() => assertAppEventSize(exact)).not.toThrow();
  expect(() => assertAppEventSize({ ...exact, data: { text: "x".repeat(remaining + 1) } })).toThrow("4096");
});

test("dispatcher owns identity, source and time and topic budget is frozen", () => {
  const original = envelope();
  const authoritative = appEventFromOutbox({
    id: userId,
    app_id: "core",
    created_at: "2026-02-02T12:00:00Z",
    attempts: 0,
    ordering_key: "one",
    payload: { ...original, source: "wrong", time: "2025-01-01T00:00:00Z" },
  });
  expect(authoritative.id).toBe(userId);
  expect(authoritative.source).toBe("core");
  expect(authoritative.time).toBe("2026-02-02T12:00:00.000Z");
  expect(appEventTopicConfig()).toEqual({
    id: "cloud:app-events",
    owner: "cloud",
    retention: { maxAgeMs: 604800000, maxBytes: 268435456 },
    maxPayloadBytes: 8192,
    deadLetterRetention: { maxBytes: 1048576 },
  });
});

test("test harness executes the production validator with a tolerant subscriber", async () => {
  const received: unknown[] = [];
  const definitions = defineCapabilities({
    protocolVersion: 2,
    subscribes: {
      "core.user.created": {
        version: 1,
        schema: z.object({ userId: z.uuid() }),
        run: (event, context) => {
          received.push({ event, context });
        },
      },
    },
  });
  const harness = createAppEventTestHarness("files", definitions);
  const wire = envelope();
  await harness.deliver(wire, { attempt: 2 });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    event: { data: { userId } },
    context: { attempt: 2, eventId: wire.id, subscriptionId: "files:core.user.created@1" },
  });
  expect((received[0] as { event: { data: unknown } }).event.data).toEqual({ userId });
  await expect(harness.deliver({ ...wire, version: 2 })).rejects.toThrow("version");
  await expect(harness.deliver({ ...wire, place: { type: "core.folder", id: "one" } })).rejects.toThrow("resource_events_unsupported");
  await expect(harness.deliver({ ...wire, source: "other" })).rejects.toThrow("source");
  await expect(harness.deliver({ ...wire, data: { userId: "invalid" } })).rejects.toThrow();
  const signal = AbortSignal.abort();
  await expect(harness.deliver(wire, { signal })).rejects.toThrow();
  expect(received).toHaveLength(1);
  const compiled = compileCapabilities("files", definitions);
  await expect(
    deliverAppEvent({
      compiled,
      subscriptionId: "bad",
      envelope: wire,
      context: { subscriptionId: "bad", eventId: wire.id, attempt: 1, signal: new AbortController().signal },
    }),
  ).rejects.toThrow("ID mismatch");
});

test("producer fixture and delivery helpers share production validation", async () => {
  const definitions = capabilities();
  expect(() => appEventFixture(definitions, "user.created", { subject: userId, data: { userId, provider: "password" } })).toThrow("Bind");
  const fixture = appEventFixture(
    definitions,
    "user.created",
    { subject: userId, data: { userId, provider: "password" } },
    { appId: "core", id: userId, time: "2026-02-02T00:00:00Z" },
  );
  expect(fixture).toMatchObject({ id: userId, time: "2026-02-02T00:00:00Z", type: "core.user.created" });
  expect(() =>
    Reflect.apply(appEventFixture, undefined, [definitions, "user.created", { subject: userId, data: { userId, provider: "unknown" } }]),
  ).toThrow();
  expect(() =>
    appEventFixture(definitions, "user.created", { subject: userId, data: { userId, provider: "password" }, requestId: "x".repeat(257) }),
  ).toThrow();
  let calls = 0;
  const subscriber = defineCapabilities({
    protocolVersion: 2,
    subscribes: {
      "core.user.created": {
        version: 1,
        schema: z.object({ userId: z.uuid() }),
        run: () => {
          calls++;
        },
      },
    },
  });
  await deliverTestAppEvent(subscriber, "core.user.created", fixture, { appId: "files" });
  expect(calls).toBe(1);
  await expect(deliverTestAppEvent(subscriber, "core.other", fixture)).rejects.toThrow("type");
  await expect(deliverTestAppEvent(subscriber, "core.user.created", fixture, { attempt: 0 })).rejects.toThrow("context");
  expect(calls).toBe(1);
});

test("framework event binding reuses the one compiled capability object", () => {
  const definitions = capabilities();
  const compiled = compileCapabilities("compiledonce", definitions);
  bindAppEvents("compiledonce", definitions, compiled);
  expect(appEventBinding(definitions).compiled).toBe(compiled);
});
