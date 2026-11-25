import { generateHydrationScript, renderToString } from "solid-js/web";
import { Fixture } from "./v2-row-select.fixture";

/** The fixture as the server sends it: hydratable markup and the hydration script. */
export const render = () => ({ html: renderToString(() => <Fixture />), script: generateHydrationScript() });
