import { generateHydrationScript, renderToString } from "solid-js/web";
import { LocaleProvider } from "../src/intl/locale";
import { Demo } from "./v2-head-search.demo";

/** The head search as the server sends it, in German as the page says (`lang="de"`): hydratable markup and the hydration script. */
export const render = () => ({
  html: renderToString(() => (
    <LocaleProvider locale="de">
      <Demo />
    </LocaleProvider>
  )),
  script: generateHydrationScript(),
});
