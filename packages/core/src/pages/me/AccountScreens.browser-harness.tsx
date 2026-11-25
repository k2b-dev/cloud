import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import ConsentScreen from "../auth/ConsentScreen.island";
import LoginScreen from "../auth/LoginScreen.island";
import { securityProps } from "./account-screens.fixture";
import SecurityScreen from "./SecurityScreen.island";

/** Account and sign-in screens for a browser test: `<html data-screen>` names the screen; the test answers the API. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const screen = document.documentElement.dataset.screen;
render(
  () => (
    <LocaleProvider locale="en">
      {screen === "security" ? (
        <SecurityScreen {...securityProps()} />
      ) : screen === "consent" ? (
        <ConsentScreen
          appName="Cloud"
          legalLinks={[]}
          userId="00000000-0000-4000-8000-000000000042"
          version="v-7"
          redirectTo="/app/files"
        />
      ) : (
        <LoginScreen
          appName="Cloud"
          legalLinks={[]}
          title="Sign in"
          subtitle="Sign in with your FreeIPA password."
          categories={null}
          form={{ kind: "freeipa", showBanner: false }}
          redirectTo="/app/files"
          forget={false}
          signedOutIdle={false}
          others={{ passkey: true, appInstead: null, supportHref: "/impressum", adminHref: "/auth/login?method=admin" }}
        />
      )}
    </LocaleProvider>
  ),
  host,
);
