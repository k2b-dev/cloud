import { spyOn } from "bun:test";
import * as watcher from "../../packages/cloud/src/_internal/runtime-watcher";

/**
 * Let app SSR tests render as an installation from the v2 visitor pages on serves them: the registered Core declares
 * its `/public/v2.css`, so a page on `MinimalLayout ui="v2"` links it alone and draws the v2 frame (tinted page, v2
 * footer). Without it a test renders the frame beside an older Core, a state no current installation shows.
 */
export const serveCoreV2Sheet = () => spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]);
