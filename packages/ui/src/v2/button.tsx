import { type JSX, children as resolveChildren, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { linkOr } from "./link";
import { Avatar, Icon } from "./marks";
import type { Action, OnNavigate, Person } from "./types";

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
  /** With `href`: opens the page in place on a plain click (see `OnNavigate`); a disabled link never calls it. */
  onNavigate?: OnNavigate;
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
  /** The button opens a menu: a chevron after the label. */
  menu?: boolean;
  /** The button leads further, to a page with more: a chevron to the right after the label. */
  forward?: boolean;
  disabled?: boolean;
  /**
   * The deed of the button is under way, such as a save that waits for the server: a turning sign over the label, the
   * width kept, pressed no second time. Its name stays; assistive technology hears it as unavailable for now, and the
   * app says what came of the deed (a toast, a notice, the next page).
   */
  busy?: boolean;
  type?: "button" | "submit";
  /** Stays in a head on the phone, where the other actions move into the menu. */
  keep?: boolean;
  /**
   * A hint under the pointer, for a button whose words give way to its symbol in a narrow place (the bar of a
   * selection). An icon button shows its label as the hint by itself.
   */
  title?: string;
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
  // the label is made once and read from here (reading `children` again would make its JSX again)
  const label = resolveChildren(() => props.children);
  const iconOnly = () => label() === undefined;
  // A busy button takes no second press, as a disabled one, but keeps its look under the turning sign and keeps the
  // focus a press gave it (a native `disabled` would drop it): it says "disabled" and refuses the click, which also
  // stops a form being sent twice.
  const off = () => props.disabled || props.busy;
  return (
    // a disabled link is an anchor without an address: it leads nowhere and takes no `onNavigate`
    <Dynamic
      component={off() && props.href !== undefined ? "a" : linkOr(props.href, "button")}
      href={off() ? undefined : props.href}
      onNavigate={off() || props.href === undefined ? undefined : props.onNavigate}
      type={props.href ? undefined : (props.type ?? "button")}
      disabled={props.href ? undefined : props.disabled}
      aria-disabled={(props.href && props.disabled) || props.busy ? "true" : undefined}
      aria-busy={props.busy ? "true" : undefined}
      aria-label={iconOnly() ? props.label : undefined}
      title={iconOnly() ? props.label : props.title}
      aria-haspopup={props.menu ? "menu" : undefined}
      onClick={(event: MouseEvent & { currentTarget: HTMLElement; target: Element }) => {
        if (off()) event.preventDefault();
        else props.onClick?.(event);
      }}
      class="k2-btn"
      data-k2-part="Button"
      data-busy={props.busy ? "" : undefined}
      data-variant={props.variant && props.variant !== "secondary" ? props.variant : undefined}
      data-icon-only={iconOnly() ? "" : undefined}
      data-menu={props.menu ? "" : undefined}
      data-keep={props.keep ? "" : undefined}
    >
      <>
        <Show when={props.avatar} fallback={<Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>}>
          {(person) => <Avatar {...person()} decorative />}
        </Show>
        <Show when={!iconOnly()}>
          <span class="k2-btn-label">{label()}</span>
        </Show>
        <Show when={props.menu}>
          <Icon name="chevron-down" />
        </Show>
        <Show when={props.forward}>
          <Icon name="chevron-right" />
        </Show>
        {/* the sign turns over the label, which keeps its place (and the button its width) unseen */}
        <Show when={props.busy}>
          <span class="k2-btn-busy" aria-hidden="true">
            <Icon name="loader-2" />
          </span>
        </Show>
      </>
    </Dynamic>
  );
};

/** An action as data turned into a button of the given weight; without an icon it always shows its label. */
export const ActionButton = (props: { action: Action; variant?: ButtonProps["variant"]; iconOnly?: boolean; titled?: boolean }) => (
  <Show
    when={props.iconOnly && props.action.icon}
    fallback={
      <Button
        variant={props.variant}
        icon={props.action.icon}
        forward={props.action.forward}
        title={props.titled ? props.action.label : undefined}
        href={props.action.href}
        onNavigate={props.action.onNavigate}
        onClick={() => props.action.onClick?.()}
        disabled={props.action.disabled}
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
        onNavigate={props.action.onNavigate}
        onClick={() => props.action.onClick?.()}
        disabled={props.action.disabled}
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
