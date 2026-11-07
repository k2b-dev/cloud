import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AdminNotebooksAppSettings from "./AdminNotebooksAppSettings.island";

/** The real settings button of the Notebooks administration; the test serves the settings API. */
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
        <AdminNotebooksAppSettings />
      </LocaleProvider>
    ),
    host,
  );
};
