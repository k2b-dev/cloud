import { expect, test } from "bun:test";
import { boardStateOf, listStateOf, spaceBoardQuery, spaceListQuery } from "./query";
import { parseFilterFromUrl } from "./types";

const space = {
  columns: [{ id: "Col001", name: "Open" }],
  tags: [{ id: "Tag001", name: "Logistics" }],
};

test("an old link with a deleted tag or status still writes an address: the unknown values are left out", () => {
  const filter = parseFilterFromUrl(new URL("http://spaces.local/app/spaces/Space1?tags=Gone01,Tag001&columns=Gone02&q=banners"));
  const list = listStateOf(filter, space);
  expect(list.filters.tags).toEqual(["Tag001"]);
  expect(list.filters.columns).toBeUndefined();
  expect(spaceListQuery("en", space).serialize(list).get("tags")).toBe("Tag001");

  const board = boardStateOf(parseFilterFromUrl(new URL("http://spaces.local/app/spaces/Space1?tags=Gone01")), space);
  expect(board.filters.tags).toBeUndefined();
  expect(spaceBoardQuery("en", space).serialize(board).has("tags")).toBe(false);
});
