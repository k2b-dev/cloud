import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import { render } from "solid-js/web";
import PlacesAndMaps from "./PlacesAndMaps.island.tsx";

// The page as the server sent it, then the screen mounted fresh in its place with the same props.
const data = document.querySelector<HTMLScriptElement>("#places-and-maps-fixture-data")!;
const props: ComponentProps<typeof PlacesAndMaps> = JSON.parse(data.textContent!);
const root = document.querySelector<HTMLElement>("main.k2-ui")!;
root.replaceChildren();
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <PlacesAndMaps {...props} />
    </LocaleProvider>
  ),
  root,
);
root.dataset.ready = "true";
