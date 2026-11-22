import { describe, expect, test } from "bun:test";
import { dropOverlayPages } from "./drop-overlay-pages";

const people = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `p${index}`, label: `Person ${String(index).padStart(2, "0")}` }));
const labels = {
  title: "Frequent",
  moreTitle: "More",
  more: (count: number) => `More ${count}`,
  range: (a: string, b: string) => `${a} – ${b}`,
};

describe("drop overlay pages", () => {
  test("a short list is one level without a more tile", () => {
    const level = dropOverlayPages("people", people(5), labels);
    expect(level("people")?.tiles.map((tile) => tile.id)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(level("people:more")?.tiles).toEqual([]);
    expect(level("folders")).toBeUndefined();
  });

  test("11 first, then More N; a rest that fits one level opens directly", () => {
    const level = dropOverlayPages("people", people(20), labels);
    const first = level("people")!;
    expect(first.title).toBe("Frequent");
    expect(first.tiles).toHaveLength(12);
    expect(first.tiles.at(-1)).toMatchObject({ label: "More 9", opens: "people:more" });
    expect(level("people:more")?.tiles.map((tile) => tile.id)).toEqual(
      people(20)
        .slice(11)
        .map((person) => person.id),
    );
  });

  test("a long rest becomes name ranges of at most 12, each a level of its own", () => {
    const level = dropOverlayPages("people", people(60), labels);
    const ranges = level("people:more")!.tiles;
    expect(ranges.map((tile) => tile.label)).toEqual([
      "Person 11 – Person 22",
      "Person 23 – Person 34",
      "Person 35 – Person 46",
      "Person 47 – Person 58",
      "Person 59 – Person 59",
    ]);
    expect(ranges.every((tile) => tile.opens === tile.id)).toBe(true);
    expect(level("people:range:4")?.tiles.map((tile) => tile.id)).toEqual(["p59"]);
    expect(level("people:range:5")).toBeUndefined();
    // Every person is reachable exactly once.
    const reached = [...level("people")!.tiles.slice(0, 11), ...ranges.flatMap((tile) => level(tile.opens!)!.tiles)];
    expect(reached.map((tile) => tile.id)).toEqual(people(60).map((person) => person.id));
  });
});
