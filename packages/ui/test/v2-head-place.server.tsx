import { generateHydrationScript, renderToString } from "solid-js/web";
import { Fixture, type Kind } from "./v2-head-place.fixture";

/** The fixture as the server sends it: hydratable markup and the hydration script. */
export const render = (kind: Kind) => ({ html: renderToString(() => <Fixture kind={kind} />), script: generateHydrationScript() });
