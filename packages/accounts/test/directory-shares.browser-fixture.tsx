import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import DirectoryShares from "../src/frontend/service-accounts/DirectoryShares.island";

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
render(
  () => (
    <LocaleProvider locale="en">
      <DirectoryShares />
    </LocaleProvider>
  ),
  root,
);
