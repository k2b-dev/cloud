import { type WeatherData, weatherService } from "@k2b/cloud/services";
import { AppWorkspace, useLocale } from "@k2b/ui";
import { weatherMessages } from "../../messages";
import AddLocationButton from "../AddLocation.island";
import WeatherNavigation from "../WeatherNavigation.island";

export type SidebarLocation = {
  id: string;
  name: string;
  state: string | null;
  lat: number;
  lon: number;
};

type Props = {
  locations: SidebarLocation[];
  activeId: string | null;
  weatherMap: Map<string, WeatherData | null>;
};

export default function LocationSidebar(props: Props) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const temperature = (value: number) => `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value)}°`;
  const activeLocation = props.locations.find((location) => location.id === props.activeId);

  const renderLocation = (loc: SidebarLocation, mode: "desktop" | "mobile") => {
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
          <span class="flex min-w-0 flex-col leading-tight">
            <span class="truncate">{loc.name}</span>
            <span class="mt-0.5 truncate text-[0.6875rem] font-normal text-dimmed">
              {data?.current ? <span class={tempClass}>{temperature(data.current.temperature)}</span> : t().noForecast}
              {mode === "desktop" && loc.state ? <span class="ml-1">· {loc.state}</span> : null}
            </span>
          </span>
        </AppWorkspace.SidebarItemLabel>
      </AppWorkspace.SidebarItem>
    );
  };

  return (
    <>
      <WeatherNavigation
        label={activeLocation?.name ?? t().appName}
        items={props.locations.map((loc) => {
          const data = props.weatherMap.get(loc.id);
          return {
            id: loc.id,
            label: loc.name,
            href: `/app/weather/${loc.id}`,
            active: loc.id === props.activeId,
            icon: `ti ti-${data?.current ? weatherService.ui.getTablerIcon(data.current.icon) : "map-pin"}`,
            description: data?.current ? temperature(data.current.temperature) : t().noForecast,
          };
        })}
      />
      <AppWorkspace.Sidebar>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="weather-locations">
            {/* The main action waits as the quiet first row of the sidebar (Cloud flach, decision 21.11.). */}
            <AddLocationButton variant="sidebar" />
            <AppWorkspace.SidebarSection title={t().locations}>
              {props.locations.map((loc) => renderLocation(loc, "desktop"))}
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
