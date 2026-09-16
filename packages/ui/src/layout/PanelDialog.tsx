import { createContext, createEffect, createSignal, createUniqueId, type JSX, Show, useContext } from "solid-js";
import { Button } from "../actions/Button";
import { Tabs } from "../actions/Tabs";
import type { OpenDialogOptions } from "../feedback/dialog-core";
import { prompts } from "../feedback/prompts";
import { resolveUiMessages, useUiMessages } from "../intl/messages";

export type PanelDialogSurface = "contained" | "floating";

export type PanelDialogProps = {
  children: JSX.Element;
  surface?: PanelDialogSurface;
};

export type PanelDialogHeaderProps = {
  title: JSX.Element;
  subtitle?: JSX.Element;
  icon?: string;
  actions?: JSX.Element;
  close?: () => void;
  closeDisabled?: boolean;
  closeLabel?: string;
};

export type PanelDialogBodyProps = {
  children: JSX.Element;
  scrollPreserveKey?: string;
};

export type PanelDialogFooterProps = {
  children: JSX.Element;
};

export type PanelDialogSectionProps = {
  title: JSX.Element;
  subtitle?: JSX.Element;
  icon?: string;
  actions?: JSX.Element;
  children: JSX.Element;
} & (
  | { hideable?: false; open?: never; defaultOpen?: never; onOpenChange?: never; disabled?: never }
  | { hideable: true; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean }
);

export type PanelDialogTabOption<T extends string = string> = {
  value: T;
  label: JSX.Element;
  icon?: string;
  disabled?: boolean;
};

export type PanelDialogTabsProps<T extends string = string> = {
  options: readonly PanelDialogTabOption<T>[];
  value: T | (() => T);
  onValueChange: (value: T) => void;
  ariaLabel?: string;
  label?: string;
};

type PanelDialogComponent = ((props: PanelDialogProps) => JSX.Element) & {
  Header: (props: PanelDialogHeaderProps) => JSX.Element;
  Body: (props: PanelDialogBodyProps) => JSX.Element;
  Footer: (props: PanelDialogFooterProps) => JSX.Element;
  Section: (props: PanelDialogSectionProps) => JSX.Element;
  Tabs: <T extends string>(props: PanelDialogTabsProps<T>) => JSX.Element;
};

const PanelDialogSurfaceContext = createContext<PanelDialogSurface>("contained");
const usePanelDialogSurface = () => useContext(PanelDialogSurfaceContext);

const panelDialogBasePanelClass = "k2b-dialog k2b-panel-dialog-frame";

export const panelDialogPanelClass = `${panelDialogBasePanelClass} is-standard`;
export const panelDialogOptions = {
  panelClassName: panelDialogPanelClass,
  contentClassName: "k2b-panel-dialog-viewport",
} satisfies OpenDialogOptions;

export const panelDialogWidePanelClass = `${panelDialogBasePanelClass} is-wide`;
export const panelDialogWideOptions = {
  panelClassName: panelDialogWidePanelClass,
  contentClassName: "k2b-panel-dialog-viewport",
} satisfies OpenDialogOptions;

export const panelDialogFixedPanelClass = `${panelDialogBasePanelClass} is-fixed`;
export const panelDialogFixedOptions = {
  panelClassName: panelDialogFixedPanelClass,
  contentClassName: "k2b-panel-dialog-viewport is-fixed",
} satisfies OpenDialogOptions;

export const panelDialogWorkspacePanelClass = `${panelDialogBasePanelClass} is-workspace`;
export const panelDialogWorkspaceOptions = {
  panelClassName: panelDialogWorkspacePanelClass,
  contentClassName: "k2b-panel-dialog-viewport is-workspace",
} satisfies OpenDialogOptions;

export const confirmDiscardIfDirty = async (dirty: boolean | (() => boolean)): Promise<boolean> => {
  const hasChanges = typeof dirty === "function" ? dirty() : dirty;
  if (!hasChanges) return true;
  return Boolean(
    await prompts.confirm(resolveUiMessages().discardUnsavedChanges, {
      title: resolveUiMessages().unsavedChangesTitle,
      variant: "danger",
      confirmText: resolveUiMessages().discard,
    }),
  );
};

const PanelDialogHeader = (props: PanelDialogHeaderProps): JSX.Element => {
  const messages = useUiMessages();
  return (
    <header class="k2b-panel-dialog__header" data-surface={usePanelDialogSurface()} data-has-subtitle={Boolean(props.subtitle)}>
      <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
      <div class="k2b-panel-dialog__heading">
        <h2>{props.title}</h2>
        <Show when={props.subtitle}>
          <p>{props.subtitle}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="k2b-panel-dialog__actions">{props.actions}</div>
      </Show>
      <Show when={props.close}>
        <button
          type="button"
          class="k2b-dialog__close"
          aria-label={props.closeLabel ?? messages().closeDialog}
          disabled={props.closeDisabled}
          onClick={props.close}
        >
          <i class="ti ti-x" aria-hidden="true" />
        </button>
      </Show>
    </header>
  );
};

