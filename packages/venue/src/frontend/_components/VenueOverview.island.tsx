import { navigateTo } from "@k2b/ssr/nav";
import {
  AppOverview,
  Button,
  Dropdown,
  type DropdownItem,
  dialogCore,
  LinkCard,
  panelDialogOptions,
  Tag,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Venue, VenueTemplateSummary } from "../../contracts";
import { venueMessages } from "../../messages";
import { CreateVenueDialog } from "./create-venue-dialog";

type Props = {
  venues: Venue[];
  templates: VenueTemplateSummary[];
  initialQuery: string;
};

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
  const [creating, setCreating] = createSignal(false);
  /** Opens the create dialog, blank or for a template; it creates the venue itself and keeps its input on errors. */
  const openCreate = async (template?: VenueTemplateSummary) => {
    if (creating()) return;
    setCreating(true);
    try {
      const venueId = await dialogCore.open<string | null>(
        (close, context) => <CreateVenueDialog template={template} close={close} guardDismiss={context.setDismissHandler} />,
        panelDialogOptions,
      );
      if (!venueId) return;
      toast.success(t().venueCreated);
      navigateTo(`/app/venue/${venueId}`);
    } finally {
      setCreating(false);
    }
  };

  const createMenuItems = (): DropdownItem[] => [
    { items: [{ label: t().blankVenue, description: t().blankVenueDescription, icon: "ti ti-plus", action: () => void openCreate() }] },
    {
      sectionLabel: t().templates,
      items: props.templates.map((template) => ({
        label: template.name,
        description: template.description,
        icon: template.icon,
        action: () => void openCreate(template),
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
          <Dropdown.Trigger variant="primary" disabled={creating()}>
            <i class="ti ti-plus" aria-hidden="true" /> {t().newVenue}
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      }
    >
      <AppOverview.Main
        title={t().yourVenues}
        // Without any venue there is nothing to search yet.
        toolbar={
          props.venues.length === 0 ? undefined : (
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
          )
        }
      >
        {props.venues.length === 0 ? (
          <AppOverview.EmptyState
            title={t().noVenues}
            description={t().noVenuesDescription}
            icon="ti ti-building-carousel"
            class="min-h-72"
          >
            {/* The first venue starts from a template or blank, right here. */}
            <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center" data-venue-empty-actions="">
              <For each={props.templates}>
                {(template) => (
                  <Button type="button" variant="secondary" disabled={creating()} onClick={() => void openCreate(template)}>
                    <i class={template.icon} aria-hidden="true" /> {template.name}
                  </Button>
                )}
              </For>
              <Button type="button" variant="secondary" disabled={creating()} onClick={() => void openCreate()}>
                <i class="ti ti-plus" aria-hidden="true" /> {t().startBlank}
              </Button>
            </div>
          </AppOverview.EmptyState>
        ) : (
          <Show
            when={filteredVenues().length > 0}
            fallback={
              <AppOverview.EmptyState title={t().noMatchingVenues} description={t().noMatchingVenuesDescription} icon="ti ti-search">
                <Button type="button" variant="secondary" size="sm" onClick={() => onSearchInput("")}>
                  <i class="ti ti-x" aria-hidden="true" /> {t().clearSearch}
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
