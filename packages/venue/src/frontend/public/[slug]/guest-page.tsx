import {
  Band,
  Bar,
  Button,
  Chip,
  Empty,
  Facts,
  Inline,
  Notice,
  Pane,
  Prose,
  RangeBar,
  RecordHead,
  Row,
  type RowLines,
  Section,
  Table,
  Text,
  useLocale,
  Workspace,
} from "@k2b/ui/v2";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import {
  type OpeningRule,
  type PublicException,
  type PublicMenuItem,
  PublicMenuItemSchema,
  type PublicSection,
  type PublicStatus,
  type PublicWindow,
  publicLinkHref,
} from "../../../contracts";
import { type VenueMessages, venueMessages } from "../../../messages";
import { formatClockRange, formatDateKey, formatVenueDay, formatVenueTime, formatVenueTimeRange } from "../../../time-format";

/**
 * The venue's page for guests without an account, as the approved mockup draws it: the venue's sign and name with
 * "Rate" as the one task, the hero that says now in one statement ("Open until 15:00") with what comes next, the
 * venue's sections in the admin's order, and beside them the week's hours on one scale and the changed hours of the
 * next 30 days. It renders on the server only: reading needs no script.
 */

/** Weekdays in visitor order: Monday first, Sunday last. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/** Hours of a clock time such as `17:30` (17.5); `24:00` is the end of the day. */
const hours = (time: string) => Number(time.slice(0, 2)) + Number(time.slice(3, 5)) / 60;

/** The end of a window as the venue's clock says it: the midnight that ends a day is `24:00`, as in the week's hours. */
const endTime = (iso: string, timeZone: string, locale: string) => {
  const time = formatVenueTime(iso, timeZone, locale);
  return time === "00:00" ? "24:00" : time;
};

const ranges = (windows: readonly PublicWindow[], timeZone: string, locale: string) =>
  windows
    .map((window) => formatClockRange(formatVenueTime(window.startsAt, timeZone, locale), endTime(window.endsAt, timeZone, locale)))
    .join(", ");

/** The hero's three lines: the statement, today's exception, and what comes next. */
type Hero = { figure: string; beside?: string; why?: { text: string; tone: "warn" | "ok" }; next?: string };

