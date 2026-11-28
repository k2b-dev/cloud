import { expect, test } from "bun:test";
import { orderSidebarSpaces, SIDEBAR_SEARCH_FROM, sidebarSpaceList } from "./spaces-navigation";

const spaces = [
  { id: "First01", name: "First", color: "#fff", openItemCount: 2 },
  { id: "Other01", name: "Other", color: "#000", openItemCount: 1 },
  { id: "Last001", name: "Last", color: "#111", openItemCount: 0 },
];

test("pins precede unpinned Spaces in stored order without changing the input", () => {
  expect(orderSidebarSpaces(spaces, ["Last001", "missing", "Other01"], []).map((space) => space.id)).toEqual([
    "Last001",
    "Other01",
    "First01",
  ]);
  expect(spaces.map((space) => space.id)).toEqual(["First01", "Other01", "Last001"]);
});

test("recently opened Spaces follow the pins, newest first, and the rest keep the server's order", () => {
  expect(orderSidebarSpaces(spaces, ["Last001"], ["Other01", "Last001"]).map((space) => space.id)).toEqual([
    "Last001",
    "Other01",
    "First01",
  ]);
});

// Thirty invented Spaces as the server lists them, by name: "Space 01" … "Space 30".
const many = Array.from({ length: 30 }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  return { id: `Spc0${n}`, name: `Space ${n}`, color: "#3b82f6", openItemCount: index };
});
const ids = (list: { id: string }[]) => list.map((space) => space.id);

test("thirty Spaces show twenty before a search, pinned and recent first, and count the ten others", () => {
  const list = sidebarSpaceList(many, { pinned: ["Spc029"], recent: ["Spc030", "Spc029"], query: "", locale: "en" });
  expect(list.shown).toHaveLength(20);
  expect(list.hidden).toBe(10);
  expect(ids(list.shown).slice(0, 3)).toEqual(["Spc029", "Spc030", "Spc001"]);
  expect(ids(list.shown)).not.toContain("Spc025");
  expect(many.length).toBeGreaterThanOrEqual(SIDEBAR_SEARCH_FROM);
});

test("the open Space shows even beyond the first twenty", () => {
  const list = sidebarSpaceList(many, { pinned: [], recent: [], currentId: "Spc025", query: "", locale: "en" });
  expect(list.shown).toHaveLength(20);
  expect(ids(list.shown).at(-1)).toBe("Spc025");
  expect(list.hidden).toBe(10);
});

test("a search finds a Space beyond the first twenty by its name, in any case, pinned first", () => {
  expect(ids(sidebarSpaceList(many, { pinned: [], recent: [], query: " space 25 ", locale: "en" }).shown)).toEqual(["Spc025"]);
  const twos = sidebarSpaceList(many, { pinned: ["Spc029"], recent: [], query: "2", locale: "en" });
  // Every name with a 2, the pinned one first, then in the server's order.
  expect(ids(twos.shown)).toEqual([
    "Spc029",
    "Spc002",
    "Spc012",
    "Spc020",
    "Spc021",
    "Spc022",
    "Spc023",
    "Spc024",
    "Spc025",
    "Spc026",
    "Spc027",
    "Spc028",
  ]);
  expect(twos.hidden).toBe(0);
  expect(sidebarSpaceList(many, { pinned: [], recent: [], query: "Nothing", locale: "en" })).toEqual({ shown: [], hidden: 0 });
});
