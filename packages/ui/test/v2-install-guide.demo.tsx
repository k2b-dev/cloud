import { createSignal } from "solid-js";
import type { InstallPrompt } from "../src/feedback/install";
import { InstallGuide, Only, Pane, serverInstall, Text, Workspace } from "../src/v2";

// The install guide on several platforms (invented installation), and the content of one kind of device or window.
// `#android` is Chrome on Android: the browser offers its own dialog after the page loads (`window.__offer()`), and
// the guide's place keeps its height. Below it a line that must not move.

declare global {
  interface Window {
    __offer?: () => void;
    __installs?: number;
  }
}

const URL = "https://cloud.example.org/pwa/";

/** Chrome on Android: nothing offered on the server's page; the browser's dialog arrives later. */
const androidPrompt = (): InstallPrompt => {
  const [offered, setOffered] = createSignal(false);
  if (typeof window !== "undefined")
    window.__offer = () => {
      setOffered(true);
    };
  return {
    ...serverInstall("android"),
    canPrompt: offered,
    install: async () => {
      window.__installs = (window.__installs ?? 0) + 1;
    },
  };
};

export function Demo() {
  // once: a prop's expression runs again on every read
  const android = androidPrompt();
  return (
    <Workspace>
      <Pane label="Installieren">
        <div id="android">
          <InstallGuide appName="Lindenhof Cloud" install={android} url={URL} />
          <Text>Unter der Anleitung</Text>
        </div>
        <div id="apple">
          <InstallGuide appName="Lindenhof Cloud" install={serverInstall("apple-mobile")} url={URL} note="Danach koppelst du das Gerät." />
        </div>
        <div id="in-app">
          <InstallGuide appName="Lindenhof Cloud" install={serverInstall("apple-in-app")} url={URL} />
        </div>
        <div id="samsung">
          <InstallGuide appName="Lindenhof Cloud" install={serverInstall("android-samsung")} url={URL} />
        </div>
        <div id="only">
          <Only when="browser">
            <Text>Im Browser</Text>
          </Only>
          <Only when="installed">
            <Text>Installiert</Text>
          </Only>
          <Only when="touch">
            <Text>Mit dem Finger</Text>
          </Only>
          <Only when="pointer">
            <Text>Mit der Maus</Text>
          </Only>
        </div>
      </Pane>
    </Workspace>
  );
}
