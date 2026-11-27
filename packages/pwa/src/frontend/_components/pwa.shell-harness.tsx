import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import BlockedScreen from "./BlockedScreen.island";
import type { PhoneSettingsProps } from "./PhoneSettings";
import SettingsScreen from "./SettingsScreen.island";
import StartScreen, { type StartScreenProps } from "./StartScreen.island";
import Unavailable from "./Unavailable.island";

/**
 * The app's islands with the props the page gave them, drawn in the real page, for pictures of the state a person
 * sees once the page runs (live summaries, menus): each takes the place of its island's server markup.
 */
type Shell =
  | { screen: "StartScreen"; props: StartScreenProps }
  | { screen: "BlockedScreen"; props: { cloud: string } }
  | { screen: "Unavailable"; props: { cloud: string; rotationGraceSeconds: number } }
  | { screen: "SettingsScreen"; props: PhoneSettingsProps };
const data = document.getElementById("shell-props")?.textContent;
if (!data) throw new Error("The page has no shell props");
const shell: Shell = JSON.parse(data);
const island = document.querySelector(`solid-island[data-file="${shell.screen}.island.tsx"]`);
if (!island) throw new Error(`The page has no ${shell.screen} island`);
island.replaceChildren();
render(
  () => (
    <LocaleProvider locale="de">
      {shell.screen === "StartScreen" ? (
        <StartScreen {...shell.props} />
      ) : shell.screen === "BlockedScreen" ? (
        <BlockedScreen {...shell.props} />
      ) : shell.screen === "Unavailable" ? (
        <Unavailable {...shell.props} />
      ) : (
        <SettingsScreen {...shell.props} />
      )}
    </LocaleProvider>
  ),
  island,
);
document.body.dataset.ready = "true";
