import { generateHydrationScript, renderToString } from "solid-js/web";
import { Fixture } from "./v2-states-navigation.fixture";

/** The fixture as the server sends it (loading): hydratable markup and the hydration script. */
export const render = () => ({ html: renderToString(() => <Fixture />), script: generateHydrationScript() });