/** "Monday" within the coming week, "Monday, Nov 30" further ahead or with `withDate`. */
const dayName = (iso: string, today: string, timeZone: string, locale: string, withDate = false) => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const soon = Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`) < 7 * 86_400_000;
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    ...(soon && !withDate ? {} : { day: "numeric", month: "short" }),
  }).format(new Date(iso));
};

const isTomorrow = (window: PublicWindow, tomorrow: readonly PublicWindow[]) => tomorrow.some((each) => each.startsAt === window.startsAt);

/** The hero of `status.now` in the visitor's words. */
export const heroOf = (status: PublicStatus, t: VenueMessages, locale: string): Hero => {
  const { now, venue } = status;
  const zone = venue.timezone;
  const time = (iso: string) => formatVenueTime(iso, zone, locale);
  const exception = now.exception;
  const why: Hero["why"] =
    exception?.kind === "closed"
      ? {
          text: [
            now.regular.length > 0 ? t.guestInstead({ window: ranges(now.regular, zone, locale) }) : t.guestClosedToday,
            exception.note,
          ]
            .filter(Boolean)
            .join(" · "),
          tone: "warn",
        }
      : exception?.kind === "open" && exception.startTime && exception.endTime
        ? {
            text: [t.specialOpening({ window: formatClockRange(exception.startTime, exception.endTime) }), exception.note]
              .filter(Boolean)
              .join(" · "),
            tone: "ok",
          }
        : status.spontaneousOpen
          ? { text: t.spontaneousOpen, tone: "ok" }
          : undefined;
  // "Monday from 08:00" or "tomorrow from 08:00": the next opening after today
  const from = (window: PublicWindow) =>
    isTomorrow(window, now.tomorrow)
      ? t.guestTomorrowFrom({ time: time(window.startsAt) })
      : t.guestDayFrom({ day: dayName(window.startsAt, now.date, zone, locale), time: time(window.startsAt) });
  const capital = (text: string) => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

  if (now.state === "open") {
    const later = now.today.find((window) => now.until !== null && Date.parse(window.startsAt) > Date.parse(now.until));
    const next = later
      ? t.guestAgainFrom({ time: time(later.startsAt) })
      : now.tomorrow.length > 0
        ? t.guestTomorrow({ windows: ranges(now.tomorrow, zone, locale) })
        : [t.guestTomorrowClosed, now.next ? capital(from(now.next)) : undefined].filter(Boolean).join(" · ");
    return { figure: t.open, beside: now.until ? t.guestUntil({ time: endTime(now.until, zone, locale) }) : undefined, why, next };
  }
  if (now.state === "later") {
    // `today` holds the windows still to come: the first one is when the venue opens
    const opens = now.today[0];
    return {
      figure: opens ? t.guestOpensAt({ time: time(opens.startsAt) }) : t.closed,
      why,
      next: [t.guestToday({ windows: ranges(now.today, zone, locale) }), now.next ? capital(from(now.next)) : undefined]
        .filter(Boolean)
        .join(" · "),
    };
  }
  return {
    figure: exception?.kind === "closed" ? t.guestClosedToday : t.closed,
    why,
    next: now.next
      ? isTomorrow(now.next, now.tomorrow)
        ? t.guestOpensTomorrow({ time: time(now.next.startsAt) })
        : t.guestOpensOn({ day: dayName(now.next.startsAt, now.date, zone, locale, true), time: time(now.next.startsAt) })
      : t.noUpcomingOpening,
  };
};

const sectionText = (section: PublicSection, key: "markdown" | "text"): string => {
  const value = section.content[key];
  return typeof value === "string" ? value : "";
};

const sectionList = (section: PublicSection, key: "items" | "links"): unknown[] => {
  const value = section.content[key];
  return Array.isArray(value) ? value : [];
};

/** The menu's valid items; the server already left out those outside their dates. */
const menuItems = (section: PublicSection): PublicMenuItem[] =>
  sectionList(section, "items").flatMap((raw) => {
    const parsed = PublicMenuItemSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });

/**
 * A menu row: the name, which wraps rather than being cut, and under it its description and its info or allergens in
 * one quiet line, where it has words.
 */
const menuLines = (item: PublicMenuItem): RowLines => {
  const second = [item.description, item.info || item.allergens].filter(Boolean).join(" · ");
  return second ? [item.name, second] : [item.name];
};

/** A changed day: its date, and under it the reason the admin gave. */
const changeLines = (exception: PublicException, locale: string): RowLines => {
  const date = formatDateKey(exception.date, locale, { weekday: "short", day: "numeric", month: "short" });
  return exception.note ? [date, exception.note] : [date];
};

type GuestLink = { label: string; href: string; target: string; icon: string };

/** A link's quiet sign by its kind: phone, mail, a page on this Cloud, or the web. */
const linkIcon = (href: string) =>
  href.startsWith("tel:") ? "phone" : href.startsWith("mailto:") ? "mail" : href.startsWith("/") ? "link" : "world";

/** The section's links that visitors can follow, by the rule that saving a section enforces. */
const guestLinks = (section: PublicSection): GuestLink[] =>
  sectionList(section, "links").flatMap((raw) => {
    const link = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const href = typeof link.href === "string" ? publicLinkHref(link.href) : null;
    if (!href) return [];
    const url = href.startsWith("/") ? null : new URL(href);
    const target = !url ? href : url.protocol === "http:" || url.protocol === "https:" ? url.host : href.slice(url.protocol.length);
    const label = typeof link.label === "string" && link.label.trim() ? link.label.trim() : target;
    return [{ label, href, target, icon: linkIcon(href) }];
  });

/** One section as guests see it, in the admin's order. */
const GuestSection = (props: { section: PublicSection; color: string }) => (
  <Switch>
    <Match when={props.section.kind === "notice"}>
      <Notice tone="warn" title={props.section.title}>
        {sectionText(props.section, "text") || sectionText(props.section, "markdown")}
      </Notice>
    </Match>
    <Match when={props.section.kind === "menu"}>
      {(() => {
        const items = menuItems(props.section);
        // when one item has a picture, every row leads with one (or the menu's sign), so the text edge never jumps
        const pictures = items.some((item) => item.image);
        return (
          <Section icon="tools-kitchen-2" color={props.color} title={props.section.title} count={items.length}>
            <For each={items}>
              {(item) => (
                <Row
                  lines={menuLines(item)}
                  mark={pictures ? { icon: "tools-kitchen-2", color: props.color, image: item.image ?? undefined } : undefined}
                  end={item.price ? <Text weight="medium">{item.price}</Text> : undefined}
                />
              )}
            </For>
          </Section>
        );
      })()}
    </Match>
    <Match when={props.section.kind === "markdown"}>
      <Section icon="align-left" color={props.color} title={props.section.title}>
        <Prose markdown={sectionText(props.section, "markdown")} />
      </Section>
    </Match>
    <Match when={props.section.kind === "links"}>
      <Section icon="link" color={props.color} title={props.section.title}>
        <For each={guestLinks(props.section)}>{(link) => <Row icon={link.icon} lines={[link.label, link.target]} href={link.href} />}</For>
      </Section>
    </Match>
  </Switch>
);

type Window = { startTime: string; endTime: string; note: string | null };
type DayRow = { key: string; weekday: number; name: string; windows: Window[]; today: boolean; closedToday: boolean };

/**
 * The week's regular hours on one scale, today in the app's tint. Today's exception stands in today's row: a closure
 * reads "Closed" in warn, a special opening shows its own window.
 */
const Hours = (props: { status: PublicStatus; t: VenueMessages; locale: string }) => {
  const rules = () => props.status.openingRules;
  const todayWeekday = () => new Date(`${props.status.now.date}T12:00:00Z`).getUTCDay();
  const special = (): Window | undefined => {
    const exception = props.status.now.exception;
    return exception?.kind === "open" && exception.startTime && exception.endTime
      ? { startTime: exception.startTime, endTime: exception.endTime, note: null }
      : undefined;
  };
  const windowsOf = (weekday: number): Window[] => {
    const today = special();
    if (today && weekday === todayWeekday()) return [today];
    return rules()
      .filter((rule: OpeningRule) => rule.weekday === weekday)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  };
  const from = () => Math.min(6, ...[...rules(), ...(special() ? [special()!] : [])].map((rule) => Math.floor(hours(rule.startTime))));
  const rows = (): DayRow[] =>
    WEEK.map((weekday) => ({
      key: String(weekday),
      weekday,
      name: new Intl.DateTimeFormat(props.locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + weekday))),
      windows: windowsOf(weekday),
      today: weekday === todayWeekday(),
      closedToday: weekday === todayWeekday() && props.status.now.exception?.kind === "closed",
    }));
  const words = (row: DayRow) => row.windows.map((window) => formatClockRange(window.startTime, window.endTime));
  return (
    <Section icon="clock" color={props.status.venue.accentColor} title={props.t.guestHours}>
      <Table
        label={props.t.guestHours}
        rows={rows()}
        rowKey={(row) => row.key}
        current={rows().find((row) => row.today)?.key}
        columns={[
          {
            title: props.t.guestDay,
            width: { fixed: 112 },
            cell: (row) => {
              const notes = row.windows.flatMap((window) => (window.note ? [window.note] : [])).join(" · ");
              return notes ? { lines: [row.name, notes] } : row.name;
            },
          },
          {
            title: props.t.guestScale({ from: from(), to: 24 }),
            // k2b-ui gap: G5 (W5, RangeBar with several ranges): a split day draws from its first start to its last end
            cell: (row) => (
              <RangeBar
                from={row.closedToday || row.windows.length === 0 ? Number.NaN : hours(row.windows[0]!.startTime)}
                to={row.closedToday || row.windows.length === 0 ? Number.NaN : hours(row.windows.at(-1)!.endTime)}
                domain={[from(), 24]}
                decorative
              />
            ),
          },
          {
            title: props.t.guestTimes,
            width: { fixed: 112 },
            align: "end",
            cell: (row) =>
              row.closedToday ? (
                <Text tone="warn" weight="medium">
                  {props.t.closed}
                </Text>
              ) : row.windows.length === 0 ? (
                <Text muted>{props.t.closed}</Text>
              ) : words(row).length > 1 ? (
                { lines: words(row) as [string, string] }
              ) : (
                words(row)[0]!
              ),
          },
        ]}
      />
    </Section>
  );
};

/** Closed days and special openings from tomorrow on: today stands in the hero only, so nothing is said twice. */
const ChangedHours = (props: { status: PublicStatus; t: VenueMessages; locale: string }) => {
  const changes = () => props.status.upcomingExceptions.filter((exception) => exception.date > props.status.now.date);
  return (
    <Show when={changes().length > 0}>
      <Section
        icon="calendar-event"
        color={props.status.venue.accentColor}
        title={props.t.guestChangedHours}
        count={changes().length}
        summary={props.t.guestChangedHoursWindow}
      >
        <For each={changes()}>
          {(exception) => (
            <Row
              lines={changeLines(exception, props.locale)}
              end={
                exception.kind === "closed" ? (
                  <Chip status="warn" quiet>
                    {props.t.closed}
                  </Chip>
                ) : (
                  <Chip status="ok" quiet>
                    {exception.startTime && exception.endTime
                      ? formatClockRange(exception.startTime, exception.endTime)
                      : props.t.specialOpeningKind}
                  </Chip>
                )
              }
            />
          )}
        </For>
      </Section>
    </Show>
  );
};

/** Openings staffing adds, for venues whose shifts open them. */
const StaffedOpenings = (props: { status: PublicStatus; t: VenueMessages; locale: string }) => (
  <Show when={props.status.upcomingOpenings.length > 0}>
    <Section
      icon="users"
      color={props.status.venue.accentColor}
      title={props.t.upcomingStaffedOpenings}
      count={props.status.upcomingOpenings.length}
    >
      <Facts
        items={props.status.upcomingOpenings.map((opening) => ({
          label: formatVenueDay(opening.startsAt, props.status.venue.timezone, props.locale),
          value: formatVenueTimeRange(opening.startsAt, opening.endsAt, props.status.venue.timezone, props.locale),
        }))}
      />
    </Section>
  </Show>
);

/** The venue's sign and name, and its one task. */
export const Head = (props: { status: PublicStatus; feedbackUrl?: string; t: VenueMessages }) => (
  <Bar
    start={
      // k2b-ui gap: G7 (W5 after #4227): RecordHead in a visitor head takes the name on two lines on the phone, and a
      // thing's sign (its icon on its colour, its logo) instead of a person's round avatar; until then initials
      // on the venue's colour or its logo in the round place, and a long name ends with "…"
      <RecordHead
        name={props.status.venue.name}
        avatar={{ name: props.status.venue.name, color: props.status.venue.accentColor, image: props.status.venue.logoBase64 ?? undefined }}
      />
    }
    end={
      <Show when={props.feedbackUrl}>
        {(href) => (
          <Button variant="primary" href={href()} keep>
            {props.t.guestRate}
          </Button>
        )}
      </Show>
    }
  />
);

/** The statement of now, in the main column under the head. */
const HeroBand = (props: { hero: Hero }) => (
  // k2b-ui gap: G4 (TI): the hero figure (30/34) with its time beside it; until then the lead type
  // k2b-ui gap: G2 (W5 after #4227): the figure in the venue's ink and, without a banner, a tint of its colour
  // k2b-ui gap: G3 (W5, feat/ui-v2-image-band): the venue's banner as a picture band under the head; left out until then
  <Band>
    <Inline>
      <Text type="lead" weight="strong">
        {props.hero.figure}
      </Text>
      <Show when={props.hero.beside}>{(beside) => <Text type="lead">{beside()}</Text>}</Show>
    </Inline>
    <Show when={props.hero.why}>
      {(why) => (
        <Text tone={why().tone} weight="medium">
          {why().text}
        </Text>
      )}
    </Show>
    <Show when={props.hero.next}>{(next) => <Text muted>{next()}</Text>}</Show>
  </Band>
);

export type GuestPageProps = {
  status: PublicStatus;
  /** Where "Rate" leads while the venue takes feedback. */
  feedbackUrl: string;
};

/** The guest page of a venue: one `Workspace`, two columns where the sections need room beside the hours. */
export const GuestPage = (props: GuestPageProps): JSX.Element => {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const status = () => props.status;
  const color = () => status().venue.accentColor;
  const hero = () => heroOf(status(), t(), locale());
  const regular = () => status().venue.openMode !== "staffed" && status().openingRules.length > 0;
  const facts = () => (
    <>
      <Show when={regular()}>
        <Hours status={status()} t={t()} locale={locale()} />
      </Show>
      <ChangedHours status={status()} t={t()} locale={locale()} />
      <StaffedOpenings status={status()} t={t()} locale={locale()} />
    </>
  );
  const description = () => (
    <Show when={status().venue.description}>
      {(text) => (
        <Band>
          <Text type="body">{text()}</Text>
        </Band>
      )}
    </Show>
  );
  return (
    <Workspace head={<Head status={status()} feedbackUrl={status().venue.feedbackEnabled ? props.feedbackUrl : undefined} t={t()} />}>
      {/* k2b-ui gap: G1 (W5 after #4227): the wide measure (a 1200 px card) and the 560 one; the page spans the window */}
      <Show
        when={status().sections.length > 0}
        fallback={
          <Pane label={status().venue.name}>
            <HeroBand hero={hero()} />
            {description()}
            {facts()}
          </Pane>
        }
      >
        <Pane.Split>
          <Pane label={status().venue.name}>
            <HeroBand hero={hero()} />
            {description()}
            <For each={status().sections}>{(section) => <GuestSection section={section} color={color()} />}</For>
          </Pane>
          <Pane side label={t().guestHours} width={{ fixed: 360 }}>
            {facts()}
          </Pane>
        </Pane.Split>
      </Show>
    </Workspace>
  );
};

/** The same page for every unknown or switched-off venue, so it reveals nothing. */
export const GuestUnavailable = (): JSX.Element => {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <Workspace>
      <Pane label={t().publicUnavailable} center>
        <Empty icon="building-store" text={t().guestPageUnavailable} action={{ label: t().guestOpenVenues, href: "/app/venue" }} />
      </Pane>
    </Workspace>
  );
};
