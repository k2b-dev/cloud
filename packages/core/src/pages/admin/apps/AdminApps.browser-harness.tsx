import { LocaleProvider } from "@k2b/ui";
import { fromJSON } from "seroval";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import AppsScreen from "./AppsScreen";

// Apps on v2: the screen mounts fresh in the page's main area with the props the server rendered (seroval keeps the Map).
const data = document.getElementById("screen-props")!;
const props: Parameters<typeof AppsScreen>[0] = fromJSON(JSON.parse(data.textContent ?? "{}"));
const main = document.querySelector<HTMLElement>("main.k2-ui")!;
main.replaceChildren();
render(
  () =>
    createComponent(LocaleProvider, {
      locale: document.documentElement.lang,
      get children() {
        return createComponent(AppsScreen, props);
      },
    }),
  main,
);
document.body.dataset.ready = "true";
