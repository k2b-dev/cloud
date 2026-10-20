import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import ProfileSettings from "./ProfileSettings.island";

/** Renders the real sign-in actions of a FreeIPA account for a browser test, which answers the password API itself. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <ProfileSettings provider="ipa" profile="user" freeIpaEnabled />
    </LocaleProvider>
  ),
  host,
);
