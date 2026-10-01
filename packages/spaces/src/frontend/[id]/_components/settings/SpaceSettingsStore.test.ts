import { expect, test } from "bun:test";
import { parseSpaceSettings } from "./SpaceSettingsStore";

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
