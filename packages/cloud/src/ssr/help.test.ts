import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as helpService from "../services/help";
import { getLayoutHelp, layoutHelpFailed, preloadLayoutHelp } from "./help";

test("Help metadata needs a signed-in user, also for an explicit app", async () => {
  const reader = spyOn(helpService, "createHelpReader");
  try {
    const response = await new Hono<{ Variables: { runtime: { apps: [] } } }>()
      .get("/", async (c) => {
        c.set("runtime", { apps: [] });
        return c.json({ explicit: await preloadLayoutHelp(c, "grids"), current: await preloadLayoutHelp(c), layout: getLayoutHelp(c) });
      })
      .request("/");
    expect(await response.json()).toEqual({ explicit: null, current: null, layout: null });
    expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});

for (const failed of [false, true]) {
  test(`Help metadata ${failed ? "records a failed read" : "does not treat a null manifest as a failure"}`, async () => {
    const reader = spyOn(helpService, "createHelpReader").mockReturnValue({
      manifest: async () => {
        if (failed) throw new Error("Help store unavailable");
        return null;
      },
      list: async () => [],
      read: async () => null,
      search: async () => [],
    });
    try {
      const response = await new Hono<{ Variables: { runtime: { apps: [] }; user: { id: string } } }>()
        .get("/", async (c) => {
          c.set("runtime", { apps: [] });
          c.set("user", { id: "help-reader" });
          expect(layoutHelpFailed(c)).toBe(false);
          expect(await preloadLayoutHelp(c, "grids")).toBeNull();
          expect(await preloadLayoutHelp(c, "grids")).toBeNull();
          return c.json({ failed: layoutHelpFailed(c), layout: getLayoutHelp(c) });
        })
        .request("/");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ failed, layout: null });
      expect(reader).toHaveBeenCalledTimes(1);
    } finally {
      reader.mockRestore();
    }
  });
}
