import { AppWorkspace, useLocale } from "@k2b/ui";
import { type WeatherData, weatherService } from "@k2b/cloud/services";
import { weatherMessages } from "../../messages";
import AddLocationButton from "../AddLocation.island";

type Location = {
  id: string;
  name: string;
  state: string | null;
  lat: number;
  lon: number;
};

type Props = {
  locations: Location[];
  activeId: string | null;
  weatherMap: Map<string, WeatherData | null>;
};

export default function LocationSidebar(props: Props) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const temperature = (value: number) => `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value)}°`;
  const activeLocation = props.locations.find((location) => location.id === props.activeId);

  const renderLocation = (loc: Location, mode: "desktop" | "mobile") => {
    const data = props.weatherMap.get(loc.id);
    const isActive = loc.id === props.activeId;
    const tempClass = data?.current ? weatherService.ui.getTempColorClass(data.current.temperature) : "";

    return (
      <AppWorkspace.SidebarItem href={`/app/weather/${loc.id}`} navigation="document" active={isActive} title={loc.name}>
        <AppWorkspace.SidebarItemIcon>
          <i
            class={`ti ti-${data?.current ? weatherService.ui.getTablerIcon(data.current.icon) : "map-pin"} shrink-0 text-sm ${
              tempClass || "text-dimmed"
            }`}
          />
        </AppWorkspace.SidebarItemIcon>
        <AppWorkspace.SidebarItemLabel>
          <span class="flex flex-col leading-tight">
            <span>{loc.name}</span>
            <span class="mt-0.5 text-[0.6875rem] font-normal text-dimmed">
              {data?.current ? <span class={tempClass}>{temperature(data.current.temperature)}</span> : t().noForecast}
              {mode === "desktop" && loc.state ? <span class="ml-1">· {loc.state}</span> : null}
            </span>
          </span>
        </AppWorkspace.SidebarItemLabel>
      </AppWorkspace.SidebarItem>
    );
  };

  return (
    <AppWorkspace.Sidebar>
      <AppWorkspace.SidebarMobileTrigger label={activeLocation?.name ?? t().appName} />

      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems>
          <AddLocationButton variant="sidebar" />
        </AppWorkspace.SidebarMobileItems>
        <AppWorkspace.SidebarMobileBody scrollPreserveKey="weather-locations-mobile">
          <AppWorkspace.SidebarSection>{props.locations.map((loc) => renderLocation(loc, "mobile"))}</AppWorkspace.SidebarSection>
        </AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>

      <AppWorkspace.SidebarDesktop>
        <div class="flex min-h-0 flex-1 flex-col gap-3">
          <AddLocationButton />
          <AppWorkspace.SidebarBody scrollPreserveKey="weather-locations">
            <AppWorkspace.SidebarSection title={t().locations}>
              {props.locations.map((loc) => renderLocation(loc, "desktop"))}
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
        </div>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
