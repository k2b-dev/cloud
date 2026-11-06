import { afterEach, expect, test } from "bun:test";
import { monthStrip, recordWriting } from "./activity";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
function storage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  return values;
}
test("local dates, month length, activity levels and 62-day retention", () => {
  const values = storage();
  const now = new Date(2026, 9, 30, 12);
  recordWriting(new Date(2026, 6, 1, 12));
  recordWriting(new Date(2026, 7, 30, 12));
  recordWriting(new Date(2026, 9, 1, 12));
  for (let i = 0; i < 6; i++) recordWriting(new Date(2026, 9, 2, 12));
  for (let i = 0; i < 21; i++) recordWriting(now);
  const strip = monthStrip(now);
  expect(strip.month).toBe(10);
  expect(strip.days).toHaveLength(31);
  expect(strip.activeDays).toBe(3);
  expect(strip.days[0]?.level).toBe(1);
  expect(strip.days[1]?.level).toBe(2);
  expect(strip.days[29]).toEqual({ day: 30, level: 3, today: true });
  expect(values.get("k2b-notes.activity")).not.toContain("2026-07-01");
  expect(monthStrip(new Date(2028, 1, 2)).days).toHaveLength(29);
});
test("invalid or unavailable localStorage remains usable", () => {
  const values = storage();
  values.set("k2b-notes.activity", "invalid");
  expect(monthStrip(new Date(2026, 9, 30)).activeDays).toBe(0);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("unavailable");
    },
  });
  expect(() => recordWriting(new Date(2026, 9, 30))).not.toThrow();
});

test("only local text editing records writing activity", async () => {
  const values = storage();
  const { MemoryBackend, openNotesStore } = await import("./local");
  const Y = await import("yjs");
  const now = new Date(2026, 9, 30, 12).getTime();
  const store = await openNotesStore({ backend: new MemoryBackend(), now: () => now, locks: null });
  const remote = new Y.Doc();
  try {
    const id = await store.create("a");
    const note = await store.open(id);
    note.text.insert(1, "b");
    await store.flush();
    Y.applyUpdate(remote, await store.encodeState(id));
    remote.getText("text").insert(0, "remote");
    await store.applyUpdate(id, Y.encodeStateAsUpdate(remote));
    note.doc.transact(() => note.text.insert(0, "import"), "import");
    await store.flush();
    expect(values.get("k2b-notes.activity")).toBe('{"2026-10-30":1}');
  } finally {
    remote.destroy();
    await store.close();
  }
});
