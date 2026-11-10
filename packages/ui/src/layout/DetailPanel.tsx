import { createUniqueId, type JSX, Show, splitProps } from "solid-js";
import { Button, ButtonLink, type ButtonLinkProps, type ButtonProps, IconButton } from "../actions/Button";
import { Dropdown, type DropdownItem } from "../actions/Dropdown";
import { Checkbox } from "../inputs/Checkbox";
import { SectionFrameDefault } from "../surfaces/Section";
import { useDetailPanelMessages } from "./detail-panel-messages";
import { createScrollFade } from "./scroll-fade";

export type DetailPanelProps = {
  /** Plain sections share their host surface, as in AppWorkspace.Detail. */
  surface?: "default" | "plain";
  children: JSX.Element;
  class?: string;
};

type DetailPanelHeaderBaseProps = {
  /** A short line above the title that names what is shown, such as "Conversation", followed by its state. */
  kind?: JSX.Element;
  title: JSX.Element;
  subtitle?: JSX.Element;
  meta?: JSX.Element;
  /**
   * The resource's "…" menu, shown before `actions`. Pass every less frequent command on the shown resource here,
   * so each panel opens its menu from the same place; an empty list shows no button.
   */
  menu?: readonly DropdownItem[];
  /** Accessible name of the "…" button. Defaults to "More actions". */
  menuLabel?: string;
  actions?: JSX.Element;
  primaryActions?: JSX.Element;
  class?: string;
};

export type DetailPanelHeaderProps = DetailPanelHeaderBaseProps &
  (
    | {
        leading?: JSX.Element;
        icon?: never;
      }
    | {
        leading?: never;
        icon?: string;
      }
  );

export type DetailPanelBodyProps = {
  scrollFade?: boolean;
  children: JSX.Element;
  scrollPreserveKey?: string;
  class?: string;
};

export type DetailPanelSummaryProps = {
  title: JSX.Element;
  children: JSX.Element;
  actions?: JSX.Element;
  class?: string;
};

export type DetailPanelGroupProps = {
  children: JSX.Element;
  label?: string;
  /**
   * A visible quiet title, such as "More about this conversation". Its sections then stand flush as rows below
   * it, which suits collapsed secondary sections with a `summary`.
   */
  title?: JSX.Element;
  class?: string;
};

/** One direct secondary command, rendered as a sibling icon button at the end of the row. */
export type DetailPanelActionSecondary = {
  /** Icon class, for example `ti ti-trash`. */
  icon: string;
  /** Accessible name and tooltip of the icon button. */
  label: string;
  onClick: () => void;
  variant?: "danger";
};

/**
 * A checkbox before the row that toggles on its own, such as "done" for a task the row opens. It always shows its
 * state, unlike a secondary action, which waits for hover.
 */
