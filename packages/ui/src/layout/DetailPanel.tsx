import { createEffect, createSignal, createUniqueId, type JSX, Show, splitProps } from "solid-js";
import { Button, ButtonLink, type ButtonLinkProps, type ButtonProps } from "../actions/Button";
import { Dropdown, type DropdownItem } from "../actions/Dropdown";

export type DetailPanelProps = {
  children: JSX.Element;
  class?: string;
};

type DetailPanelHeaderBaseProps = {
  title: JSX.Element;
  subtitle?: JSX.Element;
  meta?: JSX.Element;
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
  class?: string;
};

export type DetailPanelTone = "accent" | "neutral" | "success" | "warning" | "danger";

type DetailPanelSectionBaseProps = {
  title: JSX.Element;
  icon?: string;
  tone?: DetailPanelTone;
  description?: JSX.Element;
  meta?: JSX.Element;
  class?: string;
};

type DetailPanelActionBaseProps = {
  title: JSX.Element;
  description?: JSX.Element;
  leading?: JSX.Element;
  trailing?: JSX.Element;
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

export type DetailPanelSectionProps = DetailPanelSectionBaseProps &
  (
    | {
        children?: JSX.Element;
        actions?: JSX.Element;
        collapsible?: false;
        defaultOpen?: never;
        open?: never;
        onOpenChange?: never;
        disabled?: never;
      }
    | {
        children: JSX.Element;
        actions?: never;
        collapsible: true;
        defaultOpen?: boolean;
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        disabled?: boolean;
      }
  );

type DetailPanelComponent = ((props: DetailPanelProps) => JSX.Element) & {
  Header: (props: DetailPanelHeaderProps) => JSX.Element;
  Body: (props: DetailPanelBodyProps) => JSX.Element;
  Summary: (props: DetailPanelSummaryProps) => JSX.Element;
  Group: (props: DetailPanelGroupProps) => JSX.Element;
  Section: (props: DetailPanelSectionProps) => JSX.Element;
  Action: (props: DetailPanelActionProps) => JSX.Element;
};

const classNames = (base: string, extra?: string): string => (extra ? `${base} ${extra}` : base);

const DetailPanelHeader = (props: DetailPanelHeaderProps): JSX.Element => (
  <header class={classNames("k2b-detail-panel__header", props.class)}>
    <div class="k2b-detail-panel__header-main">
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
        <h2>{props.title}</h2>
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
      <Show when={props.actions}>
        <div class="k2b-detail-panel__actions">{props.actions}</div>
      </Show>
    </div>
    <Show when={props.primaryActions}>
      <div class="k2b-detail-panel__primary-actions">{props.primaryActions}</div>
    </Show>
  </header>
);

const DetailPanelBody = (props: DetailPanelBodyProps): JSX.Element => (
  <div class={classNames("k2b-detail-panel__body", props.class)} data-scroll-preserve={props.scrollPreserveKey}>
    {props.children}
  </div>
);

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

const DetailPanelGroup = (props: DetailPanelGroupProps): JSX.Element => (
  <div class={classNames("k2b-detail-panel__group", props.class)} role="group" aria-label={props.label}>
    {props.children}
  </div>
);

const DetailPanelSectionIcon = (props: Pick<DetailPanelSectionBaseProps, "icon" | "tone">): JSX.Element => (
  <Show when={props.icon}>
    {(icon) => (
      <span class="k2b-detail-panel__section-icon" data-tone={props.tone ?? "neutral"} aria-hidden="true">
        <i class={icon()} />
      </span>
    )}
  </Show>
);

const DetailPanelActionContent = (props: DetailPanelActionBaseProps): JSX.Element => (
  <>
    <Show when={props.leading}>
      <span class="k2b-detail-panel__action-leading">{props.leading}</span>
    </Show>
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
  const [local, rest] = splitProps(props, ["class", "description", "href", "leading", "menuItems", "menuLabel", "title", "trailing"]);
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
        variant="ghost"
        size="sm"
      >
        {content()}
      </ButtonLink>
    </Show>
  );

  return (
    <Show when={local.menuItems?.length} fallback={action()}>
      <div class="k2b-detail-panel__action-row">
        {action()}
        <Dropdown.Root items={local.menuItems ?? []} align="end" label={local.menuLabel} class="k2b-detail-panel__action-menu">
          <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={local.menuLabel} class="k2b-detail-panel__action-menu-trigger">
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </div>
    </Show>
  );
};

