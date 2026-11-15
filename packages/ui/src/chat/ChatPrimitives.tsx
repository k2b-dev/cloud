import {
  type Accessor,
  children,
  createContext,
  createRenderEffect,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  useContext,
} from "solid-js";
import { Dropdown, type DropdownItem } from "../actions/Dropdown";
import { Tooltip } from "../feedback/Tooltip";
import { Format } from "../intl/Format";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { ProgressBar } from "../surfaces/ProgressBar";
import { ProgressRing } from "../surfaces/ProgressRing";
import { ChatContextPopup } from "./ChatContextPopup";
import { executeChatAction } from "./chat-behavior";
import { type ChatMessages, useChatMessages } from "./chat-messages";
import type {
  ChatAction,
  ChatActivityTone,
  ChatAttachment,
  ChatContextUsageData,
  ChatMessageStatus,
  ChatRole,
  ChatUsageSection,
} from "./types";

export type ChatMessageProps = {
  role: ChatRole;
  children?: JSX.Element;
  label?: string;
  createdAt?: string | Date;
  timeLabel?: string;
  status?: ChatMessageStatus;
  attachments?: readonly ChatAttachment[];
  actions?: readonly ChatAction[];
  actionDisplay?: "auto" | "inline" | "menu";
  anchorId?: string | number;
  onActionError?: (error: unknown) => void;
  class?: string;
};

/** The details of one step, in a card behind the ⓘ at the end of its row. */
export type ChatActivityInfo = {
  /** Name of the ⓘ button, such as "Details: Read file 'Sales.csv'". */
  label: string;
  /** The card's bold first line, usually the step's whole sentence. */
  title?: JSX.Element;
  /** A quiet line under the title, such as the outcome and the duration. */
  detail?: JSX.Element;
  /** The details themselves: a result, a reason, a note. A long text scrolls inside the card. */
  content: JSX.Element;
  /**
   * Buttons of the card, such as "Check status". A card with actions opens only with a press or Enter, takes the focus,
   * and gives it back to the ⓘ on Escape; a resting pointer opens nothing.
   */
  actions?: JSX.Element;
};

/** Colour of an activity's `meta` for an outcome that needs attention. */
export type ChatActivityMetaTone = "danger" | "warning" | "ai";

export type ChatActivityProps = {
  /** The step as text, or as a sentence with `ReferenceChip`s. One line; text that does not fit fades out. */
  label: JSX.Element;
  /** Spelled-out name for an expandable row whose visible text abbreviates, such as durations. */
  ariaLabel?: string;
  description?: string;
  icon?: string;
  /** Optional host-owned leading visual rendered instead of the icon. */
  leading?: JSX.Element;
  /** Optional identity accent for the leading visual. Semantic tones still take precedence. */
  accent?: string;
  tone?: ChatActivityTone;
  /** Marks the activity as running with the shared accent sweep. */
  busy?: boolean;
  /** Lets label and description wrap instead of ending in an ellipsis, for a system line whose whole sentence matters. */
  wrap?: boolean;
  /** A status word or count in the row's right-aligned meta column, such as "2 steps" or "Failed". */
  meta?: JSX.Element;
  /** Colours the whole `meta`. A part of it, such as "1 failed" in "6 steps · 1 failed", can carry its own `data-tone`. */
  metaTone?: ChatActivityMetaTone;
  /** How long the step took, already formatted ("12 s"), in a fixed column with tabular figures. */
  duration?: string;
  /** The duration spelled out, shown as its title. */
  durationTitle?: string;
  /** Details of a row without a body: an ⓘ in the last column opens them in a card, and the row itself never opens. */
  info?: ChatActivityInfo;
  /** Controls at the end of the text, in the meta column, such as a button. */
  trailing?: JSX.Element;
  /** Controlled disclosure state. Omit to keep native details behavior. */
  open?: boolean;
  /** Reports disclosure changes when `open` is controlled by the host. */
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  /** Set to false when the body is a peer list that should align with the activity row. */
  bodyInset?: boolean;
  anchorId?: string | number;
  children?: JSX.Element;
  /** Mount expensive details only while expanded. */
  renderBody?: () => JSX.Element;
  class?: string;
};

