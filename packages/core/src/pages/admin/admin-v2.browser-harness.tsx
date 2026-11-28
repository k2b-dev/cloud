import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import AnnouncementsScreen from "./announcements/AnnouncementsScreen";
import OverviewScreen from "./OverviewScreen";
import NavigationScreen from "./rail/NavigationScreen";

// The overview, announcements or navigation on v2: the screen mounts fresh in the page's main area with the server's props.
const data = document.getElementById("screen-props")!;
const main = document.querySelector<HTMLElement>("main.k2-ui")!;
const text = data.textContent ?? "{}";
const screen = (): JSX.Element => {
  if (data.dataset.screen === "announcements") {
    const props: Parameters<typeof AnnouncementsScreen>[0] = JSON.parse(text);
    return createComponent(AnnouncementsScreen, props);
  }
  if (data.dataset.screen === "navigation") {
    const props: Parameters<typeof NavigationScreen>[0] = JSON.parse(text);
    return createComponent(NavigationScreen, props);
  }
  const props: Parameters<typeof OverviewScreen>[0] = JSON.parse(text);
  return createComponent(OverviewScreen, props);
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
