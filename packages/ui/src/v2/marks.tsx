import { type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
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

export type AvatarProps = Person;

/**
 * A person as initials on a colour. The place sets the size: 24 px by default, 32 px leading a row of two or three
 * lines and in a record head (soft there), 20 px among the marks of a row and in a button.
 */
export const Avatar = (props: AvatarProps) => (
  <span class="k2-av" data-k2-part="Avatar" data-k2-avatar="" role="img" aria-label={props.name} style={custom({ "--k2-c": props.color })}>
    {initialsOf(props)}
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