export type DetailPanelActionCheckbox = {
  checked: boolean;
  /** Accessible name, after the row, such as "Done: Call Mrs. Weber". */
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

type DetailPanelActionBaseProps = {
  title: JSX.Element;
  description?: JSX.Element;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  secondaryAction?: DetailPanelActionSecondary;
  checkbox?: DetailPanelActionCheckbox;
  /** Marks the row of the current place, such as the section in view, in the panel's accent. */
  current?: boolean;
  /** Lets the title wrap to two lines instead of ending with an ellipsis. */
  wrap?: boolean;
  class?: string;
};

type DetailPanelActionMenuProps =
  | {
      menuItems?: never;
      menuLabel?: never;
    }
  | {
      menuItems: readonly DropdownItem[];
      menuLabel: string;
    };

export type DetailPanelActionLinkProps = DetailPanelActionBaseProps &
  DetailPanelActionMenuProps &
  Omit<ButtonLinkProps, "children" | "class" | "size" | "title" | "variant"> & {
    href: string;
  };

export type DetailPanelActionButtonProps = DetailPanelActionBaseProps &
  DetailPanelActionMenuProps &
  Omit<ButtonProps, "children" | "class" | "size" | "title" | "variant"> & {
    href?: never;
  };

export type DetailPanelActionProps = DetailPanelActionLinkProps | DetailPanelActionButtonProps;

/** A row that only shows something, such as a person and their role: the columns of an action, without a command. */
export type DetailPanelRowProps = {
  title: JSX.Element;
  description?: JSX.Element;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  class?: string;
};

type DetailPanelComponent = ((props: DetailPanelProps) => JSX.Element) & {
  Header: (props: DetailPanelHeaderProps) => JSX.Element;
  Body: (props: DetailPanelBodyProps) => JSX.Element;
  Summary: (props: DetailPanelSummaryProps) => JSX.Element;
  Group: (props: DetailPanelGroupProps) => JSX.Element;
  Action: (props: DetailPanelActionProps) => JSX.Element;
  Row: (props: DetailPanelRowProps) => JSX.Element;
};

const classNames = (base: string, extra?: string): string => (extra ? `${base} ${extra}` : base);

const showTruncatedTitle = (event: PointerEvent & { currentTarget: HTMLHeadingElement }) => {
  const heading = event.currentTarget;
  if (heading.scrollHeight > heading.clientHeight + 1) heading.title = heading.textContent ?? "";
  else heading.removeAttribute("title");
};

const DetailPanelHeader = (props: DetailPanelHeaderProps): JSX.Element => {
  const t = useDetailPanelMessages();
  const menuLabel = () => props.menuLabel ?? t().moreActions;
  const menuTrigger = () => (
    <Dropdown.Root items={props.menu ?? []} align="end" label={menuLabel()} phone="sheet">
      <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={menuLabel()} tooltip={menuLabel()}>
        <i class="ti ti-dots" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
  // With primary actions, "…" ends their row, next to the commands it extends; otherwise it sits beside close.
  const menuInActions = () => Boolean(props.menu?.length) && !props.primaryActions;
  return (
    <header class={classNames("k2b-detail-panel__header", props.class)}>
      <div class="k2b-detail-panel__header-main" data-identity={props.icon || props.leading ? "true" : undefined}>
        <Show when={props.icon}>
          {(icon) => (
            <span class="k2b-detail-panel__header-icon" aria-hidden="true">
              <i class={icon()} />
            </span>
          )}
        </Show>
        <Show when={props.leading}>
          <div class="k2b-detail-panel__header-leading">{props.leading}</div>
        </Show>
        <div class="k2b-detail-panel__heading">
          <Show when={props.kind}>
            <div class="k2b-detail-panel__kind">{props.kind}</div>
          </Show>
          {/* A long title wraps to two lines and ends with an ellipsis; then the native hint shows all of it. */}
          <h2 onPointerEnter={showTruncatedTitle}>{props.title}</h2>
          <Show when={props.subtitle || props.meta}>
            <div class="k2b-detail-panel__supporting">
              <Show when={props.subtitle}>
                <p>{props.subtitle}</p>
              </Show>
              <Show when={props.meta}>
                <div class="k2b-detail-panel__meta">{props.meta}</div>
              </Show>
            </div>
          </Show>
        </div>
        <Show when={menuInActions() || props.actions}>
          <div class="k2b-detail-panel__actions">
            <Show when={menuInActions()}>{menuTrigger()}</Show>
            {props.actions}
          </div>
        </Show>
      </div>
      <Show when={props.primaryActions}>
        <div class="k2b-detail-panel__primary-actions">
          {props.primaryActions}
          <Show when={props.menu?.length}>{menuTrigger()}</Show>
        </div>
      </Show>
    </header>
  );
};

const DetailPanelBody = (props: DetailPanelBodyProps): JSX.Element => {
  let body!: HTMLDivElement;
  createScrollFade(
    () => body,
    () => props.scrollFade !== false,
  );
  return (
    <div
      ref={body}
      class={classNames("k2b-detail-panel__body", props.class)}
      data-scroll-fade-mode={props.scrollFade !== false ? "both" : undefined}
      data-scroll-preserve={props.scrollPreserveKey}
    >
      {props.children}
    </div>
  );
};

const DetailPanelSummary = (props: DetailPanelSummaryProps): JSX.Element => {
  const headingId = `k2b-detail-panel-summary-${createUniqueId()}`;

  return (
    <section class={classNames("k2b-detail-panel__summary", props.class)} aria-labelledby={headingId}>
      <header class="k2b-detail-panel__summary-header">
        <h3 id={headingId}>{props.title}</h3>
        <Show when={props.actions}>
          <div class="k2b-detail-panel__summary-actions">{props.actions}</div>
        </Show>
      </header>
      <div class="k2b-detail-panel__summary-body">{props.children}</div>
    </section>
  );
};

const DetailPanelGroup = (props: DetailPanelGroupProps): JSX.Element => {
  const titleId = `k2b-detail-panel-group-${createUniqueId()}`;
  return (
    <div
      class={classNames("k2b-detail-panel__group", props.class)}
      role="group"
      aria-label={props.title ? undefined : props.label}
      aria-labelledby={props.title ? titleId : undefined}
      data-titled={props.title ? "true" : undefined}
    >
      <Show when={props.title}>
        <div class="k2b-detail-panel__group-title" id={titleId}>
          {props.title}
        </div>
      </Show>
      {props.children}
    </div>
  );
};

const DetailPanelActionContent = (props: DetailPanelActionBaseProps): JSX.Element => (
  <>
    {/* Hidden while empty: a row's icon, or its text when it has none, starts on the section's text edge. */}
    <span class="k2b-detail-panel__action-leading">{props.leading}</span>
    <span class="k2b-detail-panel__action-copy">
      <span class="k2b-detail-panel__action-title">{props.title}</span>
      <Show when={props.description}>
        <span class="k2b-detail-panel__action-description">{props.description}</span>
      </Show>
    </span>
    <Show when={props.trailing}>
      <span class="k2b-detail-panel__action-trailing">{props.trailing}</span>
    </Show>
  </>
);

const DetailPanelAction = (props: DetailPanelActionProps): JSX.Element => {
  const [local, rest] = splitProps(props, [
    "class",
    "current",
    "description",
    "href",
    "leading",
    "menuItems",
    "menuLabel",
    "secondaryAction",
    "checkbox",
    "title",
    "trailing",
    "wrap",
  ]);
  const className = classNames("k2b-detail-panel__action", local.class);
  const content = () => (
    <DetailPanelActionContent title={local.title} description={local.description} leading={local.leading} trailing={local.trailing} />
  );

  const action = () => (
    <Show
      when={local.href !== undefined}
      fallback={
        <Button
          {...(rest as Omit<DetailPanelActionButtonProps, keyof DetailPanelActionBaseProps>)}
          class={className}
          aria-current={local.current ? "true" : undefined}
          data-current={local.current ? "true" : undefined}
          data-wrap={local.wrap ? "true" : undefined}
          variant="ghost"
          size="sm"
        >
          {content()}
        </Button>
      }
    >
      <ButtonLink
        {...(rest as Omit<DetailPanelActionLinkProps, keyof DetailPanelActionBaseProps | "href">)}
        href={local.href as string}
        class={className}
        aria-current={local.current ? "location" : undefined}
        data-current={local.current ? "true" : undefined}
        data-wrap={local.wrap ? "true" : undefined}
        variant="ghost"
        size="sm"
      >
        {content()}
      </ButtonLink>
    </Show>
  );

  return (
    <Show when={local.secondaryAction || local.menuItems?.length || local.checkbox} fallback={action()}>
      <div class="k2b-detail-panel__action-row" data-checkbox={local.checkbox ? "true" : undefined}>
        <Show when={local.checkbox}>
          {(checkbox) => (
            <Checkbox
              class="k2b-detail-panel__action-check"
              aria-label={checkbox().label}
              value={checkbox().checked}
              disabled={checkbox().disabled}
              onValueChange={(checked) => checkbox().onChange(checked)}
            />
          )}
        </Show>
        {action()}
        <Show when={local.secondaryAction}>
          {(secondary) => (
            <IconButton
              size="sm"
              variant="ghost"
              label={secondary().label}
              class="k2b-detail-panel__action-secondary"
              data-tone={secondary().variant}
              onClick={() => secondary().onClick()}
            >
              <i class={secondary().icon} aria-hidden="true" />
            </IconButton>
          )}
        </Show>
        <Show when={local.menuItems?.length}>
          <Dropdown.Root items={local.menuItems ?? []} align="end" label={local.menuLabel} class="k2b-detail-panel__action-menu">
            <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={local.menuLabel} class="k2b-detail-panel__action-menu-trigger">
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </Show>
      </div>
    </Show>
  );
};

const DetailPanelRow = (props: DetailPanelRowProps): JSX.Element => (
  <div class={classNames("k2b-detail-panel__row", props.class)}>
    <DetailPanelActionContent title={props.title} description={props.description} leading={props.leading} trailing={props.trailing} />
  </div>
);

/**
 * The panel for one selected object. Its topics are `Section`s; the panel frames them itself, so they stand flat
 * inside it.
 */
const DetailPanel = ((props: DetailPanelProps): JSX.Element => (
  <div class={classNames("k2b-detail-panel", props.class)} data-surface={props.surface}>
    <SectionFrameDefault.Provider value="none">{props.children}</SectionFrameDefault.Provider>
  </div>
)) as DetailPanelComponent;

DetailPanel.Header = DetailPanelHeader;
DetailPanel.Body = DetailPanelBody;
DetailPanel.Summary = DetailPanelSummary;
DetailPanel.Group = DetailPanelGroup;
DetailPanel.Action = DetailPanelAction;
DetailPanel.Row = DetailPanelRow;

export default DetailPanel;
