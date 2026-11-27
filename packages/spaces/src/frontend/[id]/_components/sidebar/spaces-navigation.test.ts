import { expect, test } from "bun:test";
import { orderSidebarSpaces } from "./spaces-navigation";

const spaces = [
  { id: "First01", name: "First", color: "#fff", openItemCount: 2 },
  { id: "Other01", name: "Other", color: "#000", openItemCount: 1 },
  { id: "Last001", name: "Last", color: "#111", openItemCount: 0 },
];

test("pins precede unpinned Spaces in stored order without changing the input", () => {
  expect(orderSidebarSpaces(spaces, ["Last001", "missing", "Other01"]).map((space) => space.id)).toEqual(["Last001", "Other01", "First01"]);
  expect(spaces.map((space) => space.id)).toEqual(["First01", "Other01", "Last001"]);
});
