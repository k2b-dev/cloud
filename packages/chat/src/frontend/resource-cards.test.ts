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

/**
 * A reader whose answers the test controls: by default it answers at once; `hold` keeps every answer until `answer`.
 * Deadlines are signals the test aborts itself, so no test waits for real time.
 */
const setup = () => {
  let clock = 0;
  let readable = true;
  let holding = false;
  const reads: string[] = [];
  const held: (() => void)[] = [];
  const deadlines: AbortController[] = [];
  const invoke: typeof invokeCapability = async (invocation) => {
    const { id } = z.object({ id: z.string() }).parse(invocation.input);
    reads.push(id);
    if (holding)
      await new Promise<void>((resolve, reject) => {
        held.push(resolve);
        invocation.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    return readable
      ? {
          ok: true,
          data: { data: {}, refs: [{ type: "spaces.task", id, title: `Task ${id}` }], links: [{ rel: "open", href: `/app/spaces/${id}` }] },
        }
      : { ok: false, error: { code: "FORBIDDEN", message: "No access", status: 403 } };
  };
  const cards = createResourceCards({
    listCapabilityCatalog: catalog,
    invokeCapability: invoke,
    now: () => clock,
    timeout: () => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    },
  });
  return {
    cards,
    reads,
    deadlines,
    tick: (ms: number) => {
      clock += ms;
    },
    revoke: () => {
      readable = false;
    },
    hold: () => {
      holding = true;
    },
    answer: () => {
      for (const resolve of held.splice(0)) resolve();
    },
  };
};
const ref = (id: string) => ({ type: "spaces.task", id });
const flush = async () => {
  for (let step = 0; step < 10; step++) await Promise.resolve();
};

test("cards of the same element share one read while it is fresh", async () => {
  const { cards, reads } = setup();
  const [first, second] = await Promise.all([cards.view(ref("a")).view, cards.view(ref("a")).view]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ state: "ok", title: "Task a", source: "Spaces", href: "/app/spaces/a" });
  expect(reads).toEqual(["a"]);
});

test("a card shown again after a minute reads again, so lost access hides the element", async () => {
  const { cards, reads, tick, revoke } = setup();
  expect((await cards.view(ref("a")).view).state).toBe("ok");
  revoke();
  tick(30_000);
  expect((await cards.view(ref("a")).view).state).toBe("ok");
  tick(30_000);
  expect(await cards.view(ref("a")).view).toEqual({ state: "no_access" });
  expect(reads).toEqual(["a", "a"]);
});

test("an element still being read is shared, never read twice, however many others come after it", async () => {
  const { cards, reads, hold, answer } = setup();
  hold();
  const first = cards.view(ref("e0"));
  for (let index = 1; index <= 204; index++) cards.view(ref(`e${index}`));
  const again = cards.view(ref("e0"));
  await flush();
  answer();
  await first.view;
  expect(await again.view).toEqual(await first.view);
  expect(reads.filter((id) => id === "e0")).toHaveLength(1);
});

test("a read that nobody holds any more stops, also while it waits for its turn", async () => {
  const { cards, reads, hold, answer } = setup();
  hold();
  const busy = Array.from({ length: 4 }, (_, index) => cards.view(ref(`busy${index}`)));
  const waiting = cards.view(ref("gone"));
  await flush();
  expect(reads).toEqual(["busy0", "busy1", "busy2", "busy3"]);
  waiting.release();
  expect(await waiting.view).toEqual({ state: "unavailable" });
  answer();
  await Promise.all(busy.map((card) => card.view));
  await flush();
  expect(reads).not.toContain("gone");
});

test("the deadline counts from asking, so a card that waits too long shows not available and frees its turn", async () => {
  const { cards, reads, deadlines, hold, answer } = setup();
  hold();
  for (let index = 0; index < 4; index++) cards.view(ref(`busy${index}`));
  const mine = deadlines.length;
  const late = cards.view(ref("late"));
  await flush();
  deadlines[mine]!.abort();
  expect(await late.view).toEqual({ state: "unavailable" });
  answer();
  await flush();
  expect(reads).not.toContain("late");
});

test("the minute tick makes every answer due again, so shown cards read once more", async () => {
  const { cards, reads, revoke } = setup();
  expect((await cards.view(ref("a")).view).state).toBe("ok");
  revoke();
  cards.tick();
  expect(await cards.view(ref("a")).view).toEqual({ state: "no_access" });
  expect(reads).toEqual(["a", "a"]);
});
