import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AppDevices from "./AppDevices.island";

/** Renders the real phone list and pairing dialog for a browser test, which answers the pairing API with invented data. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <AppDevices userId="00000000-0000-4000-8000-000000000042" initial={[]} dateConfig={{ timeZone: "UTC" }} />
    </LocaleProvider>
  ),
  host,
);
