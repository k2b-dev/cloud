import { generateHydrationScript, renderToString } from "solid-js/web";
import { Fixture } from "./v2-drawer.fixture";

/** The fixture as the server sends it: hydratable markup and the hydration script. */
export const render = () => ({ html: renderToString(() => <Fixture />), script: generateHydrationScript() });
