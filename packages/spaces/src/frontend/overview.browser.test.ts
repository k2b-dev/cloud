import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchHookMs, settled } from "../../../ui/test/browser";
import { createScreenBrowser, layoutProblems, narrow, phone, type View, wide } from "../../test/v2-screen-browser";
import { OVERVIEW_NOW, overviewWork } from "./overview.fixture";

// The Spaces home on v2: the work of a view, what changed lately, the Spaces in the sidebar and a new Space. The test
// stands in for the server: the page renders invented data, and the overview API answers from the same sample.
const screen = createScreenBrowser(resolve(import.meta.dir, "overview.browser-harness.tsx"));
beforeAll(screen.start, launchHookMs);
afterAll(screen.stop);

const work = (view: string) => ({
  ...overviewWork,
  view,
  items: overviewWork.items.map((item) => ({ ...item, title: `${item.title} (${view})` })),
});
const created: unknown[] = [];
const open = (view: View, address = "/app/spaces", state = "") =>
  screen.open(view, address, {
    pages: ["/app/spaces", "/app/spaces/SpaceN1"],
    now: OVERVIEW_NOW,
    state,
    api: (url, route) => {
      if (url.pathname === "/api/spaces/overview/work") return work(url.searchParams.get("view") ?? "mine");
      if (url.pathname === "/api/spaces/overview/activity") return { data: [], nextCursor: null };
      if (url.pathname === "/api/spaces" && route.request().method() === "POST") {
        created.push(route.request().postDataJSON());
        return Response.json(
          {
            id: "SpaceN1",
            name: "Night shift",
            description: null,
            color: "#3b82f6",
            icalToken: null,
            createdAt: "2026-10-15T07:00:00.000Z",
            updatedAt: "2026-10-15T07:00:00.000Z",
          },
          { status: 201 },
        );
      }
      return undefined;
    },
  });

describe("the Spaces home on v2", () => {
  for (const view of [wide, narrow, phone])
    for (const state of ["", "worst"])
      test(`${view.name}${state ? " worst case" : ""}: keeps the v2 rules`, async () => {
        const { context, tab, errors } = await open(view, "/app/spaces", state);
        try {
          expect(await layoutProblems(tab)).toEqual([]);
          expect(await tab.locator('[data-k2-part="Loading"]').count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);

  test("a view opens in place, keeps its address, and Back returns", async () => {
    const { context, tab, errors, visited } = await open(wide);
    try {
      await tab.getByRole("link", { name: /^Today/ }).click();
      await tab.waitForURL(/view=today/);
      await tab.getByText("Clear out shelf B (today)").waitFor();
      await tab.goBack();
      await tab.waitForFunction(() => !location.search.includes("view="));
      await tab.getByText("Clear out shelf B", { exact: true }).waitFor();
      // the page itself never loaded again
      expect(visited).toEqual(["/app/spaces"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a Space's menu pins it to the top, and Undo takes it back", async () => {
    const { context, tab, errors } = await open(wide);
    try {
      const nav = tab.locator('[data-k2-part="Nav"]');
      const spaceNames = () => nav.locator('a[href^="/app/spaces/Space"]').allTextContents();
      expect((await spaceNames())[0]).toContain("Planning");
      await nav.locator('a[href="/app/spaces/Space3"]').hover();
      await tab.getByRole("button", { name: /Trade fair 2026/ }).click();
      await tab.getByRole("menuitem", { name: "Pin Trade fair 2026" }).click();
      await tab.getByText("Pinned Trade fair 2026").waitFor();
      expect((await spaceNames())[0]).toContain("Trade fair 2026");
      await tab.getByRole("button", { name: "Undo" }).click();
      await settled(tab);
      expect((await spaceNames())[0]).toContain("Planning");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("New space asks for the name, creates the Space and opens it", async () => {
    const { context, tab, errors, visited } = await open(wide);
    try {
      await tab.getByRole("button", { name: "New space" }).click();
      const dialog = tab.getByRole("dialog", { name: "New space" });
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Create" }).click();
      await dialog.getByText("Required.").waitFor();
      expect(created).toEqual([]);
      await dialog.getByRole("textbox", { name: "Name" }).fill("Night shift");
      await dialog.getByRole("button", { name: "Create" }).click();
      await tab.waitForURL(/\/app\/spaces\/SpaceN1$/);
      expect(created).toEqual([{ name: "Night shift", color: "#3b82f6", starter: "blank" }]);
      expect(visited.at(-1)).toBe("/app/spaces/SpaceN1");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on the phone the activity stands below the work", async () => {
    const { context, tab, errors } = await open(phone);
    try {
      const workBox = await tab.locator('[data-k2-part="Pane"]:not([data-side])').boundingBox();
      const activityBox = await tab.locator('[data-k2-part="Pane"][data-side]').boundingBox();
      expect(workBox && activityBox && activityBox.y >= workBox.y + workBox.height - 1).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
