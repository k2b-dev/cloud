import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { StoreConfig } from "../../store/contracts";
import StoreAdmin from "./StoreAdmin.island";

// The browser test passes the server snapshot and locale in the page's own script tag.
const { initial, locale } = (window as unknown as { __store: { initial: StoreConfig; locale: string } }).__store;
const root = document.getElementById("root");
if (!root) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={locale}>
      <StoreAdmin initial={initial} />
    </LocaleProvider>
  ),
  root,
);
