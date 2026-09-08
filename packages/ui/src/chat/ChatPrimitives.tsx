import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Dropdown, type DropdownItem } from "../actions/Dropdown";
import { Tooltip } from "../feedback/Tooltip";
import { type UiMessages, useUiMessages } from "../intl/messages";
import { ProgressBar } from "../surfaces/ProgressBar";
import { executeChatAction } from "./chat-behavior";
import type { ChatAction, ChatActivityTone, ChatAttachment, ChatContextUsageData, ChatMessageStatus, ChatRole } from "./types";

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

export type ChatActivityProps = {
  label: string;
  description?: string;
  icon?: string;
  /** Optional host-owned leading visual rendered instead of the icon. */
  leading?: JSX.Element;
  /** Optional identity accent for the leading visual. Semantic tones still take precedence. */
  accent?: string;
  tone?: ChatActivityTone;
  /** Marks the activity as running with the shared accent sweep. */
  busy?: boolean;
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
  class?: string;
};

export type ChatContextUsageProps = ChatContextUsageData & {
  /** Host-owned number formatting. The default is locale-independent and SSR-stable. */
  formatNumber?: (value: number) => string;
  class?: string;
};

const roleLabel = (role: ChatRole, messages: UiMessages): string => {
  if (role === "assistant") return messages.assistant;
  if (role === "user") return messages.user;
  if (role === "tool") return messages.tool;
  return messages.system;
};

