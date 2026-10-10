import { describe, expect, test } from "bun:test";
import { shouldReloadKanbanColumn } from "./live-scope";

const pages = (...ids: string[]) => ids.map((id) => ({ items: [{ id }] }));
const reloads = (itemId: string | null, held: string[][], probes: (boolean | null)[]) =>
  held.map((ids, index) => shouldReloadKanbanColumn({ itemId, pages: pages(...ids), probe: probes[index] ?? null }));

describe("Kanban live invalidation scope", () => {
  test("a move reloads only the loaded source and the server-probed target", () => {
    expect(reloads("Item01", [["Item02", "Item01"], ["Item03"], ["Item04"]], [false, true, false])).toEqual([true, true, false]);
  });

  test("creation reloads only the target, even when the item is outside the loaded pages or user filter", () => {
    expect(reloads("Item01", [["Item02"], [], ["Item03"]], [false, true, false])).toEqual([false, true, false]);
  });

  test("deletion reloads only the column that held the item", () => {
    expect(reloads("Item01", [["Item02"], ["Item03", "Item01"], []], [false, false, false])).toEqual([false, true, false]);
  });

  test("completion reloads the previous automatic column and the done column", () => {
    expect(reloads("Item01", [[], ["Item01"], [], []], [false, false, false, true])).toEqual([false, true, false, true]);
  });

  test("an update within its column reloads that column only", () => {
    expect(reloads("Item01", [["Item01"], []], [true, false])).toEqual([true, false]);
  });

  test("several changed items, unknown scope, and resync reload all columns", () => {
    expect(reloads(null, [["Item01"], [], ["Item02"]], [false, false, false])).toEqual([true, true, true]);
  });

  test("a failed probe reloads that column while successful unrelated probes skip theirs", () => {
    expect(reloads("Item01", [[], [], []], [false, null, false])).toEqual([false, true, false]);
  });
});
