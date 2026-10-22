import type { GeoProvenance } from "@k2b/cloud/contracts";
import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Combobox, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { weatherMessages } from "../messages";

type GeoResult = {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  state?: string;
  provenance: GeoProvenance;
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
  if (trimmed.length < 3) return [];

  const res = await apiClient.geo.search.$get({ query: { q: trimmed, country: "DE" } }, { init: { signal: abortSignal } });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    throw new Error(data.message ?? t.citySearchFailed);
  }

  const locations = (await res.json()) as GeoResult[];
  return locations;
};

export function createLocationPicker() {
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
            provenance: location.provenance,
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
      const selected = await prompts.dialog<GeoResult>(
        (close) => {
          let suggestions: GeoResult[] = [];
          let currentQuery = "";
          let suggestionsQuery = "";
          return (
            <div class="flex flex-col gap-3 p-4">
              <Combobox
                label={t().locationSearch}
                placeholder={t().citySearchPlaceholder}
                description={t().citySearchMinimum}
                debounceMs={250}
                onQueryChange={(query) => {
                  currentQuery = query.trim();
                }}
                fetchData={async (query, abortSignal) => {
                  const found = await searchLocations({ query, abortSignal, locale: locale() });
                  abortSignal.throwIfAborted();
                  suggestions = found;
                  suggestionsQuery = query.trim();
                  return found.map((location) => ({
                    id: JSON.stringify([location.name, location.lat, location.lon]),
                    label: location.name,
                    description: locationDescription(location, locale()),
                    icon: "ti ti-map-pin",
                  }));
                }}
                onSelect={(option) => {
                  if (currentQuery.length < 3 || currentQuery !== suggestionsQuery) return;
                  const location = suggestions.find((item) => JSON.stringify([item.name, item.lat, item.lon]) === option.id);
                  if (location) close(location);
                }}
              />
              <p class="text-xs text-dimmed">
                <a href="https://www.geoapify.com/" class="underline" target="_blank" rel="noopener noreferrer">
                  Geoapify
                </a>
                {" · "}
                <a href="https://www.openstreetmap.org/copyright" class="underline" target="_blank" rel="noopener noreferrer">
                  OpenStreetMap
                </a>
              </p>
            </div>
          );
        },
        { title: t().addLocation, icon: "ti ti-map-pin", size: "small" },
      );
      if (!disposed && selected) await addMutation.mutate(selected);
    } finally {
      if (!disposed) setSelecting(false);
    }
  };
  const loading = () => selecting() || addMutation.loading();

  return { selectLocation, loading };
}
