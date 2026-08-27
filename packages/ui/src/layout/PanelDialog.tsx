import { createContext, type JSX, Show, useContext } from "solid-js";
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
};

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
    <header class="k2b-panel-dialog__header" data-surface={usePanelDialogSurface()}>
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

const PanelDialogSection = (props: PanelDialogSectionProps): JSX.Element => (
  <section class="k2b-panel-dialog__section" data-surface={usePanelDialogSurface()}>
    <header>
      <Show when={props.icon}>
        {(icon) => (
          <span class="k2b-panel-dialog__section-icon">
            <i class={icon()} aria-hidden="true" />
          </span>
        )}
      </Show>
      <div>
        <h3>{props.title}</h3>
        <Show when={props.subtitle}>
          <p>{props.subtitle}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="k2b-panel-dialog__actions">{props.actions}</div>
      </Show>
    </header>
    <div class="k2b-panel-dialog__section-body">{props.children}</div>
  </section>
);

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
