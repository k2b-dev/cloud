import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, openSpotlightSearch, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { weatherMessages } from "../messages";

type GeoResult = {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  state?: string;
};

const locationDescription = (location: GeoResult, locale: string) => {
  const coordinate = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  return (
    [location.state, location.country].filter(Boolean).join(", ") ||
    `${coordinate.format(location.lat)}, ${coordinate.format(location.lon)}`
  );
};

const searchLocations = async ({ query, abortSignal, locale }: { query: string; abortSignal: AbortSignal; locale: string }) => {
  const { t } = weatherMessages.resolve([locale]);
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const res = await apiClient.geo.search.$get({ query: { q: trimmed, country: "DE" } }, { init: { signal: abortSignal } });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    throw new Error(data.message ?? t.citySearchFailed);
  }

  const locations = (await res.json()) as GeoResult[];
  return locations.map((location) => ({
    label: location.name,
    desc: locationDescription(location, locale),
    icon: "ti ti-map-pin",
    value: location,
  }));
};

const AddLocationButton = (props: { variant?: "button" | "sidebar" | "overview" }) => {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const [selecting, setSelecting] = createSignal(false);
  let disposed = false;
  const addMutation = mutations.create<{ id: string }, GeoResult>({
    mutation: async (location, { abortSignal }) => {
      const res = await apiClient.locations.$post(
        {
          json: {
            name: location.name,
            state: location.state,
            lat: location.lat,
            lon: location.lon,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) {
        const data = (await res.json()) as { message?: string };
        throw new Error(data.message ?? t().addLocationFailed);
      }
      return (await res.json()) as { id: string };
    },
    onSuccess: (result) => {
      toast.success(t().locationAdded);
      navigateTo(`/app/weather/${result.id}`);
    },
    onError: (err) => {
      prompts.error(err.message);
    },
  });

  onCleanup(() => {
    disposed = true;
    addMutation.abort();
  });

  const selectLocation = async () => {
    if (selecting() || addMutation.loading()) return;
    setSelecting(true);
    try {
      const selected = await openSpotlightSearch<GeoResult>({
        resolve: ({ query, abortSignal }) => searchLocations({ query, abortSignal, locale: locale() }),
        title: t().addLocation,
        icon: "ti ti-map-pin",
        placeholder: t().citySearchPlaceholder,
        minQueryLength: 2,
        emptyText: t().citySearchMinimum,
        noResultsText: t().citySearchEmpty,
        size: "small",
      });
      if (!disposed && selected?.value) await addMutation.mutate({ ...selected.value });
    } finally {
      if (!disposed) setSelecting(false);
    }
  };
  const loading = () => selecting() || addMutation.loading();

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
