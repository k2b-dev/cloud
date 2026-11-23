import { type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { Avatar, Icon } from "./marks";
import type { Action, Person } from "./types";

type ButtonBase = {
  /**
   * The weight of the action: `primary` filled blue (one per page), `secondary` framed (default), `ghost` without a
   * frame, `text` a quiet text button in a head or at the end of a row. The height comes from the place.
   */
  variant?: "primary" | "secondary" | "ghost" | "text";
  /** A Tabler icon name before the label. */
  icon?: string;
  /** A person instead of an icon, such as the one a thread is assigned to. */
  avatar?: Person;
  /** A link that looks like a button. */
  href?: string;
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
  /** The button opens a menu: a chevron after the label. */
  menu?: boolean;
  /** The button leads further, to a page with more: a chevron to the right after the label. */
  forward?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  /** Stays in a head on the phone, where the other actions move into the menu. */
  keep?: boolean;
};

export type ButtonProps = ButtonBase &
  (
    | { children: JSX.Element; label?: string }
    | {
        children?: undefined;
        /** An icon button needs a name (rule 5: wrong fails at once). */
        label: string;
      }
  );

/** The one button: round, one height per place, a link through `href`. An icon button must have a label. */
export const Button = (props: ButtonProps) => {
  const iconOnly = () => props.children === undefined;
  return (
    <Dynamic
      component={props.href ? "a" : "button"}
      href={props.disabled ? undefined : props.href}
      type={props.href ? undefined : (props.type ?? "button")}
      disabled={props.href ? undefined : props.disabled}
      aria-disabled={props.href && props.disabled ? "true" : undefined}
      aria-label={iconOnly() ? props.label : undefined}
      title={iconOnly() ? props.label : undefined}
      aria-haspopup={props.menu ? "menu" : undefined}
      onClick={props.onClick}
      class="k2-btn"
      data-k2-part="Button"
      data-variant={props.variant && props.variant !== "secondary" ? props.variant : undefined}
      data-icon-only={iconOnly() ? "" : undefined}
      data-menu={props.menu ? "" : undefined}
      data-keep={props.keep ? "" : undefined}
    >
      <>
        <Show when={props.avatar} fallback={<Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>}>
          {(person) => <Avatar {...person()} />}
        </Show>
        <Show when={!iconOnly()}>
          <span class="k2-btn-label">{props.children}</span>
        </Show>
        <Show when={props.menu}>
          <Icon name="chevron-down" />
        </Show>
        <Show when={props.forward}>
          <Icon name="chevron-right" />
        </Show>
      </>
    </Dynamic>
  );
};

/** An action as data turned into a button of the given weight; without an icon it always shows its label. */
export const ActionButton = (props: { action: Action; variant?: ButtonProps["variant"]; iconOnly?: boolean }) => (
  <Show
    when={props.iconOnly && props.action.icon}
    fallback={
      <Button
        variant={props.variant}
        icon={props.action.icon}
        forward={props.action.forward}
        href={props.action.href}
        onClick={() => props.action.onClick?.()}
      >
        {props.action.label}
      </Button>
    }
  >
    {(icon) => (
      <Button
        variant={props.variant}
        icon={icon()}
        label={props.action.label}
        href={props.action.href}
        onClick={() => props.action.onClick?.()}
      />
    )}
  </Show>
);

/** The copy button beside a value (internal to Facts). */
export const CopyButton = (props: { label: string; value: string }) => {
  const t = useUiMessages();
  return (
    <Button
      variant="ghost"
      icon="copy"
      label={`${t().copy}: ${props.label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(props.value);
      }}
    />
  );
};
