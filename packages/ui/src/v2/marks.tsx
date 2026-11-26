import { createSignal, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { personColor } from "../surfaces/person-color";
import { colorStyle, safeColor, safeValue } from "./colors";
import { linkOr } from "./link";
import { initialOf, initialsOf, type OnNavigate, type Person, type Status } from "./types";

/** Inline custom properties are the primitive's own business: data colours and measured widths, never layout. */
export const custom = (values: Record<string, string | undefined>): JSX.CSSProperties | undefined => {
  const entries = Object.entries(values).flatMap(([key, value]): [string, string][] => {
    if (value === undefined) return [];
    // a data colour is validated and brings its readable foregrounds; anything else is the primitive's own number
    if (key === "--k2-c") return Object.entries(colorStyle(value) ?? {});
    return safeValue(value) ? [[key, value]] : [];
  });
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
 * one picture with one name; the avatars in it are decoration. 20 px everywhere, each over the one before by 2 px.
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
  // everyone shows: the stack needs no room for a count while its faces fit (the stylesheet works out its width)
  const all = () => props.people.length <= shown().length;
  return (
    <span
      class="k2-avs"
      data-k2-part="Avatar.Stack"
      data-k={String(shown().length)}
      data-all={all() ? "" : undefined}
      role="img"
      aria-label={props.label ?? props.people.map((person) => person.name).join(", ")}
      style={custom({ "--k2-avs-n": String(shown().length), "--k2-avs-rest": all() ? "0" : "1" })}
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

export type MarkProps = (
  | {
      /** A Tabler icon for the kind of thing, such as `table`, `folder-filled` or `tool`. */
      icon: string;
      initial?: undefined;
    }
  | {
      icon?: undefined;
      /**
       * The name of a thing that has no symbol of its own, such as a space without an icon: its first letter stands
       * on its colour in the symbol's place and size ("Werkstatt": "W").
       */
      initial: string;
    }
) & {
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
 * size: 20 px in the sidebar and in a sentence, 32 px leading a row or a table's cell (a row of one line is then 44 px;
 * on the phone 40 px in a row of 56),
 * 36 px on a tile.
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
      <Show
        when={props.icon}
        fallback={
          // a glyph like an avatar's initials: it has no type role of the text around it
          <span class="k2-icon k2-mk-initial" data-k2-glyph="">
            {initialOf(props.initial ?? "")}
          </span>
        }
      >
        {(name) => <Icon name={name()} />}
      </Show>
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

export type PreviewProps = {
  /** What the picture shows, for assistive technology, such as "Vorschau von Ansicht Front Eiche.jpg". */
  label: string;
  /** The thing's symbol, which stands while the picture loads, when it fails, and for a thing without a picture. */
  icon: string;
  /** The data colour of the thing or of its kind, as on its `Mark`. */
  color?: string;
  /** The address of the picture: a photo, the first page of a PDF, a frame of a video. */
  image?: string;
  /** The type on the corner, such as `PDF`, or the length of a video, such as `2:14`. */
  kind?: string;
};

/**
 * A large picture of the open thing at the top of its detail: 4:3 from text edge to text edge, round like the thing's
 * mark. Without a picture, or while it loads or fails, the thing's symbol stands large on the
 * tint of its colour in the same place, so nothing moves. It stands where the detail's text starts; it is never a
 * box inside a box.
 */
export const Preview = (props: PreviewProps) => {
  const picture = createPicture(() => props.image);
  return (
    <div
      class="k2-mk k2-preview"
      data-k2-part="Preview"
      data-image={props.image ? (picture.state() ?? "") : undefined}
      role="img"
      aria-label={props.label}
      style={custom({ "--k2-c": props.color })}
    >
      <Icon name={props.icon} />
      <picture.Picture />
      <Show when={props.kind}>
        <span class="k2-mk-kind" data-k2-glyph="">
          {props.kind}
        </span>
      </Show>
    </div>
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

/** One fetch or check: it worked, it failed, or there was none. */
export type TickState = "ok" | "bad" | "none";

export type TicksProps = {
  /** The fetches or checks in their order, oldest first, such as the last 30 minutes of a source. */
  values: readonly TickState[];
  /** What they say, in one sentence, such as "30 Abrufe, 3 fehlgeschlagen seit 10:40". */
  label: string;
  /** Where they stand: `row`, small in a table cell or a row (the default); `hero`, across the drawing of a `Hero`. */
  place?: "row" | "hero";
};

/**
 * The shape of a list's data over time in one column (identity B): a tick per fetch or check in the soft colour of the
 * app the thing belongs to, a failed one red and taller, none a quiet stub. Only one such picture per row.
 */
export const Ticks = (props: TicksProps) => (
  <span class="k2-ticks" data-k2-part="Ticks" data-place={props.place === "hero" ? "hero" : undefined} role="img" aria-label={props.label}>
    <For each={props.values}>{(state) => <i data-state={state} />}</For>
  </span>
);

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
      {props.children}
    </Dynamic>
  );
};

/** A small round dot of a state (internal: a row marks "unread" with it, the sidebar "new"). */
export type DotProps = {
  /** The state it shows; without one a neutral dot (what rests). `app`: in the colour of the app. */
  status?: Status | "app";
  /** A name for assistive technology; without one the dot is decoration beside its word. */
  label?: string;
};

export const Dot = (props: DotProps) => (
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
