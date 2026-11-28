import { expect, test } from "bun:test";
import { boardStateOf, legacyFilterHref, listStateOf, spaceBoardQuery, spaceListQuery } from "./query";
import { defaultFilter, parseFilterFromUrl } from "./types";

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

test("an address from before v2 names the same list in the v2 address and keeps every other parameter", () => {
  const at = (search: string) => new URL(`http://spaces.local/app/spaces/Space1${search}`);
  const old = at("?view=table&sort=deadline&sortDesc=true&q=shelf&tags=Tag001&groupBy=none&item=Item01");
  const next = legacyFilterHref(old);
  expect(next).toBe("/app/spaces/Space1?view=table&sort=deadline.desc&q=shelf&tags=Tag001&groupBy=none&item=Item01");
  // The new address shows exactly what the old one showed.
  expect(parseFilterFromUrl(at(next!.slice("/app/spaces/Space1".length)))).toEqual(parseFilterFromUrl(old));
  expect(legacyFilterHref(at("?sort=title"))).toBe("/app/spaces/Space1?sort=title.asc");
  expect(legacyFilterHref(at("?view=list&sortDesc=true"))).toBe(`/app/spaces/Space1?view=list&sort=${defaultFilter.sort}.desc`);
  expect(legacyFilterHref(at("?sort=deadline&sortDesc=false"))).toBe("/app/spaces/Space1?sort=deadline.asc");
  // An address that already is a v2 one stays as it is.
  expect(legacyFilterHref(at("?view=table&sort=deadline.desc&q=shelf"))).toBeNull();
  expect(legacyFilterHref(at("?view=list"))).toBeNull();
});