const DetailPanelSection = (props: DetailPanelSectionProps): JSX.Element => {
  const headingId = `k2b-detail-panel-section-${createUniqueId()}`;
  const bodyId = `${headingId}-body`;
  const [internalOpen, setInternalOpen] = createSignal(props.defaultOpen ?? false);
  const open = () => props.open ?? internalOpen();
  let expand: HTMLButtonElement | undefined;
  let collapse: HTMLButtonElement | undefined;
  let body: HTMLDivElement | undefined;
  const toggle = (next: boolean) => {
    if (props.disabled) return;
    if (props.open === undefined) setInternalOpen(next);
    props.onOpenChange?.(next);
  };
  createEffect(() => {
    const expanded = open();
    // Restore focus only when its current control becomes hidden, including
    // a parent-controlled collapse while focus is inside an editor.
    queueMicrotask(() => {
      if (expanded !== open()) return;
      const active = expand?.ownerDocument.activeElement;
      if (expanded && active === expand) collapse?.focus();
      if (!expanded && (active === collapse || (active && body?.contains(active)))) expand?.focus();
    });
  });
  const className = () => classNames("k2b-detail-panel__section", props.class);

  return (
    <Show
      when={props.collapsible}
      fallback={
        <section class={className()} aria-labelledby={headingId}>
          <header class="k2b-detail-panel__section-header">
            <DetailPanelSectionIcon icon={props.icon} tone={props.tone} />
            <div class="k2b-detail-panel__section-copy">
              <h3 id={headingId}>{props.title}</h3>
              <Show when={props.description}>
                <p>{props.description}</p>
              </Show>
            </div>
            <Show when={props.meta}>
              <div class="k2b-detail-panel__section-meta">{props.meta}</div>
            </Show>
            <Show when={props.actions}>
              <div class="k2b-detail-panel__section-actions">{props.actions}</div>
            </Show>
          </header>
          <Show when={props.children !== undefined}>
            <div class="k2b-detail-panel__section-body">{props.children}</div>
          </Show>
        </section>
      }
    >
      <section class={className()} aria-labelledby={open() ? headingId : `${headingId}-closed`} data-open={open()}>
        <div hidden={open()}>
          <Button
            ref={expand}
            variant="ghost"
            class="k2b-detail-panel__section-summary"
            disabled={props.disabled}
            aria-expanded={false}
            aria-controls={bodyId}
            onClick={() => toggle(true)}
          >
            <DetailPanelSectionIcon icon={props.icon} tone={props.tone} />
            <span class="k2b-detail-panel__section-copy">
              <span id={`${headingId}-closed`} class="k2b-detail-panel__section-title">
                {props.title}
              </span>
              <Show when={props.description}>
                <span class="k2b-detail-panel__section-description">{props.description}</span>
              </Show>
            </span>
            <Show when={props.meta}>
              <span class="k2b-detail-panel__section-meta">{props.meta}</span>
            </Show>
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Button>
        </div>
        <div hidden={!open()}>
          <header class="k2b-detail-panel__section-header">
            <DetailPanelSectionIcon icon={props.icon} tone={props.tone} />
            <div class="k2b-detail-panel__section-copy">
              <h3 id={headingId}>{props.title}</h3>
              <Show when={props.description}>
                <p>{props.description}</p>
              </Show>
            </div>
            <Show when={props.meta}>
              <div class="k2b-detail-panel__section-meta">{props.meta}</div>
            </Show>
            <Button
              ref={collapse}
              variant="ghost"
              size="sm"
              disabled={props.disabled}
              aria-labelledby={headingId}
              aria-expanded={true}
              aria-controls={bodyId}
              onClick={() => toggle(false)}
            >
              <i class="ti ti-chevron-up" aria-hidden="true" />
            </Button>
          </header>
        </div>
        <div ref={body} id={bodyId} hidden={!open()} class="k2b-detail-panel__section-body">
          {props.children}
        </div>
      </section>
    </Show>
  );
};

const DetailPanel = ((props: DetailPanelProps): JSX.Element => (
  <div class={classNames("k2b-detail-panel", props.class)}>{props.children}</div>
)) as DetailPanelComponent;

DetailPanel.Header = DetailPanelHeader;
DetailPanel.Body = DetailPanelBody;
DetailPanel.Summary = DetailPanelSummary;
DetailPanel.Group = DetailPanelGroup;
DetailPanel.Section = DetailPanelSection;
DetailPanel.Action = DetailPanelAction;

export default DetailPanel;
