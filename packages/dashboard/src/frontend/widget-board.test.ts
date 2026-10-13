import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { WidgetStreamLine } from "@k2b/cloud/contracts";
import { type DashboardTileState, loadDashboardWidgets } from "./widget-board";

/** A stream without a `done` line broke off. */
const stream = (lines: WidgetStreamLine[]) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } });

let fetchSpy: { mockRestore: () => void } | undefined;
afterEach(() => fetchSpy?.mockRestore());
const answerFetch = (respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(respond, { preconnect: globalThis.fetch.preconnect }));
};

describe("loadDashboardWidgets", () => {
  test("asks each widget in its size and reports every widget once, a broken-off one as failed", async () => {
    const bodies: unknown[] = [];
    answerFetch(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return stream([
        { type: "start", widgets: ["spaces/today", "weather/current"] },
        { type: "widget", id: "weather/current", key: "weather/current", status: "empty", ms: 3 },
        // A line for a widget this request did not ask is ignored, and so is a second line for the same widget.
        { type: "widget", key: "quotes/quote", status: "error", ms: 3 },
        { type: "widget", id: "weather/current", key: "weather/current", status: "error", ms: 4 },
      ]);
    });
    const tiles: [string, DashboardTileState][] = [];
    await loadDashboardWidgets({
      widgets: [
        { id: "spaces/today", key: "spaces/today", size: "large" },
        { id: "weather/current", key: "weather/current", size: "small" },
      ],
      signal: new AbortController().signal,
      locale: "de",
      onTile: (id, state) => tiles.push([id, state]),
    });
    expect(bodies).toEqual([
      {
        widgets: [
          { id: "spaces/today", key: "spaces/today", size: "large" },
          { id: "weather/current", key: "weather/current", size: "small" },
        ],
      },
    ]);
    expect(tiles).toEqual([
      ["weather/current", { status: "empty" }],
      ["spaces/today", { status: "error" }],
    ]);
  });

  test("reports nothing once the board stopped waiting", async () => {
    const controller = new AbortController();
    answerFetch(async () => {
      controller.abort();
      return stream([
        { type: "widget", id: "spaces/today", key: "spaces/today", status: "ok", ms: 3, widget: { title: "Today", blocks: [] } },
      ]);
    });
    const tiles: string[] = [];
    await loadDashboardWidgets({
      widgets: [{ id: "spaces/today", key: "spaces/today", size: "large" }],
      signal: controller.signal,
      locale: "en",
      onTile: (id) => tiles.push(id),
    });
    expect(tiles).toEqual([]);
  });
});

test("POST matches repeated keys independently by id, strips titles, and preserves timeout", async () => {
  let body: unknown;
  answerFetch(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return stream([
      { type: "start", widgets: ["first", "second"] },
      { type: "widget", id: "second", key: "spaces/today", status: "timeout", ms: 30_000 },
      { type: "widget", id: "first", key: "spaces/today", status: "empty", ms: 10 },
      { type: "done", status: "partial" },
    ]);
  });
  const tiles: [string, DashboardTileState][] = [];
  await loadDashboardWidgets({
    widgets: [
      { id: "first", key: "spaces/today", size: "large", settings: { space: { type: "spaces.space", id: "a", title: "Home" } } },
      { id: "second", key: "spaces/today", size: "medium", settings: { done: true } },
    ],
    signal: new AbortController().signal,
    locale: "en",
    onTile: (id, state) => tiles.push([id, state]),
  });
  expect(body).toEqual({
    widgets: [
      { id: "first", key: "spaces/today", size: "large", settings: { space: { type: "spaces.space", id: "a" } } },
      { id: "second", key: "spaces/today", size: "medium", settings: { done: true } },
    ],
  });
  expect(tiles).toEqual([
    ["second", { status: "timeout" }],
    ["first", { status: "empty" }],
  ]);
});
