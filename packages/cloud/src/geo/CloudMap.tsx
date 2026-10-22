import { MapView, MapViewFrame, type MapViewProps, mapAttribution, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, Show, splitProps } from "solid-js";
import type { z } from "zod";
import { invokeCapabilityWithDataSchema } from "../capabilities/client";
import { type GeoAvailabilityDataSchema, geoContract } from "../contracts/geo";
import { mapMessages } from "./map-messages";

export type CloudMapProps = Omit<MapViewProps, "style" | "attribution"> & {
  /** The authorized SSR snapshot keeps the first browser render identical. */
  availability?: z.infer<typeof GeoAvailabilityDataSchema>;
};

/** Cloud's same-origin, budgeted map. Domain lists and recovery actions belong to the host. */
export function CloudMap(props: CloudMapProps) {
  const [local, map] = splitProps(props, ["availability", "onStateChange", "notice"]);
  const locale = useLocale();
  const [recovery, setRecovery] = createSignal("");
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  let generation = 0;
  const onStateChange: NonNullable<MapViewProps["onStateChange"]> = (state) => {
    local.onStateChange?.(state);
    const current = ++generation;
    if (state !== "error") {
      setRecovery("");
      return;
    }
    void invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.availability.id, input: {}, signal: controller.signal },
      geoContract.availability.data,
    )
      .then((result) => {
        if (!result.ok || controller.signal.aborted || current !== generation) return;
        const availability = result.data.data;
        const t = mapMessages.resolve([locale()]).t;
        if (!availability.configured) setRecovery(t.notConfigured);
        else if (availability.cloud.exhausted || availability.person.exhausted) {
          const exhausted = availability.cloud.exhausted ? availability.cloud : availability.person;
          const reset = new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(exhausted.resetsAt));
          setRecovery(availability.cloud.exhausted ? t.cloudBudget({ reset }) : t.personBudget({ reset }));
        }
      })
      .catch(() => {
        /* MapView already displays its retry state. */
      });
  };
  const language = () => encodeURIComponent(new Intl.Locale(locale()).language);
  const enabled = () =>
    !local.availability || (local.availability.configured && !local.availability.cloud.exhausted && !local.availability.person.exhausted);
  return (
    <Show
      when={enabled()}
      fallback={
        <div class="relative" style={{ height: `${map.height}px` }}>
          <MapViewFrame {...map} attribution={<CloudMapAttribution />} />
          <Show when={local.notice}>
            <div class="k2b-map-view__messages">
              <div class="k2b-map-view__notice">{local.notice}</div>
            </div>
          </Show>
        </div>
      }
    >
      <MapView
        {...map}
        onStateChange={onStateChange}
        notice={
          <>
            {local.notice}
            <Show when={recovery()}>
              <span role="status">{recovery()}</span>
            </Show>
          </>
        }
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
