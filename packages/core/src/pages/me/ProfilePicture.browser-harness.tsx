import { robotAvatarFromSeed } from "@k2b/cloud/contracts/avatar";
import { renderAvatarSvg } from "@k2b/cloud/shared";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import ProfileActions from "./ProfileActions.island";

/** Renders the real avatar trigger of /me for a browser test, which answers the avatar API itself. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
// The browser draws with the same code as the server; the test compares both outputs.
Object.assign(window, { avatarArt: { renderAvatarSvg, robotAvatarFromSeed } });
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <ProfileActions
        userId="0b2f5c7e-0000-4000-8000-0000000000aa"
        provider="local"
        profile="user"
        uid="malbers"
        givenname="Mara"
        sn="Albers"
        displayName="Mara Albers"
        avatarHash={null}
        ipa={null}
        freeIpaEnabled={false}
        actions={["avatar"]}
        trigger="avatar"
      />
    </LocaleProvider>
  ),
  host,
);
