import { navigateTo } from "@k2b/ssr/nav";
import {
  Bar,
  Button,
  Chip,
  Dialog,
  Empty,
  Field,
  Input,
  List,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  Row,
  StatusRow,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { apiClient } from "../../api/client";
import type { Venue, VenueTemplateSummary } from "../../contracts";
import { readError } from "../_components/venue-workspace/utils";
import { slugFromName, venueSlugError } from "../venue-slug";
import { useVenueWords } from "./messages";

export type VenueOverviewProps = { venues: Venue[]; templates: VenueTemplateSummary[]; initialQuery: string };

/** v1 icon classes ("ti ti-building") to v2 Tabler names ("building"). */
export const iconName = (classes: string | null | undefined, fallback = "building-carousel") =>
  (classes ?? "").replace(/^ti\s+/, "").replace(/^ti-/, "") || fallback;

const PAGE = 100;

const matches = (venue: Venue, query: string) => {
  const needle = query.trim().toLowerCase();
  return !needle || `${venue.name} ${venue.description ?? ""} ${venue.slug}`.toLowerCase().includes(needle);
};

/** The venues a person can open, each in its own symbol and colour; "New venue" starts blank or from a template. */
export default function VenueOverviewScreen(props: VenueOverviewProps) {
  const { t, words } = useVenueWords();
  const toast = useToast();
  const [query, setQuery] = createSignal(props.initialQuery);
  const [creating, setCreating] = createSignal<{ template?: VenueTemplateSummary } | null>(null);
  const shown = createMemo(() => props.venues.filter((venue) => matches(venue, query())));
  // k2b-ui gap: lists do not virtualize yet (lane MW); 100 rows show at a time, so the page stays bounded.
  const [visible, setVisible] = createSignal(PAGE);
  const search = (value: string) => {
    setQuery(value);
    setVisible(PAGE);
    if (isServer) return;
    const url = new URL(location.href);
    if (value.trim()) url.searchParams.set("q", value.trim());
    else url.searchParams.delete("q");
    history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  };
  const role = (permission: Venue["permission"]) => (permission === "admin" ? t().admin : permission === "write" ? t().staff : t().viewer);
  const signup = (mode: Venue["signupMode"]) =>
    mode === "templates" ? t().shiftSignup : mode === "both" ? t().shiftAndFreeSignup : t().freeSignup;
  const startEntries = (): MenuEntry[] => [
    { label: t().blankVenue, icon: "plus", meta: t().blankVenueDescription, onClick: () => setCreating({}) },
    ...(props.templates.length
      ? [
          {
            title: t().templates,
            items: props.templates.map((template) => ({
              label: template.name,
              icon: iconName(template.icon),
              onClick: () => setCreating({ template }),
            })),
          },
        ]
      : []),
  ];
  return (
    <Workspace
      head={
        <Bar
          start={<Text type="body">{t().appName}</Text>}
          end={
            <>
              <Show when={props.venues.length > 0}>
                <Input
                  type="search"
                  icon="search"
                  label={t().searchVenues}
                  placeholder={t().searchVenuesPlaceholder}
                  value={query()}
                  onInput={search}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query()) {
                      event.preventDefault();
                      search("");
                    }
                  }}
                />
              </Show>
              <Menu variant="primary" icon="plus" items={startEntries()}>
                {t().newVenue}
              </Menu>
            </>
          }
        />
      }
      primary={{ label: t().newVenue, icon: "plus", onClick: () => setCreating({}) }}
    >
      <Pane
        label={t().yourVenues}
        scrollKey="venue-overview"
        status={
          <StatusRow
            lead={
              query().trim()
                ? words().matchesCount({ count: shown().length, total: props.venues.length })
                : words().venuesCount({ count: props.venues.length })
            }
          />
        }
      >
        <Show
          when={props.venues.length > 0}
          fallback={
            <>
              <Empty
                icon="building-carousel"
                text={t().noVenuesDescription}
                action={{ label: t().startBlank, icon: "plus", onClick: () => setCreating({}) }}
              />
              <Show when={props.templates.length > 0}>
                <List label={t().templates}>
                  <For each={props.templates}>
                    {(template) => (
                      <Row
                        icon={iconName(template.icon)}
                        lines={[template.name, template.description]}
                        action={{ label: t().create, icon: "plus", onClick: () => setCreating({ template }) }}
                      />
                    )}
                  </For>
                </List>
              </Show>
            </>
          }
        >
          <Show
            when={shown().length > 0}
            fallback={<Empty icon="search" text={t().noMatchingVenues} action={{ label: t().clearSearch, onClick: () => search("") }} />}
          >
            {/* k2b-ui gap: v2 lists do not virtualize yet (lane MW); a person sees the venues they belong to. */}
            <List label={t().yourVenues}>
              <For each={shown().slice(0, visible())}>
                {(venue) => (
                  <Row
                    icon={iconName(venue.icon)}
                    color={venue.accentColor}
                    lines={[venue.name, venue.description || signup(venue.signupMode)]}
                    meta={role(venue.permission)}
                    end={venue.publicEnabled ? <Chip status="ok">{t().publicPageActive}</Chip> : <Chip>{t().publicPageHidden}</Chip>}
                    href={`/app/venue/${venue.id}`}
                  />
                )}
              </For>
            </List>
            <Show when={shown().length > visible()}>
              <Bar
                start={
                  <Text type="meta" muted>
                    {words().shownOf({ shown: visible(), total: shown().length })}
                  </Text>
                }
                end={
                  <Button icon="chevrons-down" onClick={() => setVisible(visible() + PAGE)}>
                    {words().showMore}
                  </Button>
                }
              />
            </Show>
          </Show>
        </Show>
      </Pane>
      <CreateVenueDialog
        request={creating()}
        close={(id) => {
          setCreating(null);
          if (!id) return;
          toast(t().venueCreated, { status: "ok" });
          navigateTo(`/app/venue/${id}`);
        }}
      />
    </Workspace>
  );
}

