import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { PhoneSettingsProps } from "./PhoneSettings";
import SettingsScreen from "./SettingsScreen.island";
import StartScreen, { type StartView } from "./StartScreen.island";

/**
 * The app's islands with the props the page gave them, drawn in the real page, for pictures of the state a person
 * sees once the page runs (live summaries, menus): each takes the place of its island's server markup.
 */
type Shell = { screen: "start"; cloud: string; view: StartView } | { screen: "settings"; props: PhoneSettingsProps };
const data = document.getElementById("shell-props")?.textContent;
if (!data) throw new Error("The page has no shell props");
const shell: Shell = JSON.parse(data);
const island = document.querySelector(
  `solid-island[data-file="${shell.screen === "start" ? "StartScreen" : "SettingsScreen"}.island.tsx"]`,
);
if (!island) throw new Error(`The page has no ${shell.screen} island`);
island.replaceChildren();
render(
  () => (
    <LocaleProvider locale="de">
      {shell.screen === "start" ? <StartScreen cloud={shell.cloud} view={shell.view} /> : <SettingsScreen {...shell.props} />}
    </LocaleProvider>
  ),
  island,
);
document.body.dataset.ready = "true";
