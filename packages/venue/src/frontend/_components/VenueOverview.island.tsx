import { navigateTo } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { AppOverview, Button, Dropdown, type DropdownItem, LinkCard, prompts, Tag, TextInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { Venue, VenueTemplateSummary } from "../../contracts";
import { venueMessages } from "../../messages";

type Props = {
  venues: Venue[];
  templates: VenueTemplateSummary[];
  initialQuery: string;
};

const readError = async (res: Pick<Response, "json">, fallback: string): Promise<string> => {
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

  const createMenuItems = (): DropdownItem[] => [
    { items: [{ label: t().blankVenue, description: t().blankVenueDescription, icon: "ti ti-plus", action: () => createVenue.mutate() }] },
    {
      sectionLabel: t().templates,
      items: props.templates.map((template) => ({
        label: template.name,
        description: template.description,
        icon: template.icon,
        action: () => void openTemplate(template),
      })),
    },
  ];

  return (
    <AppOverview
      title={t().appName}
      icon="ti ti-building-carousel"
      subtitle={props.venues.length === 0 ? t().createFirstVenue : t().venuesAvailable({ count: props.venues.length })}
      actions={
        <Dropdown.Root items={createMenuItems()} position="bottom-right" width="min(26rem, calc(100vw - 1rem))" label={t().newVenue}>
          <Dropdown.Trigger variant="primary" disabled={createVenue.loading() || createFromTemplate.loading()}>
            <i class="ti ti-plus" aria-hidden="true" /> {t().newVenue}
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      }
    >
      <AppOverview.Main
        title={t().yourVenues}
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
            <AppOverview.Cards>
              <For each={filteredVenues()}>
                {(venue) => (
                  <LinkCard
                    href={`/app/venue/${venue.id}`}
                    title={venue.name}
                    description={
                      venue.description ||
                      `${signupLabel(venue.signupMode)} · ${venue.publicEnabled ? t().publicPageActive : t().publicPageHidden}`
                    }
                    icon={venue.icon || "ti ti-building-carousel"}
                    meta={<Tag size="sm">{permissionLabel(venue.permission)}</Tag>}
                  />
                )}
              </For>
            </AppOverview.Cards>
          </Show>
        )}
      </AppOverview.Main>
    </AppOverview>
  );
}