/** The browser's time zone for a new venue, so its times fit where it is set up; the server knows the default. */
const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

/**
 * A blank venue or one from a template. It asks only for the name; the address (slug) follows the name until someone
 * edits it. A slug the server refuses shows at its field, and every input stays.
 */
export function CreateVenueDialog(props: { request: { template?: VenueTemplateSummary } | null; close: (venueId: string | null) => void }) {
  return (
    <Show when={props.request} keyed>
      {(request) => <CreateVenueForm template={request.template} close={props.close} />}
    </Show>
  );
}

function CreateVenueForm(props: { template?: VenueTemplateSummary; close: (venueId: string | null) => void }) {
  const { t, words } = useVenueWords();
  const [name, setName] = createSignal("");
  const [ownSlug, setOwnSlug] = createSignal<string | null>(null);
  const [tried, setTried] = createSignal(false);
  const [problem, setProblem] = createSignal<{ slug: string; message: string } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const slug = () => ownSlug() ?? slugFromName(name().trim() || props.template?.name || "");
  const nameError = () => (tried() && !props.template && !name().trim() ? t().nameRequired : undefined);
  const slugError = () => {
    if (!tried() && ownSlug() === null) return undefined;
    const known = problem();
    return venueSlugError(slug(), t()) ?? (known?.slug === slug() ? known.message : undefined);
  };
  const submit = async () => {
    setTried(true);
    if (nameError() || slugError() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const response = props.template
        ? await apiClient.templates[":templateId"].$post({
            param: { templateId: props.template.id },
            json: { name: name().trim() || undefined, slug: slug() },
          })
        : await apiClient.venues.$post({ json: { name: name().trim(), slug: slug(), timezone: browserTimeZone() } });
      if (response.ok) {
        setBusy(false);
        props.close((await response.json()).id);
        return;
      }
      const message = await readError(response, props.template ? t().createFromTemplateFailed : t().createVenueFailed);
      // The server names the field: a taken slug answers 409, a malformed one 400 with `slug: …`.
      if (response.status === 409) setProblem({ slug: slug(), message: t().slugTaken });
      else if (message.startsWith("slug:")) setProblem({ slug: slug(), message: t().slugInvalid });
      else setError(message);
    } catch {
      setError(props.template ? t().createFromTemplateFailed : t().createVenueFailed);
    }
    setBusy(false);
  };
  return (
    <Dialog
      title={props.template?.name ?? t().createVenue}
      open
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(null);
      }}
      foot={
        <>
          <Button disabled={busy()} onClick={() => props.close(null)}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void submit()}>
            {t().create}
          </Button>
        </>
      }
    >
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
      <Show when={props.template?.description}>{(description) => <Text>{description()}</Text>}</Show>
      <Field
        name="name"
        label={t().name}
        hint={props.template ? t().templateNameDescription : undefined}
        required={!props.template}
        optional={props.template ? words().optional : undefined}
        error={nameError()}
      >
        <Input value={name()} placeholder={props.template?.name ?? t().venueNamePlaceholder} onInput={setName} />
      </Field>
      <Field name="slug" label={t().slug} hint={t().slugDescription} error={slugError()}>
        <Input value={slug()} onInput={(value) => setOwnSlug(value.trim().toLowerCase())} />
      </Field>
    </Dialog>
  );
}
