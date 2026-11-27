import { generateHydrationScript, renderToString } from "solid-js/web";
import { EmptyHead, type EmptyHeadCase } from "./v2-empty-head.fixture";

/** One case of the empty-head fixture as the server sends it: hydratable markup and the hydration script. */
export const render = (which: EmptyHeadCase) => ({
  html: renderToString(() => <EmptyHead which={which} />),
  script: generateHydrationScript(),
});
