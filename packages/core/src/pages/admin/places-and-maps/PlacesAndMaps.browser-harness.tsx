import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import PlacesAndMaps, { type PlacesAndMapsInitial } from "./PlacesAndMaps.island.tsx";

const data = document.querySelector<HTMLScriptElement>("#places-and-maps-fixture-data")!;
const initial: PlacesAndMapsInitial = JSON.parse(data.textContent!);
const root = document.querySelector<HTMLElement>("#places-and-maps-fixture")!;
root.replaceChildren();
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <PlacesAndMaps initial={initial} />
    </LocaleProvider>
  ),
  root,
);
root.dataset.ready = "true";
