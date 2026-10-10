import { Link, type LinkNavigateEvent, type NavigationScrollMode } from "@k2b/ssr/nav";
import { type JSX, Show, splitProps } from "solid-js";
import { isServer } from "solid-js/web";
import { Tooltip, type TooltipPlacement, useLabelTooltip } from "../feedback/Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "text" | "subtle" | "input" | "warning" | "danger" | "success" | "ai";
export type ButtonSize = "xs" | "sm" | "md" | "lg";
export type ButtonAlign = "center" | "start";

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Allow a deliberately long or rich label to wrap. Defaults to false. */
  wrap?: boolean;
  /** Start-align the content and let the label fill the button, for full-width rows. Defaults to `"center"`. */
  align?: ButtonAlign;
  loading?: boolean;
  loadingLabel?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  tooltip?: JSX.Element | false;
  tooltipDelay?: number;
  tooltipPlacement?: TooltipPlacement;
};

export type ButtonLinkProps = Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "onClick"> & {
  /** Allow a deliberately long or rich label to wrap. Defaults to false. */
  wrap?: boolean;
  /** Start-align the content and let the label fill the button, for full-width rows. Defaults to `"center"`. */
  align?: ButtonAlign;
  navigation?: "document" | "enhanced";
  onClick?: JSX.EventHandlerUnion<HTMLAnchorElement, MouseEvent>;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  replace?: boolean;
  scroll?: NavigationScrollMode;
  size?: ButtonSize;
  variant?: ButtonVariant;
  tooltip?: JSX.Element | false;
  tooltipDelay?: number;
  tooltipPlacement?: TooltipPlacement;
};

const buttonClass = (className?: string): string => ["k2b-button", className].filter(Boolean).join(" ");

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "aria-label",
    "aria-labelledby",
    "children",
    "class",
    "disabled",
    "loading",
    "loadingLabel",
    "ref",
    "size",
    "tooltip",
    "tooltipDelay",
    "tooltipPlacement",
    "type",
    "variant",
    "wrap",
    "align",
  ]);
  let target: HTMLButtonElement | undefined;
  const setRef = (element: HTMLButtonElement) => {
    target = element;
    if (typeof local.ref === "function") local.ref(element);
  };
  // While busy, a loading label names the button, over any name the caller
  // gave it, because the idle content it would describe is not visible.
  const busyName = () => (local.loading && local.loadingLabel) || undefined;

  const control = (
    <button
      {...rest}
      aria-label={busyName() ?? local["aria-label"]}
      aria-labelledby={busyName() ? undefined : local["aria-labelledby"]}
      ref={setRef}
      type={local.type ?? "button"}
      class={buttonClass(local.class)}
      data-size={local.size ?? "md"}
      data-variant={local.variant ?? "primary"}
      data-wrap={local.wrap || undefined}
      data-align={local.align === "start" ? "start" : undefined}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading ? "true" : undefined}
    >
      {/* The idle content keeps its place, invisibly, so the button keeps its
          size; the spinner is drawn over it. */}
      <span class="k2b-button__label">{local.children}</span>
      <Show when={local.loading}>
        <span class="k2b-button__busy" aria-hidden="true">
          <i class="ti ti-loader-2 k2b-spin" />
        </span>
      </Show>
    </button>
  );

  return (
    <>
      {control}
      <Show when={local.tooltip !== false && local.tooltip !== undefined}>
        <Tooltip
          content={local.tooltip as JSX.Element}
          target={() => target}
          delay={local.tooltipDelay}
          disabled={local.disabled || local.loading}
          placement={local.tooltipPlacement}
        />
      </Show>
    </>
  );
}

export function ButtonLink(props: ButtonLinkProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "children",
    "class",
    "href",
    "navigation",
    "onClick",
    "onNavigate",
    "replace",
    "ref",
    "scroll",
    "size",
    "tooltip",
    "tooltipDelay",
    "tooltipPlacement",
    "variant",
    "wrap",
    "align",
  ]);
  let target: HTMLAnchorElement | undefined;
  const setRef = (element: HTMLAnchorElement) => {
    target = element;
    if (typeof local.ref === "function") local.ref(element);
  };
  const className = buttonClass(local.class);
  const content = <span class="k2b-button__label">{local.children}</span>;

  const tooltip = () => (
    <Show when={local.tooltip !== false && local.tooltip !== undefined}>
      <Tooltip content={local.tooltip as JSX.Element} target={() => target} delay={local.tooltipDelay} placement={local.tooltipPlacement} />
    </Show>
  );

  if (local.navigation === "enhanced" && local.href && local.onNavigate) {
    return (
      <>
        <Link
          {...rest}
          ref={setRef}
          href={local.href}
          class={className}
          data-size={local.size ?? "md"}
          data-variant={local.variant ?? "primary"}
          data-wrap={local.wrap || undefined}
          data-align={local.align === "start" ? "start" : undefined}
          onClick={local.onClick}
          onNavigate={local.onNavigate}
          replace={local.replace}
          scroll={local.scroll}
        >
          {content}
        </Link>
        {tooltip()}
      </>
    );
  }

  return (
    <>
      <a
        {...rest}
        ref={setRef}
        href={local.href}
        class={className}
        data-size={local.size ?? "md"}
        data-variant={local.variant ?? "primary"}
        data-wrap={local.wrap || undefined}
        data-align={local.align === "start" ? "start" : undefined}
        onClick={local.onClick}
      >
        {content}
      </a>
      {tooltip()}
    </>
  );
}

export type IconButtonProps = Omit<ButtonProps, "children"> & {
  children: JSX.Element;
  label: string;
};

export type IconButtonLinkProps = Omit<ButtonLinkProps, "children"> & {
  children: JSX.Element;
  label: string;
};

/**
 * The native title is only the server-rendered, no-JavaScript hint; the
 * hydrated tooltip removes it. Without a tooltip, an explicit title stays.
 */
export const iconTitle = (title: string | undefined, tooltip: JSX.Element | false | undefined): string | undefined =>
  tooltip === false || tooltip === undefined ? title : isServer && typeof tooltip === "string" ? tooltip : undefined;

export function IconButton(props: IconButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["children", "class", "label", "title", "tooltip", "variant"]);
  const tooltip = useLabelTooltip(
    () => local.tooltip,
    () => local.title ?? local.label,
  );

  return (
    <Button
      {...rest}
      variant={local.variant ?? "ghost"}
      class={`k2b-icon-button ${local.class ?? ""}`}
      aria-label={local.label}
      title={iconTitle(local.title, tooltip())}
      tooltip={tooltip()}
    >
      {local.children}
    </Button>
  );
}

export function IconButtonLink(props: IconButtonLinkProps): JSX.Element {
  const [local, rest] = splitProps(props, ["children", "class", "label", "title", "tooltip", "variant"]);
  const tooltip = useLabelTooltip(
    () => local.tooltip,
    () => local.title ?? local.label,
  );

  return (
    <ButtonLink
      {...rest}
      variant={local.variant ?? "ghost"}
      class={`k2b-icon-button ${local.class ?? ""}`}
      aria-label={local.label}
      title={iconTitle(local.title, tooltip())}
      tooltip={tooltip()}
    >
      {local.children}
    </ButtonLink>
  );
}
