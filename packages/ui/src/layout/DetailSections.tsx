import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Button } from "../actions/Button";
import { Avatar, type AvatarShape } from "../surfaces/Avatar";
import { AvatarStack, type AvatarStackPerson } from "../surfaces/AvatarStack";
import { personColor } from "../surfaces/person-color";
import DetailPanel from "./DetailPanel";
import { useDetailPanelMessages } from "./detail-panel-messages";
import { useDetailSectionMessages } from "./detail-sections-messages";

/*
 * Shared sections of an object's detail panel. Each one is a `DetailPanel.Section` with its icon, title, and count, so
 * its content starts on the title's text edge, and each keeps its height while its data changes. Apps pass data; the
 * order of sections is a convention (see the DetailPanel UI context).
 */

const listNames = (names: readonly string[], and: string): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;

// ── Presence ────────────────────────────────────────────────────────────

export type DetailPresencePerson = {
  /** Stable key, such as the account id. */
  id: string;
  name: string;
  /** A shorter name for the chip and the line below it, such as the first name. Defaults to `name`. */
  shortName?: string;
  src?: string | null;
  icon?: string;
  /** `square` for agents and service accounts. */
  shape?: AvatarShape;
  /** The person's color, the same as their cursor and comments. Defaults to `personColor(name)`. */
  color?: string;
  /** Writing shows a pen and the person's place; reading shows an eye. */
  activity?: "writing" | "reading";
  /** Where the person is, such as the heading of the section they write in. */
  place?: string;
  /** Short text at the end of the person's row in the full list, such as "2 tabs". */
  trailing?: JSX.Element;
  /** Goes to the person's place. */
  onSelect?: () => void;
  /** The person viewing: the fixed "You" chip at the end, never one of the others. */
  self?: boolean;
};

/** `offline` keeps the last known people, pale and without live dots; `unavailable` offers `onRetry`. */
export type DetailPresenceState = "live" | "loading" | "offline" | "unavailable";

export type DetailPresenceProps = {
  people: readonly DetailPresencePerson[];
  state?: DetailPresenceState;
  /**
   * The quiet line below the people when it does not say who writes where: alone ("Whoever opens the note appears
   * here"), offline ("Offline · as of 19:24"), or unavailable ("Your changes are still being saved").
   */
  note?: JSX.Element;
  onRetry?: () => void;
  /** One control at the end of the title row, such as "Copy link". */
  actions?: JSX.Element;
  /** Defaults to "Here now". */
  title?: string;
  /** One quiet line below the full list. */
  listHint?: JSX.Element;
  class?: string;
};

const PresenceFace = (props: { person: DetailPresencePerson; live: boolean }): JSX.Element => (
  <span class="k2b-detail-presence__face" data-live={props.live ? "true" : undefined}>
    <Avatar name={props.person.name} src={props.person.src} icon={props.person.icon} shape={props.person.shape} size="xs" alt="" />
    <span class="k2b-detail-presence__dot" aria-hidden="true" />
  </span>
);

/**
 * "Here now": who has the object open, what they do, and where. Always two lines tall in every state, so people
 * coming, going, or moving never shift the panel. Chips that do not fit wrap into a hidden line and count as "+n";
 * "+n" and "You" open the full list, which `AvatarStack` shows beside it or as a sheet on phones.
 */