const PanelDialogBody = (props: PanelDialogBodyProps): JSX.Element => (
  <div class="k2b-panel-dialog__body" data-scroll-preserve={props.scrollPreserveKey} data-surface={usePanelDialogSurface()}>
    {props.children}
  </div>
);

const PanelDialogFooter = (props: PanelDialogFooterProps): JSX.Element => (
  <footer class="k2b-panel-dialog__footer" data-surface={usePanelDialogSurface()}>
    {props.children}
  </footer>
);

const PanelDialogSection = (props: PanelDialogSectionProps): JSX.Element => {
  const id = `k2b-panel-dialog-section-${createUniqueId()}`;
  const [internalOpen, setInternalOpen] = createSignal(props.defaultOpen ?? false);
  const open = () => !props.hideable || (props.open ?? internalOpen());
  let section: HTMLElement | undefined;
  let expand: HTMLButtonElement | undefined;
  let collapse: HTMLButtonElement | undefined;
  const toggle = (next: boolean) => {
    if (props.disabled) return;
    if (props.open === undefined) setInternalOpen(next);
    props.onOpenChange?.(next);
  };
  createEffect(() => {
    if (!props.hideable) return;
    const expanded = open();
    queueMicrotask(() => {
      if (expanded !== open()) return;
      const active = section?.ownerDocument.activeElement;
      if (expanded && active === expand) collapse?.focus();
      if (!expanded && active && active !== expand && section?.contains(active)) expand?.focus();
    });
  });

  return (
    <section
      ref={section}
      class="k2b-panel-dialog__section"
      data-surface={usePanelDialogSurface()}
      data-hideable={props.hideable || undefined}
      data-open={props.hideable ? open() : undefined}
      aria-labelledby={open() ? id : `${id}-closed`}
    >
      <Show when={props.hideable}>
        <div hidden={open()}>
          <Button
            ref={expand}
            variant="ghost"
            class="k2b-panel-dialog__section-summary"
            disabled={props.disabled}
            aria-expanded={false}
            aria-controls={`${id}-body`}
            onClick={() => toggle(true)}
          >
            <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
            <span class="k2b-panel-dialog__section-copy">
              <span id={`${id}-closed`} class="k2b-panel-dialog__section-title">
                {props.title}
              </span>
              <Show when={props.subtitle}>
                <span class="k2b-panel-dialog__section-subtitle">{props.subtitle}</span>
              </Show>
            </span>
            <i class="ti ti-eye" aria-hidden="true" />
          </Button>
        </div>
      </Show>
      <header hidden={!open()}>
        <Show when={props.icon}>
          {(icon) => (
            <span class="k2b-panel-dialog__section-icon">
              <i class={icon()} aria-hidden="true" />
            </span>
          )}
        </Show>
        <div>
          <h3 id={id}>{props.title}</h3>
          <Show when={props.subtitle}>
            <p>{props.subtitle}</p>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="k2b-panel-dialog__actions">{props.actions}</div>
        </Show>
        <Show when={props.hideable}>
          <Button
            ref={collapse}
            variant="ghost"
            size="sm"
            disabled={props.disabled}
            aria-labelledby={id}
            aria-expanded={true}
            aria-controls={`${id}-body`}
            onClick={() => toggle(false)}
          >
            <i class="ti ti-eye-off" aria-hidden="true" />
          </Button>
        </Show>
      </header>
      <div id={`${id}-body`} class="k2b-panel-dialog__section-body" hidden={!open()}>
        {props.children}
      </div>
    </section>
  );
};

const PanelDialogTabs = <T extends string>(props: PanelDialogTabsProps<T>): JSX.Element => {
  const messages = useUiMessages();
  return (
    <Tabs
      class="k2b-panel-dialog__tabs"
      value={props.value}
      onValueChange={props.onValueChange}
      ariaLabel={props.ariaLabel ?? props.label ?? messages().dialogTabs}
      options={props.options}
    />
  );
};

const PanelDialog = ((props: PanelDialogProps): JSX.Element => {
  const surface = props.surface ?? "contained";
  return (
    <PanelDialogSurfaceContext.Provider value={surface}>
      <div class="k2b-panel-dialog" data-surface={surface}>
        {props.children}
      </div>
    </PanelDialogSurfaceContext.Provider>
  );
}) as PanelDialogComponent;

PanelDialog.Header = PanelDialogHeader;
PanelDialog.Body = PanelDialogBody;
PanelDialog.Footer = PanelDialogFooter;
PanelDialog.Section = PanelDialogSection;
PanelDialog.Tabs = PanelDialogTabs;

export default PanelDialog;
