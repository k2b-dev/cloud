import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as helpService from "../services/help";
import { getLayoutHelp, preloadLayoutHelp } from "./help";

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
