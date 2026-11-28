import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import Maintenance from "./Maintenance";

const data = document.querySelector<HTMLScriptElement>("#maintenance-fixture-data")!;
const props: Parameters<typeof Maintenance>[0] = JSON.parse(data.textContent!);
const root = document.querySelector<HTMLElement>("main.k2-ui")!;
root.replaceChildren();
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <Maintenance {...props} />
    </LocaleProvider>
  ),
  root,
);
root.dataset.ready = "true";
