import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { WidgetStreamLine } from "@k2b/cloud/contracts";
import { type DashboardTileState, loadDashboardWidgets } from "./widget-board";

/** A stream without a `done` line broke off. */
const stream = (lines: WidgetStreamLine[]) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } });

let fetchSpy: { mockRestore: () => void } | undefined;
afterEach(() => fetchSpy?.mockRestore());
const answerFetch = (respond: (input: string | URL | Request) => Promise<Response>) => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(respond, { preconnect: globalThis.fetch.preconnect }));
};

describe("loadDashboardWidgets", () => {
  test("asks each widget in its size and reports every widget once, a broken-off one as failed", async () => {
    const urls: string[] = [];
    answerFetch(async (input) => {
      urls.push(String(input));
      return stream([
        { type: "start", widgets: ["spaces/today", "weather/current"] },
        { type: "widget", key: "weather/current", status: "empty", ms: 3 },
        // A line for a widget this request did not ask is ignored, and so is a second line for the same widget.
        { type: "widget", key: "quotes/quote", status: "error", ms: 3 },
        { type: "widget", key: "weather/current", status: "error", ms: 4 },
      ]);
    });
    const tiles: [string, DashboardTileState][] = [];
    await loadDashboardWidgets({
      widgets: [
        { key: "spaces/today", size: "large" },
        { key: "weather/current", size: "small" },
      ],
      signal: new AbortController().signal,
      locale: "de",
      onTile: (key, state) => tiles.push([key, state]),
    });
    expect(new URL(urls[0]!, "https://cloud.test").searchParams.getAll("widget")).toEqual(["spaces/today@large", "weather/current@small"]);
    expect(tiles).toEqual([
      ["weather/current", { status: "empty" }],
      ["spaces/today", { status: "error" }],
    ]);
  });

  test("reports nothing once the board stopped waiting", async () => {
    const controller = new AbortController();
    answerFetch(async () => {
      controller.abort();
      return stream([{ type: "widget", key: "spaces/today", status: "ok", ms: 3, widget: { title: "Today", blocks: [] } }]);
    });
    const tiles: string[] = [];
    await loadDashboardWidgets({
      widgets: [{ key: "spaces/today", size: "large" }],
      signal: controller.signal,
      locale: "en",
      onTile: (key) => tiles.push(key),
    });
    expect(tiles).toEqual([]);
  });
});
