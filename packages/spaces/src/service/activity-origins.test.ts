import { afterEach, expect, spyOn, test } from "bun:test";
import * as capabilityServer from "@k2b/cloud/capabilities/server";
import type { RequestAuthority } from "@k2b/cloud/server";
import type { SpaceActivityEvent } from "./activity";
import { presentActivityOrigins } from "./activity-origins";
import { spaceActivityRow } from "./activity-timeline";

const origin = { type: "example.job", id: "v1~r1" };
const event = (overrides: Partial<SpaceActivityEvent> = {}): SpaceActivityEvent => ({
  id: "1",
  space: { id: "s", shortId: "abc123", name: "Logistik", color: "#000" },
  item: { id: "i", shortId: "def456", title: "Lieferung", kind: "task" },
  actor: { kind: "service_account", id: "00000000-0000-4000-8000-000000000001", displayName: "machine:name", avatarHash: null },
  action: "task.created",
  metadata: { origin },
  occurrenceCount: 1,
  createdAt: "2026-11-01T09:41:00.000Z",
  lastOccurredAt: "2026-11-01T09:41:00.000Z",
  ...overrides,
});
const row = (input: SpaceActivityEvent, view?: Parameters<typeof spaceActivityRow>[1]["origin"]) =>
  spaceActivityRow(input, { viewer: { kind: "user", id: "u" }, assigneeId: "u", locale: "de", timeZone: "Europe/Berlin", origin: view });
const authority = {} as RequestAuthority;
const caller = { cookie: "session=1" };
const manifest = {
  appId: "example",
  types: [{ localId: "job", title: "Job", reader: "job.read" }],
  queries: [{ localId: "job.read" }],
};
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const catalog = () => {
  const spy = spyOn(capabilityServer, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: { manifest } } as never);
  spies.push(spy);
  return spy;
};

test("a reader's answer names the work and carries its links, for any app, without Spaces knowing the app", async () => {
  catalog();
  spies.push(
    spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: true,
      data: {
        data: { view: { title: "Job von info@", context: "Lieferungen eintragen", permission: "read" } },
        links: [
          { rel: "open", href: "/app/example/job" },
          { rel: "status", href: "/app/example/job?run=r1" },
        ],
      },
    } as never),
  );
  const views = await presentActivityOrigins([event()], authority, caller, "de");
  const presented = row(event(), views.get("1"));
  expect(presented.sentence).toBe("Angelegt von Job von info@ (Lieferungen eintragen)");
  expect(presented.origin).toEqual({ name: "Job von info@", href: "/app/example/job", runHref: "/app/example/job?run=r1" });
});

test("someone the reader refuses still sees who did it, without links", async () => {
  catalog();
  spies.push(
    spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: false,
      error: { code: "NOT_FOUND", message: "gone", status: 404 },
    } as never),
  );
  const views = await presentActivityOrigins([event()], authority, caller, "de");
  // Never the owner's name: that is only for those who may read it.
  expect(row(event(), views.get("1")).origin).toEqual({ name: "Job", href: null, runHref: null });
});

test("work whose account is gone says so and keeps its name", async () => {
  catalog();
  spies.push(spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockRejectedValue(new Error("down")));
  const gone = event({
    actor: {
      kind: "service_account",
      id: "00000000-0000-4000-8000-000000000001",
      displayName: "Former service account",
      avatarHash: null,
      gone: true,
    },
  });
  const views = await presentActivityOrigins([gone], authority, caller, "de");
  expect(row(gone, views.get("1")).sentence).toBe("Angelegt von Job (gelöscht)");
});

test("rows without work and rows of a surface that reads no origin stay plain and never show a machine name", () => {
  const plain = event({ metadata: {}, actor: { kind: "user", id: "u2", displayName: "Ben Schulz", avatarHash: null } });
  expect(row(plain).sentence).toBe("Ben Schulz hat die Aufgabe erstellt");
  expect(row(plain).origin).toBeUndefined();
  expect(row(event()).sentence).toBe("Angelegt von Automation");
});

test("the number of readers one page asks is bounded", async () => {
  catalog();
  const read = spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockResolvedValue({
    ok: false,
    error: { code: "NOT_FOUND", message: "gone", status: 404 },
  } as never);
  spies.push(read);
  const many = Array.from({ length: 30 }, (_, index) => event({ id: String(index), metadata: { origin: { ...origin, id: `v${index}` } } }));
  const views = await presentActivityOrigins(many, authority, caller, "de");
  expect(read).toHaveBeenCalledTimes(10);
  expect(views.size).toBe(30);
});

test("a person's work names the person the viewer sees here anyway", () => {
  const personal = event({ actor: { kind: "user", id: "u2", displayName: "Ben Schulz", avatarHash: null } });
  expect(row(personal).sentence).toBe("Angelegt von Automation von Ben Schulz");
});

test("a reader that never answers costs the row its name, not the page its load", async () => {
  catalog();
  spies.push(spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockImplementation(() => new Promise(() => undefined) as never));
  const views = await presentActivityOrigins([event()], authority, { signal: AbortSignal.timeout(5) }, "de");
  expect(views.get("1")?.name).toBeNull();
});
