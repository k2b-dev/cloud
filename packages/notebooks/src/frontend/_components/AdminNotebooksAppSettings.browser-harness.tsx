import { LocaleProvider } from "@k2b/ui";
import { Button } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import { openNotebooksAppSettings } from "./AdminNotebooksAppSettings";

/** The settings of the Notebooks administration, opened as its head's button does; the test serves the settings API. */
declare global {
  interface Window {
    mountSettings: (locale: string) => void;
  }
}

window.mountSettings = (locale) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <div class="k2-ui">
          <Button icon="settings" onClick={() => void openNotebooksAppSettings()}>
            {locale === "de" ? "Einstellungen" : "Settings"}
          </Button>
        </div>
      </LocaleProvider>
    ),
    host,
  );
};
