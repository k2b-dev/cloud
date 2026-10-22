import { For, type JSX } from "solid-js";
import { mapAttribution } from "./map-style";

/**
 * The required credits for maps built with `mapStyle()`, each one a link, for MapView's `attribution` slot.
 * @example <MapView style={style} attribution={<MapAttribution />} height={320} />
 */
export function MapAttribution(): JSX.Element {
  return (
    <For each={mapAttribution}>
      {(part, index) => (
        <>
          {index() > 0 ? " · " : ""}
          <a href={part.href} target="_blank" rel="noopener noreferrer">
            {part.label}
          </a>
        </>
      )}
    </For>
  );
}
