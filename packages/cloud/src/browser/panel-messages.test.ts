import { expect, test } from "bun:test";
import { isPanelCloseMessage, isPanelReadyMessage, isPanelSearchMessage } from "./panel-messages";

test("search requires exactly its type and version 1", () => {
  const search = { type: "cloud.panel.search", v: 1 };
  expect(isPanelSearchMessage(search)).toBe(true);
  for (const value of [
    null,
    [],
    "cloud.panel.search",
    {},
    { type: search.type },
    { v: 1 },
    { ...search, type: "cloud.panel.close" },
    { ...search, v: 2 },
    { ...search, v: "1" },
    { ...search, extra: true },
    { ...search, [Symbol("extra")]: true },
    Object.create(search),
  ]) {
    expect(isPanelSearchMessage(value)).toBe(false);
  }
});

test("accepts only the exact ready shape and expected provider", () => {
  const ready = { type: "cloud.panel.ready", v: 1, provider: "fixture" };
  expect(isPanelReadyMessage(ready, "fixture")).toBe(true);
  for (const value of [
    null,
    [],
    "cloud.panel.ready",
    { ...ready, extra: true },
    { ...ready, v: 2 },
    { ...ready, v: "1" },
    { ...ready, provider: 1 },
    { ...ready, provider: "other" },
    { ...ready, [Symbol("extra")]: true },
    { type: ready.type, provider: ready.provider },
  ]) {
    expect(isPanelReadyMessage(value, "fixture")).toBe(false);
  }
});

test("close allows only its type and optional version 1", () => {
  expect(isPanelCloseMessage({ type: "cloud.panel.close" })).toBe(true);
  expect(isPanelCloseMessage({ type: "cloud.panel.close", v: 1 })).toBe(true);
  for (const value of [
    null,
    [],
    "cloud.panel.close",
    {},
    { type: "cloud.panel.close", extra: true },
    { type: "cloud.panel.close", v: 2 },
    { type: "cloud.panel.close", v: undefined },
    { type: "cloud.panel.close", v: 1, provider: "fixture" },
  ]) {
    expect(isPanelCloseMessage(value)).toBe(false);
  }
});
