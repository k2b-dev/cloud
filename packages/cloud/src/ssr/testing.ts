import { spyOn } from "bun:test";
import * as watcher from "../_internal/runtime-watcher";

/**
 * Renders the following pages as beside a Core that serves `/public/v2.css`, the way a running Cloud does: a page with
 * `MinimalLayout ui="v2"` links v2.css alone and gets its v2 frame and footer. Without it a test has no registered Core
 * and sees the older-Core fallback. Returns the function that ends it; call it in `afterEach`.
 */
export const serveCoreV2Sheet = (): (() => void) => {
  const spy = spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]);
  return () => spy.mockRestore();
};
