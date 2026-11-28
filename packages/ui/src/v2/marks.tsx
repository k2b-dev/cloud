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
 * size: 20 px in the sidebar and in a sentence, 24 px leading a row or a table's cell, and 32 px there when the list
 * shows pictures of its things (a mark with `image` or `kind`, as files and media are; folders beside them take the
 * same 32). A row that leads with a mark is 44 px; on the phone 56 with a mark of 40. 36 px on a tile.
 */
export const Mark = (props: MarkProps) => {
  const picture = createPicture(() => props.image);
  return (
    <span
      class="k2-mk"
      data-k2-part="Mark"
      data-image={props.image ? (picture.state() ?? "") : undefined}
      data-preview={props.image || props.kind ? "" : undefined}
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
      {/* the words in a box of their own, so a chip longer than its line ends them with "…" */}
      <span class="k2-chip-text">{props.children}</span>
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
