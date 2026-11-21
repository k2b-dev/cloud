import { expect, test } from "bun:test";
import { recentTestApp, recentTestAuthority, recentTestRegistryApp } from "./recent-resources.test-fixture";
import { AI_RESOURCE_NAME_LIMIT } from "./resource-readers";
import { nameViewReferences } from "./view-names";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const table = (rows: Record<string, unknown>[]) => ({
  view: "table",
  title: "Logistik: Aufgaben mit Frist",
  columns: [{ id: "task", type: "ref" }, { id: "due" }],
  rows,
});

/** Counts what one view costs: registry reads and reader calls, never one per row. */
const meter = (readable: (id: string) => boolean) => {
  const calls = { registry: 0, readers: [] as string[] };
  const dependencies = {
    listApps: async () => [recentTestRegistryApp],
    listRegistry: async () => {
      calls.registry++;
      return [recentTestApp];
    },
    dispatch: async (params: { input: unknown }) => {
      const id = (params.input as { id: string }).id;
      calls.readers.push(id);
      if (!readable(id)) return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
      return Response.json({ data: {}, refs: [{ type: "demo.item", id, title: `Aufgabe ${id}` }] });
    },
  };
  return { calls, dependencies };
};
const name = (bytes: Uint8Array, dependencies: ReturnType<typeof meter>["dependencies"]) =>
  nameViewReferences(bytes, { authority: recentTestAuthority, locale: "de-DE", signal: new AbortController().signal, dependencies });

test("a reference without its title gets the title its reader gives the reading person; one batch per view", async () => {
  const { calls, dependencies } = meter(() => true);
  const rows = Array.from({ length: 30 }, (_, index) => ({ task: { type: "demo.item", id: `t${index % 10}` }, due: "2026-11-16" }));
  const named = decode(await name(encode(table(rows)), dependencies));
  expect(named.rows[0].task).toEqual({ type: "demo.item", id: "t0", title: "Aufgabe t0" });
  expect(named.rows[29].task.title).toBe("Aufgabe t9");
  // 30 rows, 10 distinct references: the registry once, each reference once.
  expect(calls.registry).toBe(1);
  expect(calls.readers.toSorted()).toEqual(Array.from({ length: 10 }, (_, index) => `t${index}`).toSorted());
});

test("a reference the person may not read keeps no title, so the chat shows it as not available, not its id", async () => {
  const { dependencies } = meter((id) => id !== "secret");
  const named = decode(
    await name(encode(table([{ task: { type: "demo.item", id: "secret" } }, { task: { type: "demo.item", id: "open" } }])), dependencies),
  );
  expect(named.rows[0].task).toEqual({ type: "demo.item", id: "secret" });
  expect(named.rows[1].task.title).toBe("Aufgabe open");
});

test("titled references, other views and broken files cost no read; the reads stop at the view limit", async () => {
  const { calls, dependencies } = meter(() => true);
  const titled = encode(table([{ task: { type: "demo.item", id: "a", title: "Schon benannt" } }]));
  expect(await name(titled, dependencies)).toBe(titled);
  const chart = encode({ view: "chart", kind: "bar", title: "B", data: [] });
  expect(await name(chart, dependencies)).toBe(chart);
  const broken = new TextEncoder().encode("{");
  expect(await name(broken, dependencies)).toBe(broken);
  expect(calls).toEqual({ registry: 0, readers: [] });
  const many = Array.from({ length: AI_RESOURCE_NAME_LIMIT + 20 }, (_, index) => ({ task: { type: "demo.item", id: `x${index}` } }));
  await name(encode(table(many)), dependencies);
  expect(calls.registry).toBe(1);
  expect(calls.readers).toHaveLength(AI_RESOURCE_NAME_LIMIT);
});

test("a details view names its reference values the same way", async () => {
  const { dependencies } = meter(() => true);
  const named = decode(
    await name(
      encode({ view: "details", title: "Auftrag", items: [{ label: "Aufgabe", type: "ref", value: { type: "demo.item", id: "d1" } }] }),
      dependencies,
    ),
  );
  expect(named.items[0].value.title).toBe("Aufgabe d1");
});
