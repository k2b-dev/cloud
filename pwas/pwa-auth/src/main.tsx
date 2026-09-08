import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { App } from "./App";
import { createPreferences } from "./preferences";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

render(() => {
  const preferences = createPreferences();
  return (
    <LocaleProvider locale={preferences.locale()}>
      <App preferences={preferences} />
    </LocaleProvider>
  );
}, root);

// The dev server deliberately never registers a worker: reload always reflects source.
declare const __PWA_OFFLINE__: boolean;
if (__PWA_OFFLINE__ && "serviceWorker" in navigator) {
  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
        // Online use remains available; retry registration on the next launch.
      });
    },
    { once: true },
  );
}
