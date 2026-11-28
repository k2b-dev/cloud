import { robotAvatarFromSeed, seededRandom } from "@k2b/cloud/contracts/avatar";
import { renderAvatarSvg } from "@k2b/cloud/shared";
import { LocaleProvider } from "@k2b/ui";
import { Button } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import { useAccountMessages } from "./AccountWorkspace";
import { useProfileActions } from "./profile-actions";

/** Renders the real "Change picture" deed of /me for a browser test, which answers the avatar API itself. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
// The browser draws with the same code as the server; the test compares both outputs.
Object.assign(window, { avatarArt: { renderAvatarSvg, robotAvatarFromSeed } });
// This seed starts with red hair and an afro: choosing those again must not count as an edit.
Math.random = seededRandom("profile-picture-2");
const Trigger = () => {
  const t = useAccountMessages();
  const actions = useProfileActions({
    user: { provider: "local", uid: "malbers", givenname: "Mara", sn: "Albers", displayName: "Mara Albers", ipa: null },
    appName: "Cloud",
    freeIpaEnabled: false,
  });
  return <Button onClick={actions.changeAvatar}>{t().changeAvatar}</Button>;
};
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <Trigger />
    </LocaleProvider>
  ),
  host,
);
