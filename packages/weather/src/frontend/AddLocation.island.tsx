import { AppWorkspace, Button, useLocale } from "@k2b/ui";
import { weatherMessages } from "../messages";
import { createLocationPicker } from "./location-picker";

const AddLocationButton = (props: { variant?: "button" | "sidebar" | "overview" }) => {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const { selectLocation, loading } = createLocationPicker();
  if (props.variant === "sidebar") {
    return (
      <AppWorkspace.SidebarItem
        icon={loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"}
        disabled={loading()}
        onClick={() => void selectLocation()}
      >
        {t().addLocation}
      </AppWorkspace.SidebarItem>
    );
  }

  if (props.variant === "overview") {
    return (
      <Button onClick={() => void selectLocation()} loading={loading()} loadingLabel={t().addingLocation}>
        <i class="ti ti-map-pin-plus" aria-hidden="true" />
        {t().addLocation}
      </Button>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      class="w-full"
      onClick={() => void selectLocation()}
      loading={loading()}
      loadingLabel={t().addingLocation}
    >
      <i class="ti ti-plus" aria-hidden="true" />
      {t().addLocation}
    </Button>
  );
};

export default AddLocationButton;
