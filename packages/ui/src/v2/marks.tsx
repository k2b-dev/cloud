import { children as resolveChildren, createSignal, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { personColor } from "../surfaces/person-color";
import { linkOr } from "./link";
import { initialsOf, type OnNavigate, type Person, type Status } from "./types";

/** Inline custom properties are the primitive's own business: data colours and measured widths, never layout. */
export const custom = (values: Record<string, string | undefined>): JSX.CSSProperties | undefined => {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

// ── Marks ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type IconProps = {
  /** A Tabler icon name without the `ti-` prefix, such as `package`. */
  name: string;
  /** A name for assistive technology; without one the icon is decoration. */
  label?: string;
  tone?: Status | "ai" | "app" | "muted" | "subtle";
};

/** A Tabler icon. Its size comes from its place: 16 px in rows and bars, 20 px on a tile, 14 px among marks. */
export const Icon = (props: IconProps) => (
  <i
    class={`ti ti-${props.name} k2-icon`}
    data-k2-part="Icon"
    data-name={props.name}
    data-tone={props.tone}
    role="img"
    aria-label={props.label}
    aria-hidden={props.label ? undefined : "true"}
  />
);

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

export const Avatar = (props: AvatarProps) => {
  // Shown, the initials under the picture leave, as a picture may be transparent.
  const picture = createPicture(() => props.image);
  return (
    <span
      class="k2-av"
      data-k2-part="Avatar"
      data-k2-avatar=""
      data-image={props.image ? (picture.state() ?? "") : undefined}
      role="img"
      aria-label={props.name}
      aria-hidden={props.decorative ? "true" : undefined}
      // Every person has a colour: given, or the fixed one of their name, the same as everywhere in Cloud.
      style={custom({ "--k2-c": props.color ?? personColor(props.name) })}
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
Avatar.Stack = (props: AvatarStackProps) => {
  const shown = () => props.people.slice(0, Math.max(1, props.max ?? 3));
  const rest = () => props.people.length - shown().length;
  return (
    <span
      class="k2-avs"
      data-k2-part="Avatar.Stack"
      role="img"
      aria-label={props.label ?? props.people.map((person) => person.name).join(", ")}
    >
      <For each={shown()}>{(person) => <Avatar {...person} decorative />}</For>
      <Show when={rest() > 0}>
        <span class="k2-avs-rest" aria-hidden="true">
          +{rest()}
        </span>
      </Show>
    </span>
  );
};

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

export type SparkProps = {
  /** The values in their order, oldest first; the last one (today, this hour) stands in full colour. */
  values: readonly number[];
  /** What the bars show, such as "Änderungen der letzten 7 Tage". It names the drawing; the values are not read out. */
  label: string;
};

/**
 * A few small bars of a short history, such as changes per day: in the colour of the thing it stands beside (its
 * mark's colour), else of the app. 20 px high; only for a trend people glance at, never instead of a number.
 */
export const Spark = (props: SparkProps) => {
  const top = () => Math.max(...props.values, 0);
  return (
    <span class="k2-spark" data-k2-part="Spark" role="img" aria-label={props.label}>
      <For each={props.values}>
        {(value) => <i style={custom({ "--k2-v": `${top() > 0 ? Math.max(8, Math.round((value / top()) * 100)) : 8}%` })} />}
      </For>
    </span>
  );
};

export type ChipProps = {
  children: JSX.Element;
  /** A symbol before the word. */
  icon?: string;
  /**
   * A plain chip you can press, such as "1 linked" or "+ Tag": then it is a control with a frame (rule 8).
   */
  onClick?: () => void;
  href?: string;
  /** With `href`: opens the page in place on a plain click (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  /** A pressable chip that is on, such as an active filter: in the tint of the app. */
  pressed?: boolean;
} & (
  | {
      /** A state with a dot and a word: ok, waiting or wrong. */
      status: Status;
      yours?: never;
      tag?: never;
      amount?: never;
      ai?: never;
    }
  | {
      status?: never;
      /** "You are next" in the blue of selection; with `dot` a state that is being worked on ("in Arbeit"). */
      yours: true;
      dot?: boolean;
      tag?: never;
      amount?: never;
      ai?: never;
    }
  | {
      status?: never;
      yours?: never;
      /** A tag in its data colour. */
      tag: true;
      color?: string;
      amount?: never;
      ai?: never;
    }
  | {
      status?: never;
      yours?: never;
      tag?: never;
      /** An amount of money that goes out (we pay) or comes in. */
      amount: "out" | "in";
      ai?: never;
    }
  | { status?: never; yours?: never; tag?: never; amount?: never /** Something Gustav proposes, in plum. */; ai: true }
  | { status?: never; yours?: never; tag?: never; amount?: never; ai?: never }
);

/** A round mark that shows a state, a tag, an amount or a count. Never a colour without a word. */
export const Chip = (props: ChipProps) => {
  const pressable = () => props.href !== undefined || props.onClick !== undefined;
  // made once and read from here: reading `children` again would make its JSX again
  const words = resolveChildren(() => props.children);
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
      {/* the words are cut with "…" where the chip has no room; a tag (words someone typed, of any length) says all of
          them on hover */}
      <span class="k2-chip-text" title={props.tag && typeof words() === "string" ? String(words()) : undefined}>
        {words()}
      </span>
    </Dynamic>
  );
};

/** A small round dot of a state (internal: a row marks "unread" with it, the sidebar "new"). */
export const Dot = (props: { status?: Status | "app"; label?: string }) => (
  <span class="k2-dot" data-status={props.status} role="img" aria-label={props.label} aria-hidden={props.label ? undefined : "true"} />
);

export type ProgressProps = {
  value: number;
  of: number;
  /** The words next to the bar, such as "Arbeitstag 5 von 22". */
  label?: string;
};

/** A thin bar with its value. */
export const Progress = (props: ProgressProps) => {
  const share = () => (props.of > 0 ? Math.max(0, Math.min(1, props.value / props.of)) : 0);
  return (
    <span
      class="k2-progress"
      data-k2-part="Progress"
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
