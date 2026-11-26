import { afterAll, spyOn } from "bun:test";
import * as watcher from "../../packages/cloud/src/_internal/runtime-watcher";

/**
 * Let app SSR tests render as an installation from the v2 frames on serves them: the registered Core declares its
 * `/public/v2.css`, so a page on `MinimalLayout ui="v2"` or `PwaLayout ui="v2"` links it alone and draws the v2 frame.
 * Without it a test renders the frame beside an older Core, a state no current installation shows.
 *
 * The Core's routes have no public seam; like `tests/fixtures/rail-snapshot.ts`, this reaches the runtime watcher
 * itself. The spy is restored after the calling test file, so another file in the same process sees the real routes.
 */
export const serveCoreV2Sheet = () => {
  const routes = spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]);
  afterAll(() => routes.mockRestore());
  return routes;
};
