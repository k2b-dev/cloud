import { localStore } from "@k2b/stdlib/solid";
import { createInstallPrompt, type InstallationPlatform } from "@k2b/ui";

/** iPhone or iPad in any browser, and the installed app, which may look like a browser inside another app. */
export const onApplePhone = (platform: InstallationPlatform) =>
  platform === "apple-mobile" || platform === "apple-browser" || platform === "apple-in-app";

/** A browser inside another app, which cannot install. */
export const embedded = (platform: InstallationPlatform) => platform === "in-app" || platform === "apple-in-app";

/** The shared installation state, plus whether Cloud Login already introduced installation on this browser. */
export function createInstallation() {
  const [notice, setNotice] = localStore.create("pwa-auth.install-hint", { seen: false });
  const prompt = createInstallPrompt();
  return {
    ...prompt,
    shouldIntroduce: () => notice.seen !== true && !prompt.installed(),
    markIntroduced: () => setNotice("seen", true),
  };
}

export type Installation = ReturnType<typeof createInstallation>;