const statusLabel = (status: ChatMessageStatus | undefined, messages: UiMessages): string | null => {
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

const formatStableInteger = (value: number): string => {
  const digits = String(Math.round(finiteNonNegative(value)));
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

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
  const messages = useUiMessages();
  const [busyActionId, setBusyActionId] = createSignal<string | null>(null);
  const [completedActionId, setCompletedActionId] = createSignal<string | null>(null);
  let completedTimer: ReturnType<typeof setTimeout> | undefined;
  const status = () => statusLabel(props.status, messages());
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

  const menuItems = (): readonly DropdownItem[] =>
    actions().map((action) => ({
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
      <span class="k2b-sr-only">{props.label ?? roleLabel(props.role, messages())}: </span>
      <Show when={(props.attachments?.length ?? 0) > 0}>
        <div class="k2b-chat-message__attachments" role="list" aria-label={messages().attachments}>
          <For each={props.attachments}>
            {(attachment) => {
              const content = () => (
                <>
                  <Show
                    when={attachment.kind === "image" && attachment.previewUrl}
                    fallback={<i class={attachmentIcon(attachment)} aria-hidden="true" />}
                  >
                    <img src={attachment.previewUrl} alt={attachment.alt ?? attachment.name} />
                  </Show>
                  <Show when={attachment.kind !== "image"}>
                    <span>{attachment.name}</span>
                  </Show>
                </>
              );
              return (
                <Show
                  when={attachment.href}
                  fallback={
                    <div class="k2b-chat-message__attachment" role="listitem" title={attachment.name}>
                      {content()}
                    </div>
                  }
                >
                  {(href) => (
                    <a
                      class="k2b-chat-message__attachment"
                      role="listitem"
                      title={attachment.name}
                      href={href()}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={messages().openInNewTab({ name: attachment.name })}
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
            <span class="k2b-chat-message__status k2b-chat-message__status--streaming" role="status" aria-label={messages().generating}>
              <ChatProgressDots />
            </span>
          </Show>
          <Show when={time()}>{(label) => <time dateTime={timestamp() ?? undefined}>{label()}</time>}</Show>
          <Show when={actions().length > 0 && actionDisplay() === "inline"}>
            <span class="k2b-chat-message__actions" role="group" aria-label={messages().messageActions}>
              <For each={actions()}>
                {(action) => (
                  <button
                    type="button"
                    aria-label={action.label}
                    aria-pressed={action.pressed}
                    data-pressed-tone={action.pressedTone}
                    title={action.label}
                    data-danger={action.variant === "danger" ? "true" : undefined}
                    disabled={action.disabled || Boolean(busyActionId())}
                    onClick={() => void runAction(action)}
                  >
                    <i class={actionIcon(action)} aria-hidden="true" />
                  </button>
                )}
              </For>
            </span>
          </Show>
          <Show when={actions().length > 0 && actionDisplay() === "menu"}>
            <Dropdown.Root position="bottom-left" width="12rem" label={messages().messageActions} items={menuItems()}>
              <Dropdown.Trigger
                appearance="plain"
                class="k2b-chat-message__menu"
                label={messages().messageActions}
                title={messages().messageActions}
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

const ActivityContent = (props: ChatActivityProps & { disclosure?: boolean }) => (
  <>
    <span class="k2b-chat-activity__leading" aria-hidden="true">
      <Show when={props.leading} fallback={<i class={props.icon ?? "ti ti-sparkles"} />}>
        {props.leading}
      </Show>
    </span>
    <span class="k2b-chat-activity__copy">
      <strong>{props.label}</strong>
      <Show when={props.description}>{(description) => <small>{description()}</small>}</Show>
    </span>
    <Show when={props.trailing}>
      <span class="k2b-chat-activity__trailing">{props.trailing}</span>
    </Show>
    <Show when={props.disclosure}>
      <i class="ti ti-chevron-right k2b-chat-activity__chevron" aria-hidden="true" />
    </Show>
  </>
);

export function ChatActivity(props: ChatActivityProps): JSX.Element {
  const tone = () => props.tone ?? "neutral";
  const style = () => (props.accent ? { "--k2b-chat-activity-accent": props.accent } : undefined);
  return (
    <Show
      when={props.children}
      fallback={
        <div
          class={`k2b-chat-activity ${props.class ?? ""}`}
          data-tone={tone()}
          data-accent={props.accent ? "true" : undefined}
          data-busy={props.busy ? "true" : undefined}
          data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
          style={style()}
          aria-busy={props.busy ? "true" : undefined}
        >
          <div class="k2b-chat-activity__row">
            <ActivityContent {...props} />
          </div>
        </div>
      }
    >
      <details
        class={`k2b-chat-activity ${props.class ?? ""}`}
        data-tone={tone()}
        data-accent={props.accent ? "true" : undefined}
        data-busy={props.busy ? "true" : undefined}
        data-body-inset={props.bodyInset === false ? "false" : undefined}
        data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
        style={style()}
        open={props.open ?? props.defaultOpen}
        onToggle={(event) => props.onOpenChange?.(event.currentTarget.open)}
        aria-busy={props.busy ? "true" : undefined}
      >
        <summary class="k2b-chat-activity__row">
          <ActivityContent {...props} disclosure />
        </summary>
        <div class="k2b-chat-activity__body">{props.children}</div>
      </details>
    </Show>
  );
}

export function ChatContextUsage(props: ChatContextUsageProps): JSX.Element {
  const messages = useUiMessages();
  const formatNumber = (value: number) => (props.formatNumber ?? formatStableInteger)(value);
  const formattedUsageValue = (value: number | null): string => (value === null ? messages().unknown : formatNumber(value));
  const usage = () => normalizedUsage(props.usage);
  const loopUsage = () => normalizedUsage(props.loopUsage);
  const total = () => usage().total ?? 0;
  const windowSize = () => finiteNonNegative(props.contextWindow);
  const reported = () => usage().reported;
  const percent = () => (reported() && windowSize() > 0 ? Math.min(100, Math.round((total() / windowSize()) * 100)) : null);
  const remaining = () => (reported() && windowSize() > 0 ? Math.max(0, windowSize() - total()) : null);
  const accessibleLabel = () => {
    if (!reported()) {
      return windowSize() > 0
        ? messages().contextUsageUnavailableWithWindow({ window: formatNumber(windowSize()) })
        : messages().contextUsageUnavailable;
    }
    return percent() === null
      ? messages().tokensUsed({ total: formatNumber(total()) })
      : messages().tokensUsedPercent({ total: formatNumber(total()), percent: percent()! });
  };

  return (
    <Tooltip.Trigger
      placement="top"
      content={
        <div class="k2b-chat-context__tooltip">
          <strong>{messages().lastRequestContext}</strong>
          <Show when={percent() !== null}>
            <ProgressBar
              value={percent() ?? 0}
              size="xs"
              tone={(percent() ?? 0) >= 85 ? "danger" : "info"}
              label={messages().contextWindowUsed}
            />
          </Show>
          <dl>
            <Show when={props.modelLabel}>
              {(model) => (
                <div>
                  <dt>{messages().model}</dt>
                  <dd>{model()}</dd>
                </div>
              )}
            </Show>
            <div>
              <dt>{messages().input}</dt>
              <dd>{formattedUsageValue(usage().input)}</dd>
            </div>
            <div>
              <dt>{messages().output}</dt>
              <dd>{formattedUsageValue(usage().output)}</dd>
            </div>
            <Show when={loopUsage().reported}>
              <div>
                <dt>{messages().loopTotal}</dt>
                <dd>{formattedUsageValue(loopUsage().total)}</dd>
              </div>
            </Show>
            <div>
              <dt>{messages().window}</dt>
              <dd>{windowSize() > 0 ? formatNumber(windowSize()) : messages().notConfigured}</dd>
            </div>
            <Show when={remaining() !== null}>
              <div>
                <dt>{messages().remaining}</dt>
                <dd>{remaining() === null ? messages().unknown : formatNumber(remaining()!)}</dd>
              </div>
            </Show>
          </dl>
        </div>
      }
      type="button"
      class={`k2b-chat-context ${props.class ?? ""}`}
      data-warning={reported() && (percent() ?? 0) >= 85 ? "true" : undefined}
      aria-label={accessibleLabel()}
    >
      <i class="ti ti-brain" aria-hidden="true" />
      <span>{percent() === null ? "–" : `${percent()}%`}</span>
    </Tooltip.Trigger>
  );
}
