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
