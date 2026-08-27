import { children, createMemo, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { assertUniqueStableUiIds } from "./stable-id";

const SETTINGS_MODAL_TAB = Symbol("SettingsModal.Tab");
const SETTINGS_MODAL_GROUP = Symbol("SettingsModal.Group");
const SETTINGS_MODAL_FOOTER = Symbol("SettingsModal.Footer");

export type SettingsModalTabTone = "default" | "danger";

export type SettingsModalTabProps = {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  tone?: SettingsModalTabTone;
  children: JSX.Element;
};

export type SettingsModalGroupProps = {
  title: string;
  children: JSX.Element;
};

export type SettingsModalFooterProps = {
  children: JSX.Element;
};

type SettingsModalTabDefinition = {
  readonly kind: typeof SETTINGS_MODAL_TAB;
  readonly props: SettingsModalTabProps;
};

type SettingsModalGroupDefinition = {
  readonly kind: typeof SETTINGS_MODAL_GROUP;
  readonly props: SettingsModalGroupProps;
};

type SettingsModalFooterDefinition = {
  readonly kind: typeof SETTINGS_MODAL_FOOTER;
  readonly props: SettingsModalFooterProps;
};

export type SettingsModalProps = {
  /** Accessible name for the settings surface. */
  title: string;
  /** @deprecated Retained for source compatibility; tab descriptions carry the visible context. */
  subtitle?: string;
  /** @deprecated Retained for source compatibility; tab icons identify the rail entries. */
  icon?: string;
  defaultTab?: string;
  activeTab?: string;
  onTabChange?: (id: string) => void;
  onClose?: () => void;
  closeLabel?: string;
  class?: string;
  children: JSX.Element;
};

type SettingsModalComponent = ((props: SettingsModalProps) => JSX.Element) & {
  Tab: (props: SettingsModalTabProps) => JSX.Element;
  Group: (props: SettingsModalGroupProps) => JSX.Element;
  Footer: (props: SettingsModalFooterProps) => JSX.Element;
};

const isTabDefinition = (value: unknown): value is SettingsModalTabDefinition =>
  !!value && typeof value === "object" && (value as { kind?: unknown }).kind === SETTINGS_MODAL_TAB;

const isGroupDefinition = (value: unknown): value is SettingsModalGroupDefinition =>
  !!value && typeof value === "object" && (value as { kind?: unknown }).kind === SETTINGS_MODAL_GROUP;

const isFooterDefinition = (value: unknown): value is SettingsModalFooterDefinition =>
  !!value && typeof value === "object" && (value as { kind?: unknown }).kind === SETTINGS_MODAL_FOOTER;

const collectTabs = (value: unknown): SettingsModalTabDefinition[] => {
  if (Array.isArray(value)) return value.flatMap(collectTabs);
  if (isGroupDefinition(value)) return collectTabs(value.props.children);
  return isTabDefinition(value) ? [value] : [];
};

const collectRailEntries = (value: unknown): (SettingsModalGroupDefinition | SettingsModalTabDefinition)[] => {
  if (Array.isArray(value)) return value.flatMap(collectRailEntries);
  if (isGroupDefinition(value) || isTabDefinition(value)) return [value];
  return [];
};

const splitPanelChildren = (value: unknown): { content: JSX.Element[]; footer?: SettingsModalFooterDefinition } => {
  if (Array.isArray(value)) {
    return value.reduce<{ content: JSX.Element[]; footer?: SettingsModalFooterDefinition }>(
      (result, entry) => {
        const next = splitPanelChildren(entry);
        result.content.push(...next.content);
        if (next.footer) result.footer = next.footer;
        return result;
      },
      { content: [] },
    );
  }
  return isFooterDefinition(value) ? { content: [], footer: value } : { content: [value as JSX.Element] };
};

function SettingsModalTab(props: SettingsModalTabProps): JSX.Element {
  return { kind: SETTINGS_MODAL_TAB, props } satisfies SettingsModalTabDefinition as unknown as JSX.Element;
}

function SettingsModalGroup(props: SettingsModalGroupProps): JSX.Element {
  return { kind: SETTINGS_MODAL_GROUP, props } satisfies SettingsModalGroupDefinition as unknown as JSX.Element;
}

function SettingsModalFooter(props: SettingsModalFooterProps): JSX.Element {
  return { kind: SETTINGS_MODAL_FOOTER, props } satisfies SettingsModalFooterDefinition as unknown as JSX.Element;
}

const SettingsModal = ((props: SettingsModalProps): JSX.Element => {
  const messages = useUiMessages();
  const resolved = children(() => props.children);
  const railEntries = createMemo(() => collectRailEntries(resolved()));
  const tabs = createMemo(() => {
    const collected = collectTabs(resolved());
    assertUniqueStableUiIds(
      collected.map((tab) => tab.props.id),
      "SettingsModal.Tab id",
    );
    return collected;
  });
  const instanceId = `k2b-settings-${createUniqueId()}`;
  const tabRefs = new Map<string, HTMLButtonElement>();
  const firstTabId = () => tabs()[0]?.props.id ?? "";
  const [localActiveTab, setLocalActiveTab] = createSignal(props.defaultTab ?? firstTabId());
  const requestedActiveTabId = () => props.activeTab ?? (localActiveTab() || firstTabId());
  const resolvedActiveTabId = () => (tabs().some((tab) => tab.props.id === requestedActiveTabId()) ? requestedActiveTabId() : firstTabId());
  const activeTab = () => tabs().find((tab) => tab.props.id === resolvedActiveTabId()) ?? null;
  const resolvedPanelChildren = children(() => activeTab()?.props.children);
  const panelChildren = createMemo(() => splitPanelChildren(resolvedPanelChildren()));

  const selectTab = (id: string) => {
    if (props.activeTab === undefined) setLocalActiveTab(id);
    props.onTabChange?.(id);
  };

  const moveTabFocus = (event: KeyboardEvent, currentId: string) => {
    const currentIndex = tabs().findIndex((tab) => tab.props.id === currentId);
    if (currentIndex < 0 || tabs().length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs().length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs().length) % tabs().length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs().length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs()[nextIndex];
    if (!nextTab) return;
    selectTab(nextTab.props.id);
    tabRefs.get(nextTab.props.id)?.focus();
  };

  const tabId = (id: string) => `${instanceId}-tab-${id}`;
  const panelId = (id: string) => `${instanceId}-panel-${id}`;

  const TabButton = (tab: SettingsModalTabDefinition): JSX.Element => {
    const active = () => resolvedActiveTabId() === tab.props.id;
    return (
      <button
        ref={(element) => tabRefs.set(tab.props.id, element)}
        id={tabId(tab.props.id)}
        type="button"
        role="tab"
        aria-selected={active()}
        aria-controls={active() ? panelId(tab.props.id) : undefined}
        tabIndex={active() ? 0 : -1}
        data-state={active() ? "active" : "idle"}
        data-active={active() ? "true" : undefined}
        data-tone={tab.props.tone ?? "default"}
        onClick={() => selectTab(tab.props.id)}
        onKeyDown={(event) => moveTabFocus(event, tab.props.id)}
      >
        <Show when={tab.props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
        <span>{tab.props.title}</span>
      </button>
    );
  };

  return (
    <div class={`k2b-settings ${props.class ?? ""}`} role="region" aria-label={props.title}>
      <Show when={props.onClose}>
        <button
          type="button"
          class="k2b-settings__close k2b-icon-button"
          aria-label={props.closeLabel ?? messages().close}
          onClick={props.onClose}
        >
          <i class="ti ti-x" aria-hidden="true" />
        </button>
      </Show>
      <aside class="k2b-settings__rail">
        <nav class="k2b-settings__tabs" aria-label={messages().sectionsLabel({ title: props.title })} role="tablist">
          <For each={railEntries()}>
            {(entry) =>
              isGroupDefinition(entry) ? (
                <div class="k2b-settings__tab-group" role="presentation">
                  <span class="k2b-settings__tab-group-label" aria-hidden="true">
                    {entry.props.title}
                  </span>
                  <For each={collectTabs(entry.props.children)}>{(tab) => TabButton(tab)}</For>
                </div>
              ) : (
                TabButton(entry)
              )
            }
          </For>
        </nav>
      </aside>
      <div class="k2b-settings__content">
        <Show when={activeTab()}>
          {(tab) => (
            <section
              id={panelId(tab().props.id)}
              class="k2b-settings__body"
              role="tabpanel"
              aria-labelledby={tabId(tab().props.id)}
              tabIndex={0}
              data-tone={tab().props.tone ?? "default"}
            >
              <div class="k2b-settings__section">
                <div class="k2b-settings__section-heading">
                  <h2>{tab().props.title}</h2>
                  <Show when={tab().props.description}>{(description) => <p>{description()}</p>}</Show>
                </div>
                {panelChildren().content}
              </div>
            </section>
          )}
        </Show>
        <Show when={panelChildren().footer}>{(footer) => <footer class="k2b-settings__footer">{footer().props.children}</footer>}</Show>
      </div>
    </div>
  );
}) as SettingsModalComponent;

SettingsModal.Tab = SettingsModalTab;
SettingsModal.Group = SettingsModalGroup;
SettingsModal.Footer = SettingsModalFooter;

export default SettingsModal;
