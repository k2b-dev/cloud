import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createNavigation, type NavigationItem, useLocale } from "@k2b/ui";
import { weatherMessages } from "../messages";
import { createLocationPicker } from "./location-picker";

export default function WeatherNavigation(props: { items: readonly NavigationItem[]; label: string }) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const picker = createLocationPicker();
  const navigation = createNavigation({
    items: () => [{ id: "add", label: t().addLocation, icon: "ti ti-plus", action: "add", disabled: picker.loading() }, ...props.items],
    onAction: (action) => {
      if (action === "add") return picker.selectLocation();
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.label} />;
}
