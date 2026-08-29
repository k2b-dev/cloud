import { navigateTo } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { AppOverview, Button, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { Venue, VenueTemplateSummary } from "../../contracts";
import { venueMessages } from "../../messages";

type Props = {
  venues: Venue[];
  templates: VenueTemplateSummary[];
  initialQuery: string;
};

const readError = async (res: Response, fallback: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const venueMatches = (venue: Venue, query: string): boolean => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${venue.name} ${venue.description ?? ""} ${venue.slug}`.toLowerCase().includes(normalized);
};

const updateQueryParam = (value: string) => {
  const url = new URL(window.location.href);
  const normalized = value.trim();
  if (normalized) url.searchParams.set("q", normalized);
  else url.searchParams.delete("q");
  window.history.replaceState({}, "", url.toString());
};

export default function VenueOverview(props: Props) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const signupLabel = (mode: Venue["signupMode"]): string =>
    mode === "templates" ? t().shiftSignup : mode === "both" ? t().shiftAndFreeSignup : t().freeSignup;
  const permissionLabel = (permission: Venue["permission"]): string =>
    permission === "admin" ? t().admin : permission === "write" ? t().staff : t().viewer;
  const [query, setQuery] = createSignal(props.initialQuery);
  const filteredVenues = createMemo(() => props.venues.filter((venue) => venueMatches(venue, query())));
  const onSearchInput = (value: string) => {
    setQuery(value);
    updateQueryParam(value);
  };
  const createVenue = mutation.create<string | null, void>({
    mutation: async () => {
      const result = await prompts.form({
        title: t().createVenue,
        icon: "ti ti-building-carousel",
        confirmText: t().create,
        fields: {
          name: { type: "text", label: t().name, required: true, placeholder: "StuVe Café" },
          slug: { type: "text", label: t().publicSlug, required: true, placeholder: "stuve-cafe" },
          description: { type: "text", label: t().description, multiline: true, lines: 3 },
        },
      });
      if (!result) return null;

      const data = result as { name: string; slug: string; description?: string };
      const res = await apiClient.venues.$post({
        json: {
          name: data.name,
          icon: "ti ti-building-carousel",
          slug: data.slug,
          description: data.description || null,
          timezone: "Europe/Berlin",
          openMode: "combined",
          signupMode: "both",
          publicEnabled: true,
          feedbackEnabled: true,
          accentColor: "#2563eb",
          logoBase64: null,
          bannerBase64: null,
        },
      });
      if (!res.ok) throw new Error(await readError(res, t().createVenueFailed));
      const venue = await res.json();
      return venue.id;
    },
    onSuccess: (id) => {
      if (!id) return;
      toast.success(t().venueCreated);
      navigateTo(`/app/venue/${id}`);
    },
    onError: (err) => prompts.error(err.message),
  });

  const createFromTemplate = mutation.create<string | null, { template: VenueTemplateSummary; name?: string; slug?: string }>({
    mutation: async (input) => {
      const res = await apiClient.templates[":templateId"].$post({
        param: { templateId: input.template.id },
        json: {
          name: input.name?.trim() || undefined,
          slug: input.slug?.trim() || undefined,
        },
      });
      if (!res.ok) throw new Error(await readError(res, t().createFromTemplateFailed));
      const venue = await res.json();
      return venue.id;
    },
    onSuccess: (id) => {
      if (!id) return;
      toast.success(t().venueCreated);
      navigateTo(`/app/venue/${id}`);
    },
    onError: (err) => prompts.error(err.message),
  });

  const openTemplate = async (template: VenueTemplateSummary) => {
    const defaultSlug = slugify(template.name);
    const result = await prompts.form({
      title: template.name,
      icon: template.icon,
      confirmText: t().create,
      fields: {
        name: { type: "text", label: t().name, placeholder: template.name },
        slug: { type: "text", label: t().publicSlug, placeholder: defaultSlug },
      },
    });
    if (!result) return;
    createFromTemplate.mutate({
      template,
      name: String(result.name ?? "").trim() || undefined,
      slug: String(result.slug ?? "").trim() || defaultSlug,
    });
  };

  return (
    <AppOverview title={t().appName} subtitle={t().overviewSubtitle} icon="ti ti-building-carousel">
      <AppOverview.Main
        title={t().yourVenues}
        description={props.venues.length === 0 ? t().createFirstVenue : t().venuesAvailable({ count: props.venues.length })}
        toolbar={
          <TextInput
            name="venue-search"
            type="search"
            aria-label={t().searchVenues}
            placeholder={t().searchVenuesPlaceholder}
            icon="ti ti-search"
            activeIcon="ti ti-search"
            value={query}
            onValueChange={onSearchInput}
            clearable
            onClear={() => onSearchInput("")}
          />
        }
      >
        {props.venues.length === 0 ? (
          <AppOverview.EmptyState
            title={t().noVenues}
            description={t().noVenuesDescription}
            icon="ti ti-building-carousel"
            class="min-h-72"
          />
        ) : (
          <Show
            when={filteredVenues().length > 0}
            fallback={
              <AppOverview.EmptyState title={t().noMatchingVenues} description={t().noMatchingVenuesDescription} icon="ti ti-search">
                <Button type="button" variant="secondary" size="sm" onClick={() => onSearchInput("")}>
                  <i class="ti ti-x" /> {t().clearSearch}
                </Button>
              </AppOverview.EmptyState>
            }
          >
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <For each={filteredVenues()}>
                {(venue) => (
                  <a
                    href={`/app/venue/${venue.id}`}
                    class="paper group flex items-center gap-4 p-4 no-underline transition-all hover:paper-highlighted"
                    style={`view-transition-name: venue-card-${venue.id}`}
                  >
                    <div
                      class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center"
                      style={`background-color: color-mix(in srgb, ${venue.accentColor} 12%, var(--ui-surface)); color: ${venue.accentColor}; view-transition-name: venue-color-${venue.id}`}
                    >
                      <i class={`${venue.icon || "ti ti-building-carousel"} text-lg`} />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span
                          class="block truncate text-sm font-semibold text-primary"
                          style={`view-transition-name: venue-name-${venue.id}`}
                        >
                          {venue.name}
                        </span>
                        <span class="tag shrink-0">{permissionLabel(venue.permission)}</span>
                      </div>
                      <p class="truncate text-xs text-dimmed">
                        {venue.description ||
                          `${signupLabel(venue.signupMode)} · ${venue.publicEnabled ? t().publicPageActive : t().publicPageHidden}`}
                      </p>
                    </div>
                    <i class="ti ti-chevron-right text-dimmed transition-transform group-hover:translate-x-0.5" />
                  </a>
                )}
              </For>
            </div>
          </Show>
        )}
      </AppOverview.Main>

      <AppOverview.Aside title={t().create} description={t().chooseStarter}>
        <div class="grid grid-cols-1 gap-2">
          <For each={props.templates}>
            {(template) => (
              <button
                type="button"
                class="paper p-4 text-left flex items-start gap-3 hover:paper-highlighted transition-all"
                onClick={() => openTemplate(template)}
                disabled={createFromTemplate.loading()}
              >
                <span class="w-9 h-9 thumbnail bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
                  <i class={`${template.icon} text-lg text-primary`} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-semibold text-primary">{template.name}</span>
                  <span class="block text-xs text-dimmed leading-snug line-clamp-2">{template.description}</span>
                </span>
              </button>
            )}
          </For>

          <button
            type="button"
            class="paper p-4 text-left flex items-start gap-3 hover:paper-highlighted transition-all"
            onClick={() => createVenue.mutate()}
            disabled={createVenue.loading()}
          >
            <span class="w-9 h-9 thumbnail bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center shrink-0">
              <i
                class={
                  createVenue.loading()
                    ? "ti ti-loader-2 animate-spin text-lg text-blue-600 dark:text-blue-400"
                    : "ti ti-plus text-lg text-blue-600 dark:text-blue-400"
                }
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-primary">{t().blankVenue}</span>
              <span class="block text-xs text-dimmed leading-snug">{t().blankVenueDescription}</span>
            </span>
          </button>
        </div>
      </AppOverview.Aside>
    </AppOverview>
  );
}
