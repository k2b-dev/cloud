import { LocaleProvider } from "@k2b/ui";
import { createEffect } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { preferences } from "./prefs";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

render(() => {
  createEffect(() => {
    document.documentElement.lang = preferences.locale();
  });
  return (
    <LocaleProvider locale={preferences.locale()}>
      <App />
    </LocaleProvider>
  );
}, root);

// The dev server never registers a worker: reload always reflects the source.
declare const __NOTES_OFFLINE__: boolean;
if (__NOTES_OFFLINE__ && "serviceWorker" in navigator) {
  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
        // Online use keeps working; registration retries on the next visit.
      });
    },
    { once: true },
  );
}
