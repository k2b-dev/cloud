import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import StorageScreen from "./StorageScreen";

// Storage on v2: the screen mounts fresh in the page's main area with the props the server rendered.
const data = document.getElementById("screen-props")!;
const props: Parameters<typeof StorageScreen>[0] = JSON.parse(data.textContent ?? "{}");
const main = document.querySelector<HTMLElement>("main.k2-ui")!;
main.replaceChildren();
render(
  () =>
    createComponent(LocaleProvider, {
      locale: document.documentElement.lang,
      get children() {
        return createComponent(StorageScreen, props);
      },
    }),
  main,
);
document.body.dataset.ready = "true";
