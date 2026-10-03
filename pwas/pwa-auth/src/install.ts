import { localStore } from "@k2b/stdlib/solid";
import { createInstallPrompt } from "@k2b/ui";

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
