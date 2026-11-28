import { createSignal, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { personColor } from "../surfaces/person-color";
import { colorStyle, safeColor, safeValue } from "./colors";
import { useControlMessages } from "./control-messages";
import { Icon } from "./icon";
import { linkOr } from "./link";
import { initialsOf, type OnNavigate, type Person, type Status } from "./types";

/** Inline custom properties are the primitive's own business: data colours and measured widths, never layout. */
export const custom = (values: Record<string, string | undefined>): JSX.CSSProperties | undefined => {
  const entries = Object.entries(values).flatMap(([key, value]): [string, string][] => {
    if (value === undefined) return [];
    // a data colour comes from data: only a real colour passes (`colorStyle` validates it with `safeColor` and adds its
    // readable foregrounds), else the primitive stays neutral; anything else is the primitive's own number and never
    // ends its declaration
    if (key === "--k2-c") return Object.entries(colorStyle(value) ?? {});
    return safeValue(value) ? [[key, value]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
};

// ── Marks ────────────────────────────────────────────────────────────────────────────────────────────────────────

export { Icon, type IconProps } from "./icon";

export type AvatarProps = Person & {
  /**
   * The name stands right beside the avatar (a record head, a button with words): the avatar is then decoration and
   * says nothing a second time. The places that show the name set it themselves.
   */
  decorative?: boolean;
};

/**
 * A person as a picture, or as initials on a colour. The place sets the size: 24 px by default, 32 px leading a row
 * of two or three lines and in a record head (soft there), 20 px among the marks of a row and in a button. A picture
 * lies over the initials in the same place: while it loads, and when it fails, the initials show.
 */
/**
 * A picture that lies over a fallback in the same place (the initials of a person, the symbol of a thing): what became
 * of which picture, shown or failed. It belongs to its address, so a new picture (one just changed) is tried afresh.
 */
const createPicture = (src: () => string | undefined) => {
  const [outcome, setOutcome] = createSignal<{ src: string; state: "shown" | "failed" }>();
  const state = () => {
    const seen = outcome();
    return seen && seen.src === src() ? seen.state : undefined;
  };
  const settle = (image: HTMLImageElement, state: "shown" | "failed") => setOutcome({ src: image.getAttribute("src") ?? "", state });
  // A picture the browser had before the page came alive fired its events before anyone listened: `decode` answers
  // for it either way (also for a drawing without a size of its own, whose natural width may be 0).
  const settled = (image: HTMLImageElement) => {
    const address = image.getAttribute("src") ?? "";
    image.decode().then(
      () => setOutcome({ src: address, state: "shown" }),
      () => setOutcome({ src: address, state: "failed" }),
    );
  };
  // the picture adds no name: the place that holds it carries one (a failed picture then draws nothing over it)
  const Picture = () => (
    <Show when={state() !== "failed" && src()}>
      {(image) => (
        <img
          src={image()}
          alt=""
          decoding="async"
          // after its address is set (the attributes follow the element)
          ref={(element) => queueMicrotask(() => settled(element))}
          onLoad={(event) => settle(event.currentTarget, "shown")}
          onError={(event) => settle(event.currentTarget, "failed")}
        />
      )}
    </Show>
  );
  return { state, Picture };
};

const faceColor = (color: string | undefined): JSX.CSSProperties | undefined => (color === undefined ? undefined : { "--k2-c": color });

// A face, and in a stack its place from 1 on, which the stylesheet reads to let the later ones give way (a sibling
// count such as :nth-of-type cannot see through an island's wrapper). A button with a person uses the face alone, so
// a bundle with buttons carries no stack.
export const Face = (props: AvatarProps & { place?: number }) => {
  // Shown, the initials under the picture leave, as a picture may be transparent.
  const picture = createPicture(() => props.image);
  return (
    <span
      class="k2-av"
      data-k2-part="Avatar"
      data-k2-avatar=""
      data-place={props.place === undefined ? undefined : String(props.place)}
      data-image={props.image ? (picture.state() ?? "") : undefined}
      role="img"
      aria-label={props.name}
      aria-hidden={props.decorative ? "true" : undefined}
      // Every person has a colour: given, or the fixed one of their name, the same as everywhere in Cloud. A face reads
      // only the colour itself, none of the inks a mark derives from it; one that is no colour leaves it neutral.
      style={faceColor(props.color === undefined ? personColor(props.name) : safeColor(props.color))}
    >
      {initialsOf(props)}
      <picture.Picture />
    </span>
  );
};

export type AvatarStackProps = {
  /** The people, in order: who changed last, who has access. */
  people: readonly Person[];
  /** How many show before "+n" takes the rest: 3 when not set. */
  max?: number;
  /** A name for the whole stack, for assistive technology; without one the names of all the people. */
  label?: string;
};

/**
 * People side by side, each over the one before it with a ring of the surface, and "+n" for the rest. The stack is
 * one picture with one name; the avatars in it are decoration. 20 px in a row, a tile and a cell, 24 px elsewhere.
 */
const AvatarStack = (props: AvatarStackProps) => {
  // at most five faces; fewer when the place is narrow (the stylesheet decides by the stack's own width)
  const shown = () => props.people.slice(0, Math.min(5, Math.max(1, props.max ?? 3)));
  // "+n" for each number of faces the place may leave visible: the stylesheet shows the one that matches, so the count
  // is always right and always whole, from the server's first render on
  const counts = () =>
    shown()
      .map((_, index) => ({ visible: index + 1, rest: props.people.length - (index + 1) }))
      .filter((count) => count.rest > 0);
  // The stack's room when nothing is narrow: its faces (24 px, each over the one before by 4 px) and a count of up to
  // three signs, the measure the stylesheet hides faces by; one face alone needs no room for a count.
  const room = () => (shown().length === 1 ? 24 + (props.people.length > 1 ? 30 : 0) : 54 + 20 * (shown().length - 1));
  return (
    <span
      class="k2-avs"
      data-k2-part="Avatar.Stack"
      data-k={String(shown().length)}
      role="img"
      aria-label={props.label ?? props.people.map((person) => person.name).join(", ")}
      style={custom({ "--k2-avs-w": `${room()}px` })}
    >
      <For each={shown()}>{(person, index) => <Face {...person} decorative place={index() + 1} />}</For>
      <For each={counts()}>
        {(count) => (
          <span class="k2-avs-rest" data-visible={String(count.visible)} aria-hidden="true">
            {`+${count.rest}`}
          </span>
        )}
      </For>
    </span>
  );
};

export const Avatar = /* @__PURE__ */ Object.assign((props: AvatarProps) => <Face {...props} />, { Stack: AvatarStack });

export type MarkProps = {
  /** A Tabler icon for the kind of thing, such as `table`, `folder-filled` or `tool`. */
  icon: string;
  /**
   * The data colour of the thing: a base, a storage, a mailbox, or the colour of its type (a table, a form, a PDF).
   * Without one the mark stays neutral; give one wherever the data has it.
   */
  color?: string;
  /**
   * A small picture of the thing, such as the thumbnail of a photo or the first page of a PDF. It lies over the tinted
   * symbol in the same place: while it loads and when it fails the symbol shows, and nothing moves.
   */
  image?: string;
  /** The type in two to four letters on the corner of the picture or symbol, such as `PDF` or `XLS`. */
  kind?: string;
  /** A name for assistive technology; without one the mark is decoration, because the name stands beside it. */
  label?: string;
};

/**
 * What a thing looks like: its symbol on a tint of its colour, or its picture, in one square place. Every row, tile
 * and sidebar entry that stands for a thing leads with it (rule: each thing carries its mark). The place sets the
 * size: 20 px in the sidebar and in a sentence, 24 px leading a row of one line, 32 px leading a row of two or three
 * lines, 36 px on a tile.
 */
export const Mark = (props: MarkProps) => {
  const picture = createPicture(() => props.image);
  return (
    <span
      class="k2-mk"
      data-k2-part="Mark"
      data-image={props.image ? (picture.state() ?? "") : undefined}
      role="img"
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      style={custom({ "--k2-c": props.color })}
    >
      <Icon name={props.icon} />
      <picture.Picture />
      <Show when={props.kind}>
        {/* a glyph like an avatar's initials: it has no type role of the text around it */}
        <span class="k2-mk-kind" data-k2-glyph="">
          {props.kind}
        </span>
      </Show>
    </span>
  );
};

export type CoverProps = {
  /** The address of the picture, such as the banner of a place. Without one there is no cover, and no empty band. */
  src?: string;
  /**
   * What the picture shows, for people who cannot see it; `""` when it is decoration, such as a banner right above the
   * name of its place.
   */
  alt: string;
  /**
   * The cover stands above a task, such as a form, and only says where the person is: 72 to 88 px high instead of 120
   * to 180 px.
   */
  slim?: boolean;
};

/**
 * A picture across its place, such as a place's banner at the top of its page or detail: from edge to edge, cut to its
 * height. The height follows the width of the place alone (a third of it, 120 to 180 px; `slim` a sixth, 72 to 88 px),
 * so the server's page already holds the room and nothing moves when the picture comes. While it loads, and when it
 * fails, a quiet tint fills the room. Without a picture the cover is not there at all.
 */
export const Cover = (props: CoverProps) => {
  const picture = createPicture(() => props.src);
  return (
    <Show when={props.src}>
      {/* with words the cover is one picture named by them; as decoration it is hidden and has no role */}
      <Show
        when={props.alt}
        fallback={
          <div
            class="k2-cover"
            data-k2-part="Cover"
            data-slim={props.slim ? "" : undefined}
            data-image={picture.state() ?? ""}
            aria-hidden="true"
          >
            <picture.Picture />
          </div>
        }
      >
        {(alt) => (
          <div
            class="k2-cover"
            data-k2-part="Cover"
            data-slim={props.slim ? "" : undefined}
            data-image={picture.state() ?? ""}
            role="img"
            aria-label={alt()}
          >
            <picture.Picture />
          </div>
        )}
      </Show>
    </Show>
  );
};

export type SparkProps = {
  /** The values in their order, oldest first; the last one (today, this hour) stands in full colour. */
  values: readonly number[];
  /**
   * What the bars say, in one sentence a person who cannot see them gets the same from: the thing, the direction and
   * the numbers that matter, such as "Werkstatt: in 7 Tagen von 12 auf 41 Änderungen gestiegen". Not only the title
   * of the data ("Änderungen der letzten 7 Tage"): a rise, a fall and a flat line would then say the same.
   */
  label: string;
  /**
   * The value that fills the height. Sparks side by side that people compare share one `max`, so the same value has the
   * same height in each; a value above it stands at the top. Without it a spark scales to its own highest value.
   */
  max?: number;
};

/**
 * A few small bars of a short history, such as changes per day: in the colour of the thing it stands beside (its
 * mark's colour), else of the app. 20 px high; only for a trend people glance at, never instead of a number.
 */
export const Spark = (props: SparkProps) => {
  const top = () => props.max ?? Math.max(...props.values, 0);
  return (
    <span class="k2-spark" data-k2-part="Spark" role="img" aria-label={props.label}>
      <For each={props.values}>
        {(value) => (
          <i style={custom({ "--k2-v": `${top() > 0 ? Math.max(8, Math.round((Math.min(value, top()) / top()) * 100)) : 8}%` })} />
        )}
      </For>
    </span>
  );
};

export type ChipProps = {
  children: JSX.Element;
  /** A symbol before the word. */
  icon?: string;
} & (
  | {
      /**
       * A plain chip you can press, such as "1 linked" or "+ Tag": then it is a control with a frame (rule 8).
       */
      onClick?: () => void;
      href?: string;
      /** With `href`: opens the page in place on a plain click (see `OnNavigate`). */
      onNavigate?: OnNavigate;
      /** A pressable chip that is on, such as an active filter: in the tint of the app. */
      pressed?: boolean;
      remove?: never;
    }
  | {
      /**
       * A remove button after the words, named for what it removes ("Anna Berg entfernen"), for a chip that stands
       * for something that can be taken away, such as a person or a filter. A chip that is pressed itself has none
       * (no button in a button). After a press the focus goes to the next chip's remove button, else the one before.
       */
      remove: { name: string; onClick: () => void };
      onClick?: never;
      href?: never;
      onNavigate?: never;
      pressed?: never;
    }
) &
  (
    | {
        /** A state with a dot and a word: ok, waiting or wrong. */
        status: Status;
        /**
         * The state as its dot and its word only, without the tinted round: for a column of states in a dense table or
         * list, where a chip on every line is too loud. The colour stays on the dot; the word, in the ink of the text,
         * carries the meaning.
         */
        quiet?: boolean;
        yours?: never;
        tag?: never;
        amount?: never;
        ai?: never;
      }
    | {
        status?: never;
        quiet?: never;
        /** "You are next" in the blue of selection; with `dot` a state that is being worked on ("in Arbeit"). */
        yours: true;
        dot?: boolean;
        tag?: never;
        amount?: never;
        ai?: never;
      }
    | {
        status?: never;
        quiet?: never;
        yours?: never;
        /** A tag in its data colour. */
        tag: true;
        color?: string;
        amount?: never;
        ai?: never;
      }
    | {
        status?: never;
        quiet?: never;
        yours?: never;
        tag?: never;
        /** An amount of money that goes out (we pay) or comes in. */
        amount: "out" | "in";
        ai?: never;
      }
    | { status?: never; quiet?: never; yours?: never; tag?: never; amount?: never /** Something Gustav proposes, in plum. */; ai: true }
    | { status?: never; quiet?: never; yours?: never; tag?: never; amount?: never; ai?: never }
  );

/** A round mark that shows a state, a tag, an amount or a count. Never a colour without a word. */
export const Chip = (props: ChipProps) => {
  const t = useControlMessages();
  const pressable = () => props.href !== undefined || props.onClick !== undefined;
  const kind = () =>
    props.yours
      ? "yours"
      : props.tag
        ? "tag"
        : props.amount
          ? "amount"
          : props.ai
            ? "ai"
            : props.status
              ? undefined
              : pressable()
                ? "control"
                : "plain";
  return (
    <Dynamic
      component={linkOr(props.href, props.onClick ? "button" : "span")}
      href={props.href}
      onNavigate={props.href !== undefined ? props.onNavigate : undefined}
      type={props.onClick && props.href === undefined ? "button" : undefined}
      onClick={() => props.onClick?.()}
      class="k2-chip"
      data-k2-part="Chip"
      data-status={props.status}
      data-quiet={props.status && "quiet" in props && props.quiet ? "" : undefined}
      data-kind={kind()}
      aria-pressed={props.onClick && props.pressed !== undefined ? (props.pressed ? "true" : "false") : undefined}
      data-pressed={props.pressed ? "" : undefined}
      style={custom({ "--k2-c": "color" in props ? props.color : undefined })}
    >
      <Show when={props.status}>{(status) => <span class="k2-dot" data-status={status()} />}</Show>
      <Show when={"dot" in props && props.dot}>
        <span class="k2-dot" data-status="app" />
      </Show>
      <Show when={props.amount}>{(amount) => <Icon name={amount() === "out" ? "arrow-up-right" : "arrow-down-left"} />}</Show>
      <Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>
      {props.children}
      <Show when={props.remove}>
        {(remove) => (
          <button
            type="button"
            class="k2-chip-x"
            aria-label={t().removeValue({ label: remove().name })}
            title={t().removeValue({ label: remove().name })}
            onClick={(event) => {
              // the focus goes on to the next remove button of the chips around, else the one before, once this one left
              const own = event.currentTarget;
              const all = [
                ...(own.closest(".k2-chip")?.parentElement?.querySelectorAll<HTMLElement>(":scope > .k2-chip > .k2-chip-x") ?? []),
              ];
              const at = all.indexOf(own);
              const next = all[at + 1] ?? all[at - 1];
              remove().onClick();
              queueMicrotask(() => {
                if (!own.isConnected && next?.isConnected) next.focus();
              });
            }}
          >
            <Icon name="x" />
          </button>
        )}
      </Show>
    </Dynamic>
  );
};

/** A small round dot of a state (internal: a row marks "unread" with it, the sidebar "new"). */
export const Dot = (props: { status?: Status | "app"; label?: string }) => (
  <span class="k2-dot" data-status={props.status} role="img" aria-label={props.label} aria-hidden={props.label ? undefined : "true"} />
);

/** The state of one time slot of `Ticks`: it went well, it failed, or there is no data for it. */
export type TickState = "ok" | "bad" | "none";

export type TicksProps = {
  /**
   * One state per time slot, oldest first, such as one per minute of the last 30 minutes. They read in the writing
   * direction: the oldest at the start (on the right in a page written right to left). In a table cell at most 60
   * slots: the cell's 140 px hold no more, and a strip with more is cut at its end.
   */
  slots: readonly TickState[];
  /**
   * What the ticks say, in one sentence a person who cannot see them gets the same from, always in the same form:
   * what, over which time, then what happened, such as "postgres-haupt, letzte 30 Minuten: 3 von 30 Abrufen
   * fehlgeschlagen".
   */
  label: string;
  /** The data colour of what the ticks belong to; without it the colour of the app. Failures stay red. */
  color?: string;
  /**
   * The ticks take the room between the text edges of their place, such as a detail: 2 px apart, each slot up to 12 px
   * wide, the strip at the start where the place is wider; without it 140 px, the width of a table cell.
   */
  stretch?: boolean;
};

/**
 * One tick per time slot, such as the scrapes of the last 30 minutes: ok in the soft colour of what it belongs to, a
 * failure red and taller, a slot without data a low stub. 20 px high; the one column of a list that shows its data
 * over time.
 */
export const Ticks = (props: TicksProps) => (
  <span
    class="k2-ticks"
    data-k2-part="Ticks"
    data-stretch={props.stretch ? "" : undefined}
    role="img"
    aria-label={props.label}
    style={custom({ "--k2-c": props.color })}
  >
    <For each={props.slots}>{(state) => <i data-s={state} />}</For>
  </span>
);

export type ProgressProps = {
  value: number;
  of: number;
  /** The words next to the bar, such as "Arbeitstag 5 von 22". */
  label?: string;
  /**
   * A bar near or at its limit says so in colour too: `warn` (almost full), `bad` (full, over). The words that say
   * why stand beside it (a chip, a hint); never a colour alone.
   */
  status?: "warn" | "bad";
};

/** A thin bar with its value. */
export const Progress = (props: ProgressProps) => {
  const share = () => (props.of > 0 ? Math.max(0, Math.min(1, props.value / props.of)) : 0);
  return (
    <span
      class="k2-progress"
      data-k2-part="Progress"
      data-status={props.status}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={props.of}
      aria-valuenow={props.value}
      aria-label={props.label}
    >
      <span class="k2-progress-track" style={custom({ "--k2-p": `${Math.round(share() * 1000) / 10}%` })}>
        <i />
      </span>
      <Show when={props.label}>
        <span>{props.label}</span>
      </Show>
    </span>
  );
};

export type RangeBarProps = {
  /** The one scale the bars of a list share, such as the week's lowest low and highest high. */
  domain: readonly [number, number];
  /**
   * Colours along the scale by meaning, such as cold to warm: each holds at its value and runs over into the next. A
   * colour is a hex colour, an `oklch()`, a custom property of the page or `light-dark()` of two of them, which the
   * owner keeps at 3:1 on the surface in both themes; a stop that is no colour is dropped. Without stops the bar is
   * neutral.
   */
  stops?: readonly { at: number; color: string }[];
} & (
  | {
      /** Where the range starts and ends, such as a day's low and high; the order does not matter. */
      from: number;
      to: number;
      ranges?: undefined;
    }
  | {
      /**
       * Several ranges in one row, such as a day's opening hours with a break (8 to 12 and 14 to 18), in any order; an
       * empty list leaves the track empty (a day that is closed).
       */
      ranges: readonly { from: number; to: number }[];
      from?: undefined;
      to?: undefined;
    }
) &
  (
    | {
        /**
         * The range in words, such as "2,9° bis 9,1°", with every range of the row ("Mo.: 08:00 bis 12:00 und 14:00
         * bis 18:00"): what assistive technology reads instead of the bar.
         */
        label: string;
        decorative?: false;
      }
    | {
        /** The range's words stand beside the bar (its low and high as text): the bar is then decoration. */
        decorative: true;
        label?: string;
      }
  );

/**
 * A range on a shared scale: a bar from `from` to `to` on a quiet track, so the rows of a list read at a glance (the
 * week's days by their low and high). `ranges` puts several on one track, such as opening hours with a break. It reads
 * in the writing direction, as `Ticks` do: the scale's start stands at the line's start. With `stops` each bar shows
 * the colours of its part of the scale. A range outside the scale stops at its ends; a range that is no number is
 * left out, and without one the track stays empty.
 */
export const RangeBar = (props: RangeBarProps) => {
  const scale = () => Number.isFinite(props.domain[0]) && Number.isFinite(props.domain[1]) && props.domain[1] > props.domain[0];
  const clamp = (value: number) => Math.max(props.domain[0], Math.min(props.domain[1], value));
  const share = (value: number) => (value - props.domain[0]) / (props.domain[1] - props.domain[0]);
  const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
  // the visible part of each range: its ends held to the scale, so the colours match what is drawn
  const drawn = () =>
    scale()
      ? (props.ranges === undefined ? [{ from: props.from, to: props.to }] : props.ranges).flatMap((range) =>
          Number.isFinite(range.from) && Number.isFinite(range.to)
            ? [{ low: clamp(Math.min(range.from, range.to)), high: clamp(Math.max(range.from, range.to)) }]
            : [],
        )
      : [];
  // the stops in the order of the scale, once for every bar; a stop that is no colour is dropped
  const stops = () =>
    (props.stops ?? [])
      .flatMap((stop) => {
        const color = safeColor(stop.color);
        return color === undefined || !Number.isFinite(stop.at) ? [] : [{ at: stop.at, color }];
      })
      .sort((first, second) => first.at - second.at);
  // the stops at their place on one bar: a stop outside it still sets the colour at its ends
  const fill = (low: number, high: number) => {
    const sorted = stops();
    if (sorted.length === 0) return undefined;
    if (sorted.length === 1) return sorted[0]!.color;
    const width = Math.max(Number.EPSILON, high - low);
    const colors = sorted.map((stop) => `${stop.color} ${percent((stop.at - low) / width)}`).join(", ");
    return `linear-gradient(var(--k2-range-way, to right), ${colors})`;
  };
  return (
    <span
      class="k2-range"
      data-k2-part="RangeBar"
      role="img"
      aria-label={props.decorative ? undefined : props.label}
      aria-hidden={props.decorative ? "true" : undefined}
    >
      <For each={drawn()}>
        {(range) => (
          <i
            style={custom({
              "--k2-range-start": percent(share(range.low)),
              "--k2-range-end": percent(1 - share(range.high)),
              "--k2-range-fill": fill(range.low, range.high),
            })}
          />
        )}
      </For>
    </span>
  );
};
