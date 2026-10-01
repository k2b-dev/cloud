import { expect, test } from "bun:test";
import { fitSettingsCookie, parseSpaceSettings } from "./SpaceSettingsStore";

const cookie = (spaces: Record<string, unknown>) =>
  `theme=light; settings-app-spaces=${encodeURIComponent(JSON.stringify({ lastSpaceId: null, pinnedSpaceIds: [], spaces }))}`;

test("folded Kanban columns come back from the cookie only as well-formed, unique column keys", () => {
  const settings = parseSpaceSettings(
    cookie({ Space1: { view: "kanban", foldedColumns: ["column:Col001", "column:Col001", "<script>", 7, "column:Col002"] } }),
    "Space1",
  );

  expect(settings).toEqual({ view: "kanban", hideSettings: false, foldedColumns: ["column:Col001", "column:Col002"] });
});

test("a Space without folded columns carries no folded list", () => {
  expect(parseSpaceSettings(cookie({ Space1: { view: "list", foldedColumns: "column:Col001" } }), "Space1")).toEqual({
    view: "list",
    hideSettings: false,
  });
  expect(parseSpaceSettings(undefined, "Space1")).toEqual({ view: "list", hideSettings: false });
});

test("the settings cookie keeps within its size budget by dropping default and least recently written Spaces", () => {
  const folded = Array.from({ length: 40 }, (_, index) => `column:Col${String(index).padStart(3, "0")}`);
  const spaces = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `Space${index.toString(36)}`,
      { view: "kanban", hideSettings: false, foldedColumns: folded },
    ]),
  );
  const fitted = fitSettingsCookie({
    lastSpaceId: "Spaceb",
    pinnedSpaceIds: ["Space1"],
    spaces: { Plain1: { view: "list", hideSettings: false }, ...spaces },
  });

  expect(encodeURIComponent(JSON.stringify(fitted)).length).toBeLessThanOrEqual(4000);
  expect(fitted.spaces.Plain1).toBeUndefined();
  // The newest entries stay; the oldest go first.
  expect(fitted.spaces.Spaceb?.foldedColumns).toEqual(folded);
  expect(fitted.spaces.Space0).toBeUndefined();
  expect(fitted.pinnedSpaceIds).toEqual(["Space1"]);
  expect(fitted.lastSpaceId).toBe("Spaceb");
});