export type ChatContextUsageProps = ChatContextUsageData & {
  /** Application parts after the context, such as a budget. */
  sections?: readonly ChatUsageSection[];
  /** Set to false to show only `sections`, for example before a chat has context to report. */
  context?: boolean;
  /** A small icon action next to the context share, such as summarizing the chat now. */
  action?: ChatAction;
  onActionError?: (error: unknown) => void;
  /** Host-owned number formatting. The default groups whole numbers in the inherited render locale. */
  formatNumber?: (value: number) => string;
  class?: string;
};

const roleLabel = (role: ChatRole, messages: ChatMessages): string => {
  if (role === "assistant") return messages.assistant;
  if (role === "user") return messages.user;
  if (role === "tool") return messages.tool;
  return messages.system;
};

const statusLabel = (status: ChatMessageStatus | undefined, messages: ChatMessages): string | null => {
  if (status === "pending") return messages.waiting;
  if (status === "streaming") return messages.generating;
  if (status === "error") return messages.failed;
  return null;
};

const statusIcon = (status: ChatMessageStatus | undefined): string => {
  if (status === "pending") return "ti ti-clock";
  return "ti ti-alert-circle";
};

const ChatProgressDots = () => (
  <span class="k2b-chat-progress-dots" aria-hidden="true">
    <span />
    <span />
    <span />
  </span>
);

const attachmentIcon = (attachment: ChatAttachment): string =>
  attachment.icon ?? (attachment.kind === "image" ? "ti ti-photo" : attachment.kind === "resource" ? "ti ti-link" : "ti ti-file");

const finiteNonNegative = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const finiteUsageValue = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const normalizedUsage = (usage: ChatContextUsageData["usage"]) => {
  const input = finiteUsageValue(usage?.input);
  const output = finiteUsageValue(usage?.output);
  const explicitTotal = finiteUsageValue(usage?.total);
  const total = explicitTotal ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  return { input, output, total, reported: total !== null };
};

/** Whole numbers in the render locale, so a German page reads 128.000 and an English one 128,000. */
const formatLocaleInteger = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(finiteNonNegative(value)));

export const formatChatTokens = (tokens: number): string => {
  const value = finiteNonNegative(tokens);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
};