export function DetailPresence(props: DetailPresenceProps): JSX.Element {
  const t = useDetailSectionMessages();
  const state = () => props.state ?? "live";
  const others = createMemo(() => props.people.filter((person) => !person.self));
  const self = createMemo(() => props.people.find((person) => person.self));
  const short = (person: DetailPresencePerson) => person.shortName ?? person.name;
  const color = (person: DetailPresencePerson) => person.color ?? personColor(person.name);
  const [hidden, setHidden] = createSignal(0);
  let chips: HTMLDivElement | undefined;

  // Chips that do not fit wrap into the clipped second line; they leave the tab order and count as "+n".
  const fit = () => {
    if (!chips) return;
    const all = Array.from(chips.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const top = all[0]?.offsetTop ?? 0;
    let wrapped = 0;
    for (const chip of all) {
      const out = chip.offsetTop > top;
      chip.inert = out;
      if (out) wrapped += 1;
    }
    setHidden(wrapped);
  };
  // The strip mounts again after loading or an outage, so each mounted strip watches itself.
  const watchChips = (element: HTMLDivElement) => {
    chips = element;
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(fit);
    resized.observe(element);
    const changed = new MutationObserver(fit);
    changed.observe(element, { childList: true });
    queueMicrotask(fit);
    onCleanup(() => {
      resized.disconnect();
      changed.disconnect();
    });
  };

  const describe = (person: DetailPresencePerson) =>
    person.activity === "writing"
      ? t().personWriting({ name: person.name, place: person.place ?? "" })
      : t().personReading({ name: person.name });

  const listPeople = createMemo<AvatarStackPerson[]>(() =>
    props.people.map((person) => ({
      id: person.id,
      name: person.self ? t().you : person.name,
      src: person.src,
      icon: person.icon,
      shape: person.shape,
      self: person.self,
      detailIcon: person.self ? undefined : person.activity === "writing" ? "ti ti-pencil" : "ti ti-eye",
      detail: [person.self ? undefined : person.activity === "writing" ? t().writing : t().reading, person.place]
        .filter(Boolean)
        .join(" · "),
      trailing: person.trailing,
      onSelect: person.onSelect,
    })),
  );

  const where = (): JSX.Element => {
    if (state() === "offline" || others().length === 0) return props.note;
    const writers = others().filter((person) => person.activity === "writing");
    const readers = others().filter((person) => person.activity !== "writing");
    return (
      <>
        <For each={writers}>
          {(person, index) => (
            <>
              {index() > 0 ? ", " : ""}
              <span class="k2b-detail-presence__swatch" style={{ "--k2b-person-color": color(person) }} aria-hidden="true" />
              <strong>{short(person)}</strong>
              <Show when={person.place}>
                {(place) => (
                  <>
                    {" "}
                    {t().writesIn} {place()}
                  </>
                )}
              </Show>
            </>
          )}
        </For>
        <Show when={writers.length > 0 && readers.length > 0}>{" · "}</Show>
        <Show when={readers.length > 0}>{t().readingAlong({ names: listNames(readers.map(short), t().and), count: readers.length })}</Show>
      </>
    );
  };

  const chip = (person: DetailPresencePerson): JSX.Element => {
    const content = (
      <>
        <PresenceFace person={person} live={state() === "live"} />
        <span class="k2b-detail-presence__name">{short(person)}</span>
        <i
          class={person.activity === "writing" ? "ti ti-pencil k2b-detail-presence__activity" : "ti ti-eye k2b-detail-presence__activity"}
          data-activity={person.activity ?? "reading"}
          aria-hidden="true"
        />
      </>
    );
    return (
      <Show
        when={person.onSelect && state() === "live"}
        fallback={
          <span class="k2b-detail-presence__chip" style={{ "--k2b-person-color": color(person) }} title={describe(person)}>
            <span class="k2b-sr-only">{describe(person)}</span>
            <span aria-hidden="true" class="k2b-detail-presence__chip-content">
              {content}
            </span>
          </span>
        }
      >
        <button
          type="button"
          class="k2b-detail-presence__chip"
          style={{ "--k2b-person-color": color(person) }}
          title={describe(person)}
          aria-label={t().jumpTo({ name: person.name, place: person.place ?? "" })}
          onClick={() => person.onSelect?.()}
        >
          <span aria-hidden="true" class="k2b-detail-presence__chip-content">
            {content}
          </span>
        </button>
      </Show>
    );
  };

  const count = () => ((state() === "live" || state() === "offline") && others().length > 0 ? others().length : undefined);
  const meta = () => (state() === "live" && others().length === 0 ? t().onlyYou : undefined);

  return (
    <DetailPanel.Section
      title={props.title ?? t().hereNow}
      icon="ti ti-users"
      count={count()}
      meta={meta()}
      actions={props.actions}
      class={props.class ? `k2b-detail-presence-section ${props.class}` : "k2b-detail-presence-section"}
    >
      <div class="k2b-detail-presence" data-state={state()} aria-busy={state() === "loading" ? "true" : undefined}>
        <Show
          when={state() !== "loading" && state() !== "unavailable"}
          fallback={
            <Show
              when={state() === "unavailable"}
              fallback={
                <>
                  <div class="k2b-detail-presence__strip" aria-hidden="true">
                    <span class="k2b-detail-presence__skeleton" />
                    <span class="k2b-detail-presence__skeleton" />
                    <span class="k2b-detail-presence__skeleton" />
                  </div>
                  <p class="k2b-detail-presence__where">
                    <span class="k2b-detail-presence__skeleton-line" aria-hidden="true" />
                    <span class="k2b-sr-only" role="status">
                      {t().presenceLoading}
                    </span>
                  </p>
                </>
              }
            >
              <div class="k2b-detail-presence__strip k2b-detail-presence__problem" role="status">
                <i class="ti ti-alert-triangle" aria-hidden="true" />
                <span class="k2b-truncate-fade">{t().presenceUnavailable}</span>
                <Show when={props.onRetry}>
                  {(retry) => (
                    <Button variant="text" size="xs" class="k2b-detail-presence__retry" onClick={() => retry()()}>
                      <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                    </Button>
                  )}
                </Show>
              </div>
              <p class="k2b-detail-presence__where k2b-truncate-fade">{props.note}</p>
            </Show>
          }
        >
          <div class="k2b-detail-presence__strip">
            <div ref={watchChips} class="k2b-detail-presence__chips">
              <For each={others()}>{(person) => chip(person)}</For>
            </div>
            <AvatarStack
              class="k2b-detail-presence__all"
              people={listPeople()}
              title={props.title ?? t().hereNow}
              label={t().everyoneHere({ count: props.people.length })}
              hint={props.listHint}
              trigger={
                <>
                  <span class="k2b-detail-presence__more" data-empty={hidden() === 0 ? "true" : undefined}>
                    +{hidden()}
                  </span>
                  <Show when={self()}>
                    {(person) => (
                      <span class="k2b-detail-presence__self">
                        <PresenceFace person={person()} live={false} />
                        <span class="k2b-detail-presence__name">{t().you}</span>
                      </span>
                    )}
                  </Show>
                </>
              }
            />
          </div>
          <p class="k2b-detail-presence__where k2b-truncate-fade">{where()}</p>
        </Show>
      </div>
    </DetailPanel.Section>
  );
}

/** A fixed slot at the end of a row for the people working there, such as an outline heading. Always the same width. */
export function DetailPresenceSlot(props: { people: readonly DetailPresencePerson[]; max?: number }): JSX.Element {
  const max = () => Math.max(1, props.max ?? 2);
  return (
    <span class="k2b-detail-presence-slot" aria-hidden="true">
      <For each={props.people.slice(0, max())}>
        {(person) => <Avatar name={person.name} src={person.src} icon={person.icon} shape={person.shape} size="xs" alt="" />}
      </For>
      <Show when={props.people.length > max()}>
        <span class="k2b-detail-presence-slot__more">+{props.people.length - max()}</span>
      </Show>
    </span>
  );
}

// ── Access ──────────────────────────────────────────────────────────────

export type DetailAccessEntry = {
  id: string;
  name: string;
  /** Sets the avatar: a person's picture or initials, a group, a service, all signed-in people, or public. */
  kind?: "person" | "group" | "service" | "everyone" | "public";
  src?: string | null;
  /** One quiet word after the name, such as "Service". */
  detail?: JSX.Element;
  /** The role in words, such as "Can edit". */
  role: JSX.Element;
  /** The person viewing; listed as "You". */
  self?: boolean;
};

export type DetailAccessProps = {
  entries: readonly DetailAccessEntry[];
  state?: "ready" | "loading" | "error";
  onRetry?: () => void;
  /** Rows before "Show n more". Defaults to 5. */
  limit?: number;
  /** A way to change access, only for people who may; others read the list. */
  manage?: { label: string; href?: string; onClick?: () => void };
  /** A quiet line below the list, such as "Applies to the whole notebook". */
  note?: JSX.Element;
  /** Defaults to "Access". */
  title?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  class?: string;
};

const ACCESS_ICONS: Record<NonNullable<DetailAccessEntry["kind"]>, string | undefined> = {
  person: undefined,
  service: undefined,
  group: "ti ti-users-group",
  everyone: "ti ti-users",
  public: "ti ti-world",
};

/**
 * Who has access and with which role, read-only. Closed it names the first entries; open it lists `limit` rows and
 * "Show n more". A list that may load later passes `state="loading"` and keeps its place.
 */
export function DetailAccess(props: DetailAccessProps): JSX.Element {
  const t = useDetailSectionMessages();
  const panel = useDetailPanelMessages();
  const [all, setAll] = createSignal(false);
  const limit = () => Math.max(1, props.limit ?? 5);
  const state = () => props.state ?? "ready";
  const shown = () => (all() ? props.entries : props.entries.slice(0, limit()));
  const hiddenCount = () => Math.max(0, props.entries.length - limit());
  const nameOf = (entry: DetailAccessEntry) => (entry.self ? t().you : entry.name);
  const summary = () => {
    if (state() === "loading") return t().accessLoading;
    if (state() === "error") return t().accessFailed;
    const names = props.entries.slice(0, 2).map(nameOf);
    return names.length ? t().accessSummary({ names: names.join(", "), more: Math.max(0, props.entries.length - 2) }) : undefined;
  };
  const leading = (entry: DetailAccessEntry) => {
    const kind = entry.kind ?? "person";
    return (
      <Avatar
        name={entry.name}
        src={kind === "person" ? entry.src : undefined}
        icon={ACCESS_ICONS[kind]}
        shape={kind === "person" ? "circle" : "square"}
        size="xs"
        alt=""
      />
    );
  };
  return (
    <DetailPanel.Section
      title={props.title ?? t().access}
      icon="ti ti-lock-access"
      count={state() === "ready" ? props.entries.length : undefined}
      collapsible
      summary={summary()}
      defaultOpen={props.defaultOpen}
      open={props.open}
      onOpenChange={props.onOpenChange}
      class={props.class ? `k2b-detail-access ${props.class}` : "k2b-detail-access"}
    >
      <div class="k2b-detail-section-rows" aria-busy={state() === "loading" ? "true" : undefined}>
        <Show when={state() === "loading"}>
          <For each={[0, 1, 2]}>
            {() => (
              <DetailPanel.Row leading={<span class="k2b-detail-row-skeleton__face" />} title={<span class="k2b-detail-row-skeleton" />} />
            )}
          </For>
          <span class="k2b-sr-only" role="status">
            {t().accessLoading}
          </span>
        </Show>
        <Show when={state() === "error"}>
          <div class="k2b-detail-section-error" role="alert">
            <i class="ti ti-alert-circle" aria-hidden="true" />
            <span>{t().accessFailed}</span>
            <Show when={props.onRetry}>
              {(retry) => (
                <Button variant="text" size="xs" onClick={() => retry()()}>
                  {t().retry}
                </Button>
              )}
            </Show>
          </div>
        </Show>
        <Show when={state() === "ready"}>
          <For each={shown()}>
            {(entry) => (
              <DetailPanel.Row
                leading={leading(entry)}
                title={nameOf(entry)}
                description={entry.detail}
                trailing={entry.role}
                class={entry.self ? "k2b-detail-access__self" : undefined}
              />
            )}
          </For>
          <Show when={hiddenCount() > 0}>
            <DetailPanel.Action
              type="button"
              aria-expanded={all()}
              leading={<i class={all() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />}
              title={all() ? panel().showLess : panel().showMore({ count: hiddenCount() })}
              onClick={() => setAll(!all())}
            />
          </Show>
        </Show>
        <Show when={props.manage}>
          {(manage) => (
            <Show
              when={manage().href}
              fallback={
                <DetailPanel.Action
                  type="button"
                  leading={<i class="ti ti-settings" aria-hidden="true" />}
                  title={manage().label}
                  onClick={() => manage().onClick?.()}
                />
              }
            >
              {(href) => (
                <DetailPanel.Action href={href()} leading={<i class="ti ti-settings" aria-hidden="true" />} title={manage().label} />
              )}
            </Show>
          )}
        </Show>
        <Show when={props.note}>
          <p class="k2b-detail-section-note">{props.note}</p>
        </Show>
      </div>
    </DetailPanel.Section>
  );
}

// ── Links ───────────────────────────────────────────────────────────────

export type DetailLinkItem = {
  id: string;
  title: string;
  href?: string;
  onClick?: (event: MouseEvent) => void;
  /** Defaults to a document. */
  icon?: string;
  /** Quiet text at the end, such as the other notebook's name. */
  trailing?: JSX.Element;
};

export type DetailLinksProps = {
  /** What links here. */
  incoming: readonly DetailLinkItem[];
  /** What this object links to. */
  outgoing: readonly DetailLinkItem[];
  /** Rows per direction before "Show n more". Defaults to 5. */
  limit?: number;
  /** Defaults to "Links". */
  title?: string;
  defaultOpen?: boolean;
  class?: string;
};

const LinkGroup = (props: { label: string; items: readonly DetailLinkItem[]; limit: number }): JSX.Element => {
  const panel = useDetailPanelMessages();
  const [all, setAll] = createSignal(false);
  const hiddenCount = () => Math.max(0, props.items.length - props.limit);
  return (
    <div class="k2b-detail-section-group">
      <div class="k2b-detail-section-label">{props.label}</div>
      <For each={all() ? props.items : props.items.slice(0, props.limit)}>
        {(item) => {
          const shared = {
            leading: <i class={item.icon ?? "ti ti-file-text"} aria-hidden="true" />,
            title: item.title,
            trailing: item.trailing,
          };
          return (
            <Show when={item.href} fallback={<DetailPanel.Action type="button" onClick={(event) => item.onClick?.(event)} {...shared} />}>
              {(href) => <DetailPanel.Action href={href()} onClick={(event: MouseEvent) => item.onClick?.(event)} {...shared} />}
            </Show>
          );
        }}
      </For>
      <Show when={hiddenCount() > 0}>
        <DetailPanel.Action
          type="button"
          aria-expanded={all()}
          leading={<i class={all() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />}
          title={all() ? panel().showLess : panel().showMore({ count: hiddenCount() })}
          onClick={() => setAll(!all())}
        />
      </Show>
    </div>
  );
};

/** "Linked from" and "Links to" in one section. Without links it is one row: the title and "None yet". */
export function DetailLinks(props: DetailLinksProps): JSX.Element {
  const t = useDetailSectionMessages();
  const limit = () => Math.max(1, props.limit ?? 5);
  const total = () => props.incoming.length + props.outgoing.length;
  const summary = () => {
    const names = (items: readonly DetailLinkItem[]) => ({
      names: listNames(
        items.slice(0, 2).map((item) => item.title),
        t().and,
      ),
      more: Math.max(0, items.length - 2),
    });
    return props.incoming.length ? t().linkedBySummary(names(props.incoming)) : t().linksToSummary(names(props.outgoing));
  };
  const className = () => (props.class ? `k2b-detail-links ${props.class}` : "k2b-detail-links");
  return (
    <Show
      when={total() > 0}
      fallback={<DetailPanel.Section title={props.title ?? t().links} icon="ti ti-arrows-exchange" count={0} class={className()} />}
    >
      <DetailPanel.Section
        title={props.title ?? t().links}
        icon="ti ti-arrows-exchange"
        count={total()}
        collapsible
        defaultOpen={props.defaultOpen ?? true}
        summary={summary()}
        class={className()}
      >
        <div class="k2b-detail-section-rows">
          <Show when={props.incoming.length > 0}>
            <LinkGroup label={t().linkedBy({ count: props.incoming.length })} items={props.incoming} limit={limit()} />
          </Show>
          <Show when={props.outgoing.length > 0}>
            <LinkGroup label={t().linksTo({ count: props.outgoing.length })} items={props.outgoing} limit={limit()} />
          </Show>
        </div>
      </DetailPanel.Section>
    </Show>
  );
}

// ── Properties ──────────────────────────────────────────────────────────

export type DetailProperty = {
  id: string;
  label: JSX.Element;
  value: JSX.Element;
  /** An avatar or icon before the value. */
  leading?: JSX.Element;
  /** Makes the value a link, such as "23 versions" to the version history. */
  href?: string;
};

export type DetailPropertiesProps = {
  items: readonly DetailProperty[];
  /** Defaults to "Properties". */
  title?: string;
  icon?: string;
  /** One line for the closed section, such as "412 words · created 12 March by Jana Berger". */
  summary?: JSX.Element;
  /** Open by default only when the properties are the object's main content. */
  defaultOpen?: boolean;
  class?: string;
};

/** Facts about the object as label and value rows, such as created, edited, size, and the way to its history. */
export function DetailProperties(props: DetailPropertiesProps): JSX.Element {
  const t = useDetailSectionMessages();
  return (
    <DetailPanel.Section
      title={props.title ?? t().properties}
      icon={props.icon ?? "ti ti-info-square"}
      collapsible
      defaultOpen={props.defaultOpen}
      summary={props.summary}
      class={props.class ? `k2b-detail-properties-section ${props.class}` : "k2b-detail-properties-section"}
    >
      <dl class="k2b-detail-properties">
        <For each={props.items}>
          {(item) => (
            <div class="k2b-detail-properties__item">
              <dt>{item.label}</dt>
              <dd>
                <Show when={item.leading}>
                  <span class="k2b-detail-properties__leading">{item.leading}</span>
                </Show>
                <Show when={item.href} fallback={<span class="k2b-detail-properties__value">{item.value}</span>}>
                  {(href) => (
                    <a class="k2b-detail-properties__value k2b-detail-properties__link" href={href()}>
                      {item.value}
                    </a>
                  )}
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </DetailPanel.Section>
  );
}

// ── Tags ────────────────────────────────────────────────────────────────

export type DetailTag = {
  id: string;
  label: string;
  /** Where the tag leads, such as everything with that tag. */
  href?: string;
};

export type DetailTagsProps = {
  tags: readonly DetailTag[];
  /** Defaults to "Tags". */
  title?: string;
  /** Shown without tags, such as how to add one. */
  emptyHint?: JSX.Element;
  class?: string;
};

/** The object's tags as chips; a chip with `href` leads to everything with that tag. */
export function DetailTags(props: DetailTagsProps): JSX.Element {
  const t = useDetailSectionMessages();
  return (
    <DetailPanel.Section
      title={props.title ?? t().tags}
      icon="ti ti-hash"
      count={props.tags.length}
      class={props.class ? `k2b-detail-tags-section ${props.class}` : "k2b-detail-tags-section"}
    >
      <Show when={props.tags.length > 0} fallback={props.emptyHint ? <p class="k2b-detail-section-note">{props.emptyHint}</p> : undefined}>
        <ul class="k2b-detail-tags">
          <For each={props.tags}>
            {(tag) => (
              <li>
                <Show when={tag.href} fallback={<span class="k2b-detail-tag">#{tag.label}</span>}>
                  {(href) => (
                    <a class="k2b-detail-tag" href={href()}>
                      #{tag.label}
                    </a>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </DetailPanel.Section>
  );
}
