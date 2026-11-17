import { expect, test } from "bun:test";
import { codePageLinks } from "../../contracts";
import { headActionFixture } from "./head-action.fixture";
import { launchPages, opensPage, routeHref, routeTitle, runnable } from "./launch";
import { codePageMessages } from "./messages";

const ready = () => {
  const data = headActionFixture("both");
  if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
  return data.state;
};
test("only current private literal GET/ALL pages can open; data, inputs, public and parameter routes cannot", () => {
  const page = ready().automations![0]!;
  for (const route of [
    { method: "GET", path: "/", public: false, page: true },
    { method: "ALL", path: "/home", public: false, page: true },
    { method: "GET", path: "/legacy", public: false },
  ])
    expect(opensPage({ ...page, route })).toBe(true);
  for (const route of [
    { method: "POST", path: "/", public: false, page: true },
    { method: "GET", path: "/", public: true, page: true },
    { method: "GET", path: "/:name", public: false, page: true },
    { method: "GET", path: "/data", public: false, page: false },
  ])
    expect(opensPage({ ...page, route })).toBe(false);
  expect(opensPage({ ...page, isNew: true })).toBe(false);
});
test("root is home; otherwise declaration order wins; root title is localized and addresses are Code-relative", () => {
  const state = ready();
  const pages = state.automations!.filter(opensPage).reverse();
  state.automations = pages;
  expect(launchPages(state).map((page) => page.route!.path)).toEqual(["/", "/archive"]);
  state.automations = pages.filter((page) => page.route!.path !== "/");
  expect(launchPages(state)[0]!.route!.path).toBe("/archive");
  const home = pages.find((page) => page.route!.path === "/")!;
  expect(routeTitle(home, codePageMessages.resolve(["de"]).t)).toBe("Startseite");
  expect(routeTitle(home, codePageMessages.resolve(["en"]).t)).toBe("Home page");
  expect(routeTitle({ ...home, route: { ...home.route!, page: false } }, codePageMessages.resolve(["de"]).t)).toBe("/");
  expect(routeHref("c_demo", home)).toBe("/code/c_demo/");
});
test("only editors of an active Code can start current manual and scheduled entries", () => {
  const state = ready();
  expect(runnable(state).map((item) => item.kind)).toEqual(["schedule", "schedule"]);
  state.permission = "reader";
  expect(runnable(state)).toEqual([]);
  state.permission = "editor";
  state.code.state = "paused";
  expect(runnable(state)).toEqual([]);
});

test("the public page-link selector gives activation handoffs the same home and remaining pages", () => {
  const entries = ready().automations!.reverse();
  expect(codePageLinks("c_demo", entries).map((page) => page.href)).toEqual(["/code/c_demo/", "/code/c_demo/archive"]);
  expect(
    codePageLinks(
      "c_demo",
      entries.filter((entry) => entry.kind !== "route"),
    ),
  ).toEqual([]);
});
