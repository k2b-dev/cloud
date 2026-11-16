import { expect, test } from "bun:test";
import { gridsPageScope } from "./page-context";

test("opening and closing a live Record detail returns to the Base scope", () => {
  const base = { type: "grids.base", id: "BASE01" };
  expect(gridsPageScope("BASE01", null)).toEqual(base);
  expect(gridsPageScope("BASE01", { id: "REC001", deletedAt: null })).toEqual({ type: "grids.record", id: "REC001" });
  expect(gridsPageScope("BASE01", { id: "REC002", deletedAt: null })).toEqual({ type: "grids.record", id: "REC002" });
  expect(gridsPageScope("BASE01", null)).toEqual(base);
});

test("trashed Records keep the Base discussion because the item reader only accepts live Records", () => {
  expect(gridsPageScope("BASE01", { id: "REC001", deletedAt: "2026-11-01T00:00:00.000Z" })).toEqual({
    type: "grids.base",
    id: "BASE01",
  });
});
