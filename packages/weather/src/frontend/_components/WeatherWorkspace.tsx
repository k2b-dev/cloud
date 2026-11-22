import type { WeatherData } from "@k2b/cloud/services";
import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import { weatherMessages } from "../../messages";
import AddLocationButton from "../AddLocation.island";
import LocationActions from "../LocationActions.island";
import LocationSidebar, { type SidebarLocation } from "./LocationSidebar";
import WeatherDetail, { type WeatherLocation } from "./WeatherDetail";

type Props = {
  locations: (SidebarLocation & WeatherLocation)[];
  activeId: string;
  weatherMap: Map<string, WeatherData | null>;
  /** The open place's forecast; `null` when the weather service has none for it. */
  data: WeatherData | null;
};

/**
 * The weather workspace of one saved place: the places in the sidebar, the place's options in the head, and its
 * forecast as flat topics. An unknown place and a missing forecast take the forecast's place as a calm empty state.
 */
export default function WeatherWorkspace(props: Props) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const active = () => props.locations.find((location) => location.id === props.activeId);
  return (
    <AppWorkspace mobileSurface="flush">
      {active() && <AppWorkspace.Head actions={<LocationActions id={active()!.id} lat={active()!.lat} lon={active()!.lon} />} />}
      <LocationSidebar locations={props.locations} activeId={props.activeId} weatherMap={props.weatherMap} />
      <AppWorkspace.Content>
        <AppWorkspace.Main scrollPreserveKey={active() ? `weather-main-${props.activeId}` : undefined}>
          {(() => {
            const location = active();
            if (!location)
              return (
                <Placeholder
                  state="error"
                  variant="panel"
                  title={t().locationNotFound}
                  description={t().locationNotFoundDescription}
                  icon="ti ti-map-pin-off"
                  class="h-full"
                  action={<AddLocationButton variant="overview" />}
                />
              );
            if (!props.data)
              return (
                // K10: a missing forecast concerns the whole page and needs nobody, so it is calm, not red.
                <Placeholder
                  variant="panel"
                  title={t().weatherUnavailable}
                  description={t().weatherUnavailableGermany}
                  icon="ti ti-cloud-off"
                  class="h-full"
                />
              );
            return <WeatherDetail location={location} data={props.data} />;
          })()}
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
