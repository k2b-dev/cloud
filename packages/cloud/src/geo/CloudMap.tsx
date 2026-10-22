import { MapView, MapViewFrame, type MapViewProps, mapAttribution, useLocale } from "@k2b/ui";
import { For, Show, splitProps } from "solid-js";
import type { z } from "zod";
import type { GeoAvailabilityDataSchema } from "../contracts/geo";

export type CloudMapProps = Omit<MapViewProps, "style" | "attribution"> & {
  /** The authorized SSR snapshot keeps the first browser render identical. */
  availability?: z.infer<typeof GeoAvailabilityDataSchema>;
};

/** Cloud's same-origin, budgeted map. Domain lists and recovery actions belong to the host. */
export function CloudMap(props: CloudMapProps) {
  const [local, map] = splitProps(props, ["availability"]);
  const locale = useLocale();
  const language = () => (locale().startsWith("de") ? "de" : "en");
  const enabled = () =>
    !local.availability || (local.availability.configured && !local.availability.cloud.exhausted && !local.availability.person.exhausted);
  return (
    <Show when={enabled()} fallback={<MapViewFrame {...map} attribution={<CloudMapAttribution />} />}>
      <MapView
        {...map}
        style={{ light: `/api/geo/style?theme=light&locale=${language()}`, dark: `/api/geo/style?theme=dark&locale=${language()}` }}
        attribution={<CloudMapAttribution />}
      />
    </Show>
  );
}

export function CloudMapAttribution() {
  return (
    <For each={mapAttribution}>
      {(item, index) => (
        <>
          {index() > 0 && " · "}
          <a href={item.href} target="_blank" rel="noopener noreferrer">
            {item.label}
          </a>
        </>
      )}
    </For>
  );
}
