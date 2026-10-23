import { expect, test } from "bun:test";
import type { invokeCapability, listCapabilityCatalog } from "@k2b/cloud/capabilities";
import { z } from "zod";
import { createResourceCards } from "./resource-cards";

const manifest = {
  protocolVersion: 2 as const,
  appId: "spaces",
  manifestHash: "0".repeat(64),
  types: [{ localId: "task", title: "Task", description: "A task.", icon: "ti ti-circle", reader: "task.read" }],
  queries: [
    {
      localId: "task.read",
      title: "Read a task",
      description: "Reads one task.",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      dataSchema: { type: "object", properties: {}, additionalProperties: true },
      schemaHash: "0".repeat(64),
      openWorld: false,
    },
  ],
  actions: [],
  commands: [],
};
const catalog: typeof listCapabilityCatalog = async () => ({
  ok: true,
  data: {
    protocolVersion: 2,
    apps: [{ appId: "spaces", appName: "Spaces", appIcon: "ti ti-layout-kanban", appDescription: "", manifest }],
    page: { hasMore: false },
  },
});

/** A reader whose answer the test changes, as when access is granted or taken away. */
const setup = () => {
  let clock = 0;
  let readable = true;
  const reads: string[] = [];
  const invoke: typeof invokeCapability = async (invocation) => {
    const { id } = z.object({ id: z.string() }).parse(invocation.input);
    reads.push(id);
    return readable
      ? {
          ok: true,
          data: { data: {}, refs: [{ type: "spaces.task", id, title: `Task ${id}` }], links: [{ rel: "open", href: `/app/spaces/${id}` }] },
        }
      : { ok: false, error: { code: "FORBIDDEN", message: "No access", status: 403 } };
  };
  const cards = createResourceCards({ listCapabilityCatalog: catalog, invokeCapability: invoke, now: () => clock });
  return {
    cards,
    reads,
    tick: (ms: number) => {
      clock += ms;
    },
    revoke: () => {
      readable = false;
    },
  };
};
const ref = (id: string) => ({ type: "spaces.task", id });

test("cards of the same element share one read while it is fresh", async () => {
  const { cards, reads } = setup();
  const [first, second] = await Promise.all([cards.view(ref("a")), cards.view(ref("a"))]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ state: "ok", title: "Task a", source: "Spaces", href: "/app/spaces/a" });
  expect(reads).toEqual(["a"]);
});

test("a card shown again after a minute reads again, so lost access hides the element", async () => {
  const { cards, reads, tick, revoke } = setup();
  expect((await cards.view(ref("a"))).state).toBe("ok");
  revoke();
  tick(30_000);
  expect((await cards.view(ref("a"))).state).toBe("ok");
  tick(30_000);
  const later = await cards.view(ref("a"));
  expect(later).toEqual({ state: "no_access" });
  expect(reads).toEqual(["a", "a"]);
});

test("the page remembers a bounded number of elements, the oldest forgotten first", async () => {
  const { cards, reads } = setup();
  for (let index = 0; index <= 200; index++) await cards.view(ref(`e${index}`));
  await cards.view(ref("e200"));
  await cards.view(ref("e0"));
  expect(reads.filter((id) => id === "e200")).toHaveLength(1);
  expect(reads.filter((id) => id === "e0")).toHaveLength(2);
});
