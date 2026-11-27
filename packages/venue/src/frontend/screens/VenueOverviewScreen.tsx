import V2WorkspaceNavigation from "@k2b/cloud/ssr/V2WorkspaceNavigation";
import { navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import {
  Avatar,
  Bar,
  Button,
  Dialog,
  Empty,
  Field,
  Icon,
  Input,
  Nav,
  type NavGroup,
  Notice,
  Pane,
  Row,
  Section,
  Select,
  StatusRow,
  Text,
  useLocale,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { UpcomingShift, UpcomingShifts, VenueOpenState, VenueSign, VenueTemplateSummary } from "../../contracts";
import { formatDateKey, formatVenueTime, formatVenueTimeRange } from "../../time-format";
import { readError } from "../_components/venue-workspace/utils";
import { assignmentSelectionId, scheduleHref } from "../schedule-url";
import { slugFromName, venueSlugError } from "../venue-slug";
import { useVenueWords } from "./messages";

/** The venues the sidebar lists by name; the list below holds the page of them. */
const NAV_VENUES = 50;
/** How far ahead "Deine nächsten Schichten" looks; the server reads the same window. */
const SHIFT_DAYS = 14;

/** A venue in the overview's list: its sign and how it stands now. */
export type OverviewVenue = VenueSign & { state: VenueOpenState };

export type VenueOverviewProps = {
  /** The page's clock: the server's now, so the first picture and the island tell the same day. */
  now: string;
  venues: OverviewVenue[];
  /** Another page of venues follows this one. */
  morePages: boolean;
  page: number;
  shifts: UpcomingShifts;
  templates: VenueTemplateSummary[];
  initialQuery: string;
};

/** v1 icon classes ("ti ti-building") to v2 Tabler names ("building"). */
export const iconName = (classes: string | null | undefined, fallback = "building-carousel") =>
  (classes ?? "").replace(/^ti\s+/, "").replace(/^ti-/, "") || fallback;

const sign = (venue: VenueSign) => ({ icon: iconName(venue.icon), color: venue.accentColor });
const dayOf = (iso: string, timeZone: string) => dates.formatDateKey(new Date(iso), { timeZone });
/** Whole days from one date key to another. */
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/** "Sa." / "Sat": the short weekday as it stands before a date (alone, German drops its dot). */
const weekdayShort = (dateKey: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" })
    .formatToParts(new Date(`${dateKey}T12:00:00Z`))
    .find((part) => part.type === "weekday")?.value ?? "";

type Day = { key: string; offset: number; shifts: UpcomingShift[] };

/**
 * Where a person lands in Venue: what they do next across all their venues, by day, then their venues with how each
 * stands now. "Neuer Standort" heads the venues; the search looks through all of them on the server.
 */
export default function VenueOverviewScreen(props: VenueOverviewProps) {
  const { t, words } = useVenueWords();
  const toast = useToast();
  const locale = useLocale();
  const [query, setQuery] = createSignal(props.initialQuery);
  const [creating, setCreating] = createSignal(false);
  // the shifts by the day they start, each in its venue's time zone, counted from that zone's today
  const days = createMemo(() => {
    const byDay = new Map<string, Day>();
    for (const shift of props.shifts.entries) {
      const key = dayOf(shift.startsAt, shift.venue.timezone);
      const day = byDay.get(key) ?? { key, offset: daysBetween(dayOf(props.now, shift.venue.timezone), key), shifts: [] };
      day.shifts.push(shift);
      byDay.set(key, day);
    }
    return [...byDay.values()];
  });
  const dayTitle = (day: Day) =>
    day.offset === 0 ? words().today : day.offset === 1 ? words().tomorrow : formatDateKey(day.key, locale(), { weekday: "long" });
  const dayNote = (day: Day) =>
    formatDateKey(day.key, locale(), day.offset <= 1 ? { weekday: "short", day: "numeric", month: "short" } : undefined);
  const stateWords = (venue: OverviewVenue) => {
    const state = venue.state;
    if (state.kind === "open") return words().openUntil({ time: formatVenueTime(state.until, venue.timezone, locale()) });
    if (state.kind === "staffed") return words().opensWhenStaffed;
    if (state.kind === "closed") return words().closedToday;
    const time = formatVenueTime(state.at, venue.timezone, locale());
    const day = dayOf(state.at, venue.timezone);
    const offset = daysBetween(dayOf(props.now, venue.timezone), day);
    if (offset === 0) return words().opensToday({ time });
    if (offset === 1) return words().opensTomorrow({ time });
    return words().opensOn({ day: weekdayShort(day, locale()), time });
  };
  const faces = (shift: UpcomingShift) => {
    const { names, count } = shift.coworkers;
    // k2b-ui gap: Avatar.Stack counts "+n" from its people; the server sends four names and the count, so the rest
    // stand in as nameless entries that never show as faces (the stack shows three).
    const people = [...names.map((name) => ({ name })), ...Array.from({ length: Math.max(0, count - names.length) }, () => ({ name: "" }))];
    const label =
      count > names.length
        ? words().withPeopleAndMore({ names: names.join(", "), more: count - names.length })
        : words().withPeople({ names: names.join(", ") });
    return <Avatar.Stack people={people} max={3} label={label} />;
  };
  const search = (value: string) => {
    const url = new URL("/app/venue", location.origin);
    if (value.trim()) url.searchParams.set("q", value.trim());
    navigateTo(`${url.pathname}${url.search}`);
  };
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (props.initialQuery) params.set("q", props.initialQuery);
    params.set("page", String(page));
    return `/app/venue?${params}`;
  };
  // nothing to show yet: no venue anywhere, no shift, no search
  const firstTime = () => props.venues.length === 0 && props.shifts.total === 0 && !props.initialQuery && props.page === 1;
  // the venues stay places in the sidebar, with the overview as the current one
  const groups = (): NavGroup[] => [
    { items: [{ label: words().overview, icon: "calendar", href: "/app/venue", current: true }] },
    ...(props.venues.length
      ? [
          {
            label: t().yourVenues,
            items: props.venues.slice(0, NAV_VENUES).map((venue) => ({
              label: venue.name,
              icon: iconName(venue.icon),
              color: venue.accentColor,
              href: `/app/venue/${venue.id}`,
            })),
          },
        ]
      : []),
  ];
  const createAction = () => ({ label: t().newVenue, icon: "plus", onClick: () => setCreating(true) });
  return (
    <>
      <V2WorkspaceNavigation label={t().appName} groups={groups()} />
      <Workspace
        sidebar={<Nav title={t().appName} icon="building-carousel" groups={groups()} />}
        sidebarLabel={t().yourVenues}
        head={
          <Show when={!firstTime()}>
            <Bar
              start={<Text type="lead">{words().nextShifts}</Text>}
              end={
                <Input
                  type="search"
                  icon="search"
                  label={t().searchVenues}
                  placeholder={t().searchVenuesPlaceholder}
                  value={query()}
                  onInput={setQuery}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.isComposing) {
                      event.preventDefault();
                      search(query());
                    } else if (event.key === "Escape" && (query() || props.initialQuery)) {
                      event.preventDefault();
                      setQuery("");
                      if (props.initialQuery) search("");
                    }
                  }}
                />
              }
            />
          </Show>
        }
      >
        <Pane
          label={words().nextShifts}
          scrollKey="venue-overview"
          // the one sentence under the title, as in the mockup: how much there is, and where
          status={
            props.shifts.total > 0 ? (
              // the count of venues gives way on the phone, the statement stays
              <StatusRow
                lead={words().nextShiftsLead({ count: props.shifts.total, days: SHIFT_DAYS })}
                facts={[{ before: words().at, value: props.shifts.venues, after: words().venuesAt({ count: props.shifts.venues }) }]}
              />
            ) : undefined
          }
        >
          <Show
            when={!firstTime()}
            fallback={
              // k2b-ui gap: start tiles (W2)
              <Empty icon="building-carousel" text={t().noVenues} action={createAction()} />
            }
          >
            <Show
              when={days().length > 0}
              fallback={
                <Empty
                  icon="calendar-off"
                  text={words().noShiftsSoon({ days: SHIFT_DAYS })}
                  action={
                    props.venues[0] ? { label: words().toSchedule, icon: "calendar", href: scheduleHref(props.venues[0].id) } : undefined
                  }
                />
              }
            >
              <For each={days()}>
                {(day, index) => (
                  // the day's date stands quiet after its name, as the count of a section would
                  <Section
                    title={dayTitle(day)}
                    count={dayNote(day)}
                    more={
                      index() === days().length - 1 && props.shifts.next
                        ? {
                            label: words().moreShiftsAt({ venue: props.shifts.next.venueName }),
                            href: `/app/venue/${props.shifts.next.venueId}/my-shifts`,
                            forward: true,
                          }
                        : undefined
                    }
                  >
                    <For each={day.shifts}>
                      {(shift) => (
                        // two lines everywhere (identity B: the phone always has two): the shift, then its time and
                        // venue. k2b-ui gap: a row has no leading time column (the mockup sets the time before the
                        // sign on one line), and a one-line row lays `time` and `end` over each other.
                        <Row
                          mark={sign(shift.venue)}
                          lines={[
                            shift.title ?? t().freeTime,
                            `${formatVenueTimeRange(shift.startsAt, shift.endsAt, shift.venue.timezone, locale())} · ${shift.venue.name}`,
                          ]}
                          end={shift.coworkers.count > 0 ? faces(shift) : undefined}
                          href={scheduleHref(shift.venue.id, { date: day.key, shift: assignmentSelectionId(shift.id) })}
                        />
                      )}
                    </For>
                  </Section>
                )}
              </For>
            </Show>
            {/* k2b-ui gap: a list has no two-column flow; the mockup sets the venues in two columns from the tablet on */}
            <Section
              title={words().venues}
              actions={[createAction()]}
              more={props.morePages ? { label: words().moreVenues, href: pageHref(props.page + 1), forward: true } : undefined}
            >
              <For each={props.venues}>
                {(venue) => (
                  <Row
                    mark={sign(venue)}
                    lines={[venue.name]}
                    // how it stands is a dot and words, quiet at the end; green only while it is open
                    // k2b-ui gap: no plain state dot beside words (Dot is internal, the icon font has no filled
                    // point); the round `point` stands in for it
                    time={
                      <>
                        <Icon name="point" tone={venue.state.kind === "open" ? "ok" : "subtle"} /> {stateWords(venue)}
                      </>
                    }
                    href={`/app/venue/${venue.id}`}
                  />
                )}
              </For>
            </Section>
            <Show when={props.venues.length === 0}>
              <Empty
                icon="search"
                text={props.initialQuery ? t().noMatchingVenues : t().noVenues}
                action={props.initialQuery ? { label: t().clearSearch, href: "/app/venue" } : createAction()}
              />
            </Show>
          </Show>
        </Pane>
        <CreateVenueDialog
          open={creating()}
          templates={props.templates}
          close={(id) => {
            setCreating(false);
            if (!id) return;
            toast(t().venueCreated, { status: "ok" });
            navigateTo(`/app/venue/${id}`);
          }}
        />
      </Workspace>
    </>
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

/** A blank venue or one from a template; a fresh form each time it opens. */
export function CreateVenueDialog(props: { open: boolean; templates: VenueTemplateSummary[]; close: (venueId: string | null) => void }) {
  return (
    <Show when={props.open}>
      <CreateVenueForm templates={props.templates} close={props.close} />
    </Show>
  );
}

const BLANK = "blank";

/**
 * It asks for the name and, where there are templates, which one to start from; the address (slug) follows the name
 * until someone edits it. A slug the server refuses shows at its field, and every input stays.
 */
function CreateVenueForm(props: { templates: VenueTemplateSummary[]; close: (venueId: string | null) => void }) {
  const { t, words } = useVenueWords();
  const [templateId, setTemplateId] = createSignal(BLANK);
  const [name, setName] = createSignal("");
  const [ownSlug, setOwnSlug] = createSignal<string | null>(null);
  const [tried, setTried] = createSignal(false);
  const [problem, setProblem] = createSignal<{ slug: string; message: string } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const template = () => props.templates.find((entry) => entry.id === templateId());
  const slug = () => ownSlug() ?? slugFromName(name().trim() || template()?.name || "");
  const nameError = () => (tried() && !template() && !name().trim() ? t().nameRequired : undefined);
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
    const chosen = template();
    try {
      const response = chosen
        ? await apiClient.templates[":templateId"].$post({
            param: { templateId: chosen.id },
            json: { name: name().trim() || undefined, slug: slug() },
          })
        : await apiClient.venues.$post({ json: { name: name().trim(), slug: slug(), timezone: browserTimeZone() } });
      if (response.ok) {
        setBusy(false);
        props.close((await response.json()).id);
        return;
      }
      const message = await readError(response, chosen ? t().createFromTemplateFailed : t().createVenueFailed);
      // The server names the field: a taken slug answers 409, a malformed one 400 with `slug: …`.
      if (response.status === 409) setProblem({ slug: slug(), message: t().slugTaken });
      else if (message.startsWith("slug:")) setProblem({ slug: slug(), message: t().slugInvalid });
      else setError(message);
    } catch {
      setError(chosen ? t().createFromTemplateFailed : t().createVenueFailed);
    }
    setBusy(false);
  };
  return (
    <Dialog
      title={t().createVenue}
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
      <Field
        name="name"
        label={t().name}
        hint={template() ? t().templateNameDescription : undefined}
        required={!template()}
        optional={template() ? words().optional : undefined}
        error={nameError()}
      >
        <Input value={name()} placeholder={template()?.name ?? t().venueNamePlaceholder} onInput={setName} />
      </Field>
      <Show when={props.templates.length > 0}>
        <Field name="template" label={words().template} hint={template()?.description ?? t().blankVenueDescription}>
          <Select
            value={templateId()}
            onChange={setTemplateId}
            options={[{ value: BLANK, label: t().blankVenue }, ...props.templates.map((entry) => ({ value: entry.id, label: entry.name }))]}
          />
        </Field>
      </Show>
      <Field name="slug" label={t().slug} hint={t().slugDescription} error={slugError()}>
        <Input value={slug()} onInput={(value) => setOwnSlug(value.trim().toLowerCase())} />
      </Field>
    </Dialog>
  );
}
