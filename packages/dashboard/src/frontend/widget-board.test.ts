import { describe, expect, test } from "bun:test";
import { DASHBOARD_MAX_ID_LENGTH, type DashboardWidgetSummary } from "../shared";
import {
  applyDashboardWidgetLine,
  breakDashboardTiles,
  type DashboardTiles,
  dashboardWidgetHintCookie,
  loadingDashboardTiles,
  nextDashboardWidgetHint,
  readDashboardWidgetHint,
  summarizeDashboardWidgets,
} from "./widget-board";

const ok = (title: string) => ({ title, blocks: [] });

describe("dashboard widget board", () => {
  test("settles each widget once, from its own line, and ignores lines for widgets it did not ask", () => {
    let tiles = loadingDashboardTiles({}, ["a/x", "b/x", "c/x"]);
    tiles = applyDashboardWidgetLine(tiles, { type: "start", widgets: ["a/x", "b/x", "c/x"] });
    tiles = applyDashboardWidgetLine(tiles, { type: "widget", key: "b/x", status: "ok", widget: ok("B"), ms: 3 });
    tiles = applyDashboardWidgetLine(tiles, { type: "widget", key: "b/x", status: "error", ms: 4 });
    tiles = applyDashboardWidgetLine(tiles, { type: "widget", key: "z/x", status: "ok", widget: ok("Z"), ms: 4 });
    tiles = applyDashboardWidgetLine(tiles, { type: "widget", key: "c/x", status: "timeout", ms: 8000 });
    expect(tiles).toEqual({
      "a/x": { status: "loading" },
      "b/x": { status: "ok", widget: ok("B") },
      "c/x": { status: "timeout" },
    });
  });

  test("a broken stream fails only the widgets still loading, and a retry reloads only its widget", () => {
    let tiles: DashboardTiles = {
      "a/x": { status: "ok", widget: ok("A") },
      "b/x": { status: "loading" },
    };
    tiles = breakDashboardTiles(tiles, ["a/x", "b/x"]);
    expect(tiles).toEqual({ "a/x": { status: "ok", widget: ok("A") }, "b/x": { status: "error" } });
    tiles = loadingDashboardTiles(tiles, ["b/x"]);
    expect(tiles["a/x"]).toEqual({ status: "ok", widget: ok("A") });
    expect(tiles["b/x"]).toEqual({ status: "loading" });
  });

  test("remembers which widgets answered 403 or 204 and forgets them once they have content", () => {
    const hint = { owner: "account", forbidden: ["admin/queue", "gone/x", "hidden/x"], empty: ["spaces/today", "notes/recent"] };
    const tiles: DashboardTiles = {
      "admin/queue": { status: "forbidden" },
      "spaces/today": { status: "ok", widget: ok("Today") },
      "notes/recent": { status: "timeout" },
      "quotes/quote": { status: "empty" },
      "health/x": { status: "forbidden" },
    };
    // "gone/x" is no longer declared and "hidden/x" is hidden: neither is asked, so both drop out.
    const requested = ["admin/queue", "spaces/today", "notes/recent", "quotes/quote", "health/x"];
    expect(nextDashboardWidgetHint(hint, tiles, requested)).toEqual({
      owner: "account",
      forbidden: ["admin/queue", "health/x"],
      // A widget that failed keeps what was known about it.
      empty: ["notes/recent", "quotes/quote"],
    });
  });

  test("reads only a well-formed, bounded hint of the same account from the cookie header", () => {
    const cookie = dashboardWidgetHintCookie({ owner: "account", forbidden: ["a/x"], empty: ["b/x"] }, true);
    expect(cookie).toContain("path=/app/dashboard");
    expect(cookie).toContain("secure");
    const value = cookie.split(";")[0]!;
    expect(readDashboardWidgetHint(`theme=dark; ${value}; other=1`, "account")).toEqual({
      owner: "account",
      forbidden: ["a/x"],
      empty: ["b/x"],
    });
    // Another account on the same device starts without a hint.
    expect(readDashboardWidgetHint(value, "other")).toEqual({ owner: "other", forbidden: [], empty: [] });
    for (const broken of [
      "",
      "dashboard_widgets=%7B",
      "dashboard_widgets=%5B%5D",
      `dashboard_widgets=${encodeURIComponent('{"owner":"account","forbidden":[1,""]}')}`,
      `dashboard_widgets=${encodeURIComponent('{"forbidden":["a/x"]}')}`,
    ])
      expect(readDashboardWidgetHint(broken, "account")).toEqual({ owner: "account", forbidden: [], empty: [] });
    const many = Array.from({ length: 500 }, (_, index) => `app/${index}`);
    expect(
      readDashboardWidgetHint(`dashboard_widgets=${encodeURIComponent(JSON.stringify({ owner: "account", forbidden: many }))}`, "account")
        .forbidden,
    ).toHaveLength(100);
  });

  test("writes a hint that a browser keeps, even at the largest size it can read", () => {
    // The most the read side accepts: 100 keys per list, each as long as a key may be.
    const keys = (list: string) => Array.from({ length: 100 }, (_, index) => `${list}-${index}/`.padEnd(2 * DASHBOARD_MAX_ID_LENGTH, "x"));
    const hint = { owner: "account", forbidden: keys("forbidden"), empty: keys("empty") };
    const cookie = dashboardWidgetHintCookie(hint, true);
    expect(cookie.length).toBeLessThanOrEqual(4096);
    expect(cookie).toEndWith("; secure");
    // It keeps as many widgets as fit, and leaves the empty ones out before the locked ones.
    const kept = readDashboardWidgetHint(cookie.split(";")[0]!, "account");
    expect(kept.forbidden.length).toBeGreaterThan(0);
    expect(kept.empty).toEqual([]);
    expect(hint.forbidden.slice(0, kept.forbidden.length)).toEqual(kept.forbidden);
    // A hint that fits is written whole.
    const small = { owner: "account", forbidden: keys("forbidden").slice(0, 2), empty: keys("empty").slice(0, 2) };
    expect(readDashboardWidgetHint(dashboardWidgetHintCookie(small, false).split(";")[0]!, "account")).toEqual(small);
  });

  test("lists widgets in the edit dialog by their answer on this page, and by the hint until then", () => {
    const widgets: DashboardWidgetSummary[] = ["a/x", "b/x", "c/x", "d/x", "e/x"].map((key) => ({ key, title: key, icon: "ti ti-box" }));
    const hint = { owner: "account", forbidden: ["a/x"], empty: ["b/x", "e/x"] };
    const tiles: DashboardTiles = {
      "a/x": { status: "loading" },
      "c/x": { status: "forbidden" },
      "d/x": { status: "ok", widget: { title: "Today", icon: "ti ti-sun", blocks: [] } },
    };
    const lists = summarizeDashboardWidgets(widgets, hint, tiles, ["e/x"]);
    expect(lists.inaccessible.map((widget) => widget.key)).toEqual(["a/x", "c/x"]);
    expect(lists.available).toEqual([
      { key: "d/x", title: "Today", icon: "ti ti-sun" },
      { key: "e/x", title: "e/x", icon: "ti ti-box" },
    ]);
  });

  test("always lists a hidden widget as available, whatever the hint says, so it can be shown again", () => {
    const widgets: DashboardWidgetSummary[] = ["a/x", "b/x"].map((key) => ({ key, title: key, icon: "ti ti-box" }));
    // Another session on this device once saw "a/x" answer 403; the user has hidden it and is never asked for it.
    const lists = summarizeDashboardWidgets(widgets, { owner: "account", forbidden: ["a/x"], empty: [] }, {}, ["a/x"]);
    expect(lists.inaccessible).toEqual([]);
    expect(lists.available.map((widget) => widget.key)).toEqual(["a/x", "b/x"]);
  });
});
