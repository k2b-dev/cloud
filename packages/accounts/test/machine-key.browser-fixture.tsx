import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import CreateMachineKey from "../src/frontend/service-accounts/CreateMachineKey.island";

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
render(
  () => (
    <LocaleProvider locale="en">
      <CreateMachineKey modelsAvailable />
    </LocaleProvider>
  ),
  root,
);
