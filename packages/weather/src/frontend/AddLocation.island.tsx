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
      <button
        type="button"
        onClick={() => void selectLocation()}
        disabled={loading()}
        class="paper flex w-full items-start gap-3 p-4 text-left transition-all hover:paper-highlighted"
      >
        <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--app-accent)_10%,var(--ui-surface))] text-[var(--ui-app-accent-text)]">
          <i class={loading() ? "ti ti-loader-2 animate-spin" : "ti ti-map-pin-plus"} aria-hidden="true" />
        </span>
        <span class="min-w-0">
          <span class="block text-sm font-medium text-primary">{t().addLocation}</span>
          <span class="mt-0.5 block text-xs text-dimmed">{t().addLocationDescription}</span>
        </span>
      </button>
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
