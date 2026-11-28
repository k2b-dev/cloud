import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import AppsScreen from "./AppsScreen";
import LogScreen from "./LogScreen";
import ProfilesScreen from "./ProfilesScreen";

// A section of Outgoing mail on v2: the screen mounts fresh in the page's main area with the props the server rendered.
const data = document.getElementById("screen-props")!;
const main = document.querySelector<HTMLElement>("main.k2-ui")!;
const text = data.textContent ?? "{}";
const screen = (): JSX.Element => {
  if (data.dataset.screen === "apps") {
    const props: Parameters<typeof AppsScreen>[0] = JSON.parse(text);
    return createComponent(AppsScreen, props);
  }
  if (data.dataset.screen === "log") {
    const props: Parameters<typeof LogScreen>[0] = JSON.parse(text);
    return createComponent(LogScreen, props);
  }
  const props: Parameters<typeof ProfilesScreen>[0] = JSON.parse(text);
  return createComponent(ProfilesScreen, props);
};
main.replaceChildren();
render(
  () =>
    createComponent(LocaleProvider, {
      locale: document.documentElement.lang,
      get children() {
        return screen();
      },
    }),
  main,
);
main.dataset.ready = "true";
