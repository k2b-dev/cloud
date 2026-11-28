import { LocaleProvider } from "@k2b/ui";
import { Pane } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import AccountWorkspace from "./AccountWorkspace";
import { quietSettings, securityProps, userView } from "./account-screens.fixture";
import QuietTimeSection from "./QuietTimeSection";
import SecurityScreen from "./SecurityScreen.island";

/** Account screens for a browser test: `<html data-screen>` names the screen; the test answers the API. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const screen = document.documentElement.dataset.screen;
render(
  () => (
    <LocaleProvider locale="en">
      {screen === "security" ? (
        <SecurityScreen {...securityProps()} />
      ) : screen === "quiet" ? (
        <AccountWorkspace user={userView} place="notifications">
          <Pane label="Do not disturb">
            <QuietTimeSection initial={quietSettings} dateConfig={{ timeZone: "Europe/Berlin", locale: "en", firstDayOfWeek: 1 }} />
          </Pane>
        </AccountWorkspace>
      ) : null}
    </LocaleProvider>
  ),
  host,
);
