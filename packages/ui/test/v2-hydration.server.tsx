import { generateHydrationScript, renderToString } from "solid-js/web";
import { Fixture } from "./v2-hydration.fixture";

/** The fixture as the server sends it: hydratable markup, the hydration script, and how often its parts were made. */
export const render = () => {
  globalThis.__k2Made = { cells: 0, probe: 0 };
  const html = renderToString(() => <Fixture />);
  return { html, script: generateHydrationScript(), made: { ...globalThis.__k2Made } };
};
