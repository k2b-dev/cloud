/** Test helpers for server-rendered pages. Tests only: no runtime entry point re-exports them. */

import { registeredCoreRoutes, replaceRegisteredCoreRoutesForTest } from "../_internal/runtime-watcher";

/**
 * Runs `render` as beside a current Core, which serves `/public/v2.css`: `MinimalLayout ui="v2"` links that sheet and
 * renders its v2 frame, as in production. A test process has no registered Core, so without this the layout renders the
 * frame for an older Core. The previous state returns when `render` returns, throws, or its promise settles.
 *
 * The stand-in is process-wide: await each call, and do not overlap calls in concurrent tests.
 */
export const withCoreStylesheet = async <T>(render: () => T | Promise<T>): Promise<T> => {
  const previous = replaceRegisteredCoreRoutesForTest([...registeredCoreRoutes(), "/public/v2.css"]);
  try {
    return await render();
  } finally {
    replaceRegisteredCoreRoutesForTest(previous);
  }
};
