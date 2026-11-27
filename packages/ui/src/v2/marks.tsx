import { createSignal, For, type JSX, children as resolveChildren, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { personColor } from "../surfaces/person-color";
import { useControlMessages } from "./control-messages";
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
export const Avatar = (props: AvatarProps) => {
  // What became of which picture: shown (the initials under it then leave, as a picture may be transparent) or
  // failed. It belongs to its address, so a new picture (one just changed) is tried afresh.
  const [outcome, setOutcome] = createSignal<{ src: string; state: "shown" | "failed" }>();
  const picture = () => {
    const seen = outcome();
    return seen && seen.src === props.image ? seen.state : undefined;
  };
  const settle = (image: HTMLImageElement, state: "shown" | "failed") => setOutcome({ src: image.getAttribute("src") ?? "", state });
  // A picture the browser had before the page came alive fired its events before anyone listened: `decode` answers
  // for it either way (also for a drawing without a size of its own, whose natural width may be 0).
  const settled = (image: HTMLImageElement) => {
    const src = image.getAttribute("src") ?? "";
    image.decode().then(
      () => setOutcome({ src, state: "shown" }),
      () => setOutcome({ src, state: "failed" }),
    );
  };
  return (
    <span
      class="k2-av"
      data-k2-part="Avatar"
      data-k2-avatar=""
      data-image={props.image ? (picture() ?? "") : undefined}
      role="img"
      aria-label={props.name}
      aria-hidden={props.decorative ? "true" : undefined}
      // Every person has a colour: given, or the fixed one of their name, the same as everywhere in Cloud.
      style={custom({ "--k2-c": props.color ?? personColor(props.name) })}
    >
      {initialsOf(props)}
      {/* the avatar itself carries the name; the picture adds none (a failed one then draws nothing over the initials) */}
      <Show when={picture() !== "failed" && props.image}>
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
  const t = useControlMessages();
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
