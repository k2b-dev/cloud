import { expect, test } from "bun:test";
import { headActionFixture } from "./head-action.fixture";
import { launchPages, opensPage, routeTitle, runnable } from "./launch";

const ready = () => {
  const data = headActionFixture("both");
  if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
  return data.state;
};
test("the browser consumes Core's projection and never infers page eligibility or titles from routes", () => {
  const state = ready();
  const home = state.automations![0]!;
  expect(opensPage(home)).toBe(true);
  expect(opensPage({ ...home, isNew: true })).toBe(false);
  expect(opensPage({ ...home, pageLink: undefined })).toBe(false);
  expect(routeTitle(home)).toBe("Startseite");
  expect(launchPages(state)).toBe(state.pages!.pages);
  state.automations = [];
  expect(launchPages(state).map((page) => page.href)).toEqual([`/code/${state.code.id}/`, `/code/${state.code.id}/archive`]);
  state.pages = null;
  state.automations = [home];
  expect(launchPages(state)).toEqual([]);
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