const dateTime = (value: string | Date | undefined): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function ChatMessage(props: ChatMessageProps): JSX.Element {
  const chatMessages = useChatMessages();
  const [busyActionId, setBusyActionId] = createSignal<string | null>(null);
  const [completedActionId, setCompletedActionId] = createSignal<string | null>(null);
  let completedTimer: ReturnType<typeof setTimeout> | undefined;
  const status = () => statusLabel(props.status, chatMessages());
  const timestamp = () => dateTime(props.createdAt);
  // Locale and timezone are application policy. Requiring an explicit visible
  // label keeps SSR and hydration byte-stable while `createdAt` still supplies
  // the semantic machine-readable timestamp.
  const time = () => props.timeLabel ?? null;
  const actions = () => props.actions ?? [];
  const actionDisplay = () =>
    props.actionDisplay === "auto" || !props.actionDisplay ? (props.role === "user" ? "menu" : "inline") : props.actionDisplay;
  const hasMeta = () => props.status === "streaming" || status() !== null || Boolean(time()) || actions().length > 0;

  const runAction = async (action: ChatAction) => {
    if (action.disabled || busyActionId()) return;
    setBusyActionId(action.id);
    try {
      await executeChatAction(action);
      setCompletedActionId(action.id);
      if (completedTimer) clearTimeout(completedTimer);
      completedTimer = setTimeout(() => setCompletedActionId(null), 1400);
    } catch (error) {
      props.onActionError?.(error);
    } finally {
      setBusyActionId(null);
    }
  };

  const actionIcon = (action: ChatAction) =>
    busyActionId() === action.id
      ? "ti ti-loader-2 k2b-spin"
      : completedActionId() === action.id
        ? "ti ti-check"
        : (action.icon ?? "ti ti-dots");

  onCleanup(() => {
    if (completedTimer) clearTimeout(completedTimer);
  });

  const inlineActions = () => actions().filter((action) => !action.overflow);
  const overflowActions = () => actions().filter((action) => action.overflow);
  const menuItems = (list: readonly ChatAction[] = actions()): readonly DropdownItem[] =>
    list.map((action) => ({
      icon: actionIcon(action),
      label: action.label,
      variant: action.variant,
      disabled: action.disabled || Boolean(busyActionId()),
      action: () => void runAction(action),
    }));

  return (
    <article
      class={`k2b-chat-message ${props.class ?? ""}`}
      data-role={props.role}
      data-status={props.status ?? "complete"}
      data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
      aria-busy={props.status === "pending" || props.status === "streaming" ? "true" : undefined}
    >
      <span class="k2b-sr-only">{props.label ?? roleLabel(props.role, chatMessages())}: </span>
      <Show when={(props.attachments?.length ?? 0) > 0}>
        <div class="k2b-chat-message__attachments" role="list" aria-label={chatMessages().attachments}>
          <For each={props.attachments}>
            {(attachment) => {
              // A preview that no longer loads, such as a deleted file, falls back to the attachment icon; a new URL tries again.
              const [failedPreviewUrl, setFailedPreviewUrl] = createSignal<string>();
              const content = () => (
                <>
                  <Show
                    when={attachment.kind === "image" && attachment.previewUrl && attachment.previewUrl !== failedPreviewUrl()}
                    fallback={<i class={attachmentIcon(attachment)} aria-hidden="true" />}
                  >
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.alt ?? attachment.name}
                      onError={() => setFailedPreviewUrl(attachment.previewUrl)}
                    />
                  </Show>
                  <Show when={attachment.kind !== "image"}>
                    {/* A file reads as its name and, below it quietly, its size. */}
                    <span class="k2b-chat-message__attachment-text">
                      <strong>{attachment.name}</strong>
                      <Show when={typeof attachment.size === "number" && attachment.size > 0}>
                        <Format.Bytes value={attachment.size} />
                      </Show>
                    </span>
                  </Show>
                </>
              );
              return (
                <Show
                  when={attachment.href}
                  fallback={
                    <div class="k2b-chat-message__attachment" data-kind={attachment.kind} role="listitem" title={attachment.name}>
                      {content()}
                    </div>
                  }
                >
                  {(href) => (
                    <a
                      class="k2b-chat-message__attachment"
                      data-kind={attachment.kind}
                      role="listitem"
                      title={attachment.name}
                      href={href()}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={chatMessages().openInNewTab({ name: attachment.name })}
                    >
                      {content()}
                    </a>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={props.children !== undefined && props.children !== null && props.children !== ""}>
        <div class="k2b-chat-message__bubble">
          <div class="k2b-chat-message__content">{props.children}</div>
        </div>
      </Show>

      <Show when={hasMeta()}>
        <footer class="k2b-chat-message__meta">
          <Show
            when={props.status === "streaming"}
            fallback={
              <Show when={status()}>
                {(label) => (
                  <span class="k2b-chat-message__status" role={props.status === "error" ? "alert" : "status"}>
                    <i class={statusIcon(props.status)} aria-hidden="true" />
                    {label()}
                  </span>
                )}
              </Show>
            }
          >
            <span class="k2b-chat-message__status k2b-chat-message__status--streaming" role="status" aria-label={chatMessages().generating}>
              <ChatProgressDots />
            </span>
          </Show>
          <Show when={time()}>{(label) => <time dateTime={timestamp() ?? undefined}>{label()}</time>}</Show>
          <Show when={actions().length > 0 && actionDisplay() === "inline"}>
            <span class="k2b-chat-message__actions" role="group" aria-label={chatMessages().messageActions}>
              <For each={inlineActions()}>
                {(action) => (
                  <Tooltip.Trigger
                    type="button"
                    aria-label={action.label}
                    aria-pressed={action.pressed}
                    data-pressed-tone={action.pressedTone}
                    content={action.label}
                    data-danger={action.variant === "danger" ? "true" : undefined}
                    disabled={action.disabled || Boolean(busyActionId())}
                    onClick={() => void runAction(action)}
                  >
                    <i class={actionIcon(action)} aria-hidden="true" />
                  </Tooltip.Trigger>
                )}
              </For>
              <Show when={overflowActions().length > 0}>
                <Dropdown.Root position="bottom-left" label={chatMessages().moreActions} items={menuItems(overflowActions())}>
                  <Dropdown.Trigger
                    appearance="plain"
                    class="k2b-chat-message__menu"
                    label={chatMessages().moreActions}
                    title={chatMessages().moreActions}
                  >
                    <i class="ti ti-dots" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
            </span>
          </Show>
          <Show when={actions().length > 0 && actionDisplay() === "menu"}>
            <Dropdown.Root position="bottom-left" label={chatMessages().messageActions} items={menuItems()}>
              <Dropdown.Trigger
                appearance="plain"
                class="k2b-chat-message__menu"
                label={chatMessages().messageActions}
                title={chatMessages().messageActions}
              >
                <i class="ti ti-dots" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
        </footer>
      </Show>
    </article>
  );
}

/**
 * One row on the shared grid: icon, text, meta, duration, and the chevron or ⓘ. Every cell has its own column, so a
 * missing one shifts nothing, and the right columns end on the same edge in every row.
 */
const ActivityContent = (props: ChatActivityProps & { label: JSX.Element; disclosure?: boolean; expandable?: boolean }) => (
  <>
    <span class="k2b-chat-activity__leading" aria-hidden="true">
      <Show when={props.leading} fallback={<i class={props.icon ?? "ti ti-sparkles"} />}>
        {props.leading}
      </Show>
    </span>
    <span class={props.wrap ? "k2b-chat-activity__copy" : "k2b-chat-activity__copy k2b-truncate-fade"}>
      <strong title={typeof props.label === "string" ? props.label : undefined}>{props.label}</strong>
      <Show when={props.description}>{(description) => <small>{description()}</small>}</Show>
    </span>
    <Show when={props.meta || props.trailing}>
      <span class="k2b-chat-activity__meta" data-tone={props.metaTone}>
        <Show when={props.meta}>
          <span class="k2b-chat-activity__meta-text k2b-truncate-fade">{props.meta}</span>
        </Show>
        <Show when={props.trailing}>
          <span class="k2b-chat-activity__trailing">{props.trailing}</span>
        </Show>
      </span>
    </Show>
    <Show when={props.duration}>
      {/* A running row's clock ticks silently; the row says once what it does. */}
      <span class="k2b-chat-activity__duration" title={props.durationTitle} aria-hidden={props.busy ? "true" : undefined}>
        {props.duration}
      </span>
    </Show>
    <Show when={props.disclosure}>
      <i class="ti ti-chevron-right k2b-chat-activity__chevron" aria-hidden="true" />
    </Show>
    <Show when={!props.expandable && props.info}>{(info) => <ActivityInfo info={info()} />}</Show>
  </>
);

type InfoCardModule = typeof import("./ChatActivityInfoCard");
const [infoCard, setInfoCard] = createSignal<InfoCardModule>();
let infoCardLoading = false;
/** Loads the ⓘ card once, in the browser only; the server and the first frame render the plain ⓘ. */
const loadInfoCard = () => {
  if (infoCardLoading) return;
  infoCardLoading = true;
  void import("./ChatActivityInfoCard").then(
    (module) => {
      setInfoCard(() => module);
    },
    () => {
      infoCardLoading = false;
    },
  );
};

/**
 * The ⓘ of a row without a body. It renders as a plain button with the trigger's look on the server and in the first
 * frame, and becomes the `HoverCard` trigger as soon as that code has loaded, in the same place and with the focus.
 */
function ActivityInfo(props: { info: ChatActivityInfo }): JSX.Element {
  let plain: HTMLButtonElement | undefined;
  onMount(loadInfoCard);
  return (
    <Show
      when={infoCard()}
      fallback={
        <button
          ref={plain}
          type="button"
          class="k2b-hover-card-trigger k2b-chat-activity__info"
          aria-label={props.info.label}
          aria-haspopup={props.info.actions ? "dialog" : undefined}
        >
          <i class="ti ti-info-circle" aria-hidden="true" />
        </button>
      }
    >
      {(module) => {
        const Card = module().ChatActivityInfoCard;
        return <Card info={props.info} focus={plain !== undefined && document.activeElement === plain} />;
      }}
    </Show>
  );
}

type ActivityDisclosure = {
  /** Whether the activity has a body this toggle can open. */
  expandable: Accessor<boolean>;
  open: Accessor<boolean>;
  toggle: () => void;
  bodyId: string;
  register: () => void;
};

const ActivityDisclosureContext = createContext<ActivityDisclosure>();

export type ChatActivityToggleProps = {
  /** The words that open the body, usually the count, such as "3 of 4 tasks". */
  children: JSX.Element;
};

/**
 * The words of an activity label that open its body, with the chevron right after them. With a toggle in its label,
 * only these words are the disclosure, and the rest of the row, chips with links included, stays ordinary content.
 * Outside an activity with a body it renders its words as plain text.
 */
export function ChatActivityToggle(props: ChatActivityToggleProps): JSX.Element {
  const disclosure = useContext(ActivityDisclosureContext);
  disclosure?.register();
  return (
    <Show when={disclosure?.expandable() ? disclosure : undefined} fallback={props.children}>
      {(current) => (
        <button
          type="button"
          class="k2b-chat-activity__toggle"
          aria-expanded={current().open() ? "true" : "false"}
          aria-controls={current().bodyId}
          onClick={() => current().toggle()}
        >
          <span class="k2b-chat-activity__toggle-label">{props.children}</span>
          <i class="ti ti-chevron-right k2b-chat-activity__chevron" aria-hidden="true" />
        </button>
      )}
    </Show>
  );
}

export function ChatActivity(props: ChatActivityProps): JSX.Element {
  // The disclosure's real state. A controlled `open` sets it, and every toggle reports it, so the body renders whenever
  // the row is open, also when a host has not yet passed its new `open` back.
  const [expanded, setExpanded] = createSignal(props.open ?? props.defaultOpen ?? false);
  createRenderEffect(() => {
    const open = props.open;
    if (open !== undefined) setExpanded(open);
  });
  const open = expanded;
  const setOpen = (next: boolean) => {
    if (next === expanded()) return;
    setExpanded(next);
    props.onOpenChange?.(next);
  };
  const tone = () => props.tone ?? "neutral";
  const style = () => (props.accent ? { "--k2b-chat-activity-accent": props.accent } : undefined);
  const expandable = () => Boolean(props.renderBody || props.children);
  // A `Chat.Activity.Toggle` in the label registers while the label resolves, before the row picks its element, so the
  // server and the first browser frame agree on whether the whole row or only the toggle is the disclosure.
  const [toggles, setToggles] = createSignal(0);
  const bodyId = createUniqueId();
  const disclosure: ActivityDisclosure = {
    expandable,
    open,
    toggle: () => setOpen(!expanded()),
    bodyId,
    register: () => {
      setToggles((count) => count + 1);
      onCleanup(() => setToggles((count) => count - 1));
    },
  };
  const body = () =>
    props.renderBody ? <Show when={open() ? props.renderBody : undefined}>{(render) => render()()}</Show> : props.children;
  return (
    <ActivityDisclosureContext.Provider value={disclosure}>
      {(() => {
        const label = children(() => props.label);
        return (
          <Show
            when={expandable()}
            fallback={
              <div
                class={`k2b-chat-activity ${props.class ?? ""}`}
                data-tone={tone()}
                data-accent={props.accent ? "true" : undefined}
                data-busy={props.busy ? "true" : undefined}
                data-wrap={props.wrap ? "true" : undefined}
                data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
                style={style()}
                aria-busy={props.busy ? "true" : undefined}
              >
                <div class="k2b-chat-activity__row">
                  <ActivityContent {...props} label={label()} />
                </div>
              </div>
            }
          >
            <Show
              when={toggles() === 0}
              fallback={
                <div
                  class={`k2b-chat-activity ${props.class ?? ""}`}
                  data-tone={tone()}
                  data-accent={props.accent ? "true" : undefined}
                  data-busy={props.busy ? "true" : undefined}
                  data-wrap={props.wrap ? "true" : undefined}
                  data-body-inset={props.bodyInset === false ? "false" : undefined}
                  data-open={open() ? "true" : "false"}
                  data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
                  style={style()}
                  aria-busy={props.busy ? "true" : undefined}
                >
                  <div class="k2b-chat-activity__row">
                    <ActivityContent {...props} label={label()} expandable />
                  </div>
                  <div id={bodyId} class="k2b-chat-activity__body" hidden={!open()}>
                    {body()}
                  </div>
                </div>
              }
            >
              <details
                class={`k2b-chat-activity ${props.class ?? ""}`}
                data-tone={tone()}
                data-accent={props.accent ? "true" : undefined}
                data-busy={props.busy ? "true" : undefined}
                data-wrap={props.wrap ? "true" : undefined}
                data-body-inset={props.bodyInset === false ? "false" : undefined}
                data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
                style={style()}
                open={open()}
                onToggle={(event) => {
                  setExpanded(event.currentTarget.open);
                  props.onOpenChange?.(event.currentTarget.open);
                }}
                aria-busy={props.busy ? "true" : undefined}
              >
                <summary class="k2b-chat-activity__row" aria-label={props.ariaLabel}>
                  <ActivityContent {...props} label={label()} disclosure expandable />
                </summary>
                <div class="k2b-chat-activity__body">{body()}</div>
              </details>
            </Show>
          </Show>
        );
      })()}
    </ActivityDisclosureContext.Provider>
  );
}

/** Context pressure warns from this share of the window. */
const CONTEXT_WARN_PERCENT = 85;
/** An application part warns from this share unless it sets its own. */
const SECTION_WARN_PERCENT = 80;

const finitePercent = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;

export function ChatContextUsage(props: ChatContextUsageProps): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    const action = props.action;
    if (!action || action.disabled || busy()) return;
    setBusy(true);
    try {
      await executeChatAction(action);
    } catch (error) {
      props.onActionError?.(error);
    } finally {
      setBusy(false);
    }
  };
  const messages = useUiMessages();
  const chatMessages = useChatMessages();
  const locale = useLocale();
  const formatNumber = (value: number) => (props.formatNumber ? props.formatNumber(value) : formatLocaleInteger(value, locale()));
  const formatPercent = (value: number) =>
    new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(Math.round(value) / 100);
  const formattedUsageValue = (value: number | null): string => (value === null ? messages().unknown : formatNumber(value));
  const showContext = () => props.context !== false;
  const sections = () => props.sections ?? [];
  const usage = () => normalizedUsage(props.usage);
  const loopUsage = () => normalizedUsage(props.loopUsage);
  const total = () => usage().total ?? 0;
  const windowSize = () => finiteNonNegative(props.contextWindow);
  const reported = () => usage().reported;
  const percent = () => (reported() && windowSize() > 0 ? Math.min(100, Math.round((total() / windowSize()) * 100)) : null);
  const remaining = () => (reported() && windowSize() > 0 ? Math.max(0, windowSize() - total()) : null);
  const contextWarns = () => showContext() && (percent() ?? 0) >= CONTEXT_WARN_PERCENT;
  const sectionWarns = (section: ChatUsageSection) => {
    const value = finitePercent(section.percent);
    return value !== null && value >= (section.warnAt ?? SECTION_WARN_PERCENT);
  };
  /** The ring shows the highest known share: the part that runs out first. */
  const highest = () => {
    const values = [showContext() ? percent() : null, ...sections().map((section) => finitePercent(section.percent))].filter(
      (value): value is number => value !== null,
    );
    return values.length ? Math.min(100, Math.max(...values)) : null;
  };
  const warning = () => contextWarns() || sections().some(sectionWarns);
  const contextSummary = () => {
    if (!reported()) {
      return windowSize() > 0
        ? chatMessages().contextUsageUnavailableWithWindow({ window: formatNumber(windowSize()) })
        : chatMessages().contextUsageUnavailable;
    }
    return percent() === null
      ? chatMessages().tokensUsed({ total: formatNumber(total()) })
      : chatMessages().contextSummaryPercent({ percent: formatPercent(percent()!) });
  };
  const accessibleLabel = () =>
    chatMessages().usageSummary({
      parts: [...(showContext() ? [contextSummary()] : []), ...sections().map((section) => section.summary)].join(", "),
    });
  const actionTooltip = (action: ChatAction) => (action.disabled && action.disabledReason ? action.disabledReason : action.label);

  return (
    <span class="k2b-chat-usage" data-warning={warning() ? "true" : undefined}>
      <ChatContextPopup
        content={
          <div class="k2b-chat-context__tooltip k2b-chat-usage__panel">
            <Show when={showContext()}>
              <section class="k2b-chat-usage__part">
                <header class="k2b-chat-usage__head">
                  <h4>{chatMessages().thisChat}</h4>
                  <span class="k2b-chat-usage__value" data-warning={contextWarns() ? "true" : undefined}>
                    {percent() === null
                      ? reported()
                        ? chatMessages().tokensUsed({ total: formatNumber(total()) })
                        : messages().unknown
                      : chatMessages().contextFull({ percent: formatPercent(percent()!) })}
                  </span>
                  <Show when={props.action}>
                    {(action) => (
                      <Tooltip.Trigger
                        type="button"
                        class="k2b-chat-usage__action"
                        aria-label={action().label}
                        aria-disabled={action().disabled || busy() ? "true" : undefined}
                        aria-busy={busy() ? "true" : undefined}
                        content={actionTooltip(action())}
                        onClick={() => void run()}
                      >
                        <i
                          class={busy() ? "ti ti-loader-2 k2b-spin" : (action().icon ?? "ti ti-arrows-diagonal-minimize-2")}
                          aria-hidden="true"
                        />
                      </Tooltip.Trigger>
                    )}
                  </Show>
                </header>
                <Show when={percent() !== null}>
                  <ProgressBar
                    value={percent() ?? 0}
                    size="xs"
                    tone={contextWarns() ? "warning" : "info"}
                    label={chatMessages().contextWindowUsed}
                  />
                </Show>
                <Show when={props.note}>
                  <p>{props.note}</p>
                </Show>
                <dl>
                  <Show when={props.modelLabel}>
                    {(model) => (
                      <div>
                        <dt>{chatMessages().model}</dt>
                        <dd>{model()}</dd>
                      </div>
                    )}
                  </Show>
                  <div>
                    <dt>{chatMessages().input}</dt>
                    <dd>{formattedUsageValue(usage().input)}</dd>
                  </div>
                  <div>
                    <dt>{chatMessages().output}</dt>
                    <dd>{formattedUsageValue(usage().output)}</dd>
                  </div>
                  <Show when={reported()}>
                    <div>
                      <dt>{chatMessages().contextInUse}</dt>
                      <dd>{formatNumber(total())}</dd>
                    </div>
                  </Show>
                  <Show when={loopUsage().reported}>
                    <div>
                      <dt>{chatMessages().loopTotal}</dt>
                      <dd>{formattedUsageValue(loopUsage().total)}</dd>
                    </div>
                  </Show>
                  <div>
                    <dt>{chatMessages().contextWindow}</dt>
                    <dd>{windowSize() > 0 ? formatNumber(windowSize()) : chatMessages().notConfigured}</dd>
                  </div>
                  <Show when={remaining() !== null}>
                    <div>
                      <dt>{chatMessages().remaining}</dt>
                      <dd>{remaining() === null ? messages().unknown : formatNumber(remaining()!)}</dd>
                    </div>
                  </Show>
                </dl>
              </section>
            </Show>
            <For each={sections()}>
              {(section) => (
                <section class="k2b-chat-usage__part" data-section={section.id}>
                  <header class="k2b-chat-usage__head">
                    <h4>{section.title}</h4>
                    <Show when={section.value}>
                      <span class="k2b-chat-usage__value" data-warning={sectionWarns(section) ? "true" : undefined}>
                        {section.value}
                      </span>
                    </Show>
                  </header>
                  {section.content}
                </section>
              )}
            </For>
          </div>
        }
        type="button"
        class={`k2b-chat-context k2b-chat-usage__trigger ${props.class ?? ""}`}
        data-warning={warning() ? "true" : undefined}
        aria-label={accessibleLabel()}
        onOpen={() => {
          for (const section of sections()) section.onOpen?.();
        }}
      >
        <ProgressRing value={highest() ?? 0} tone={warning() ? "warning" : "info"} />
        <Show when={warning() && highest() !== null}>
          <span class="k2b-chat-usage__number">{formatPercent(highest()!)}</span>
        </Show>
      </ChatContextPopup>
    </span>
  );
}
