import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onMount, Show } from "solid-js";
import { Dropdown, type DropdownItem as DropdownItemData } from "../actions/Dropdown";
import { SelectChip } from "../inputs/SelectChip";
import { useUiMessages } from "../intl/messages";
import { ChatContextUsage as ContextUsage } from "./ChatPrimitives";
import { executeChatAction, filterChatCommands, nextChatCommandIndex, reportChatFailure, runChatSubmission } from "./chat-behavior";
import type { ChatAction, ChatAttachment, ChatComposerState, ChatContextUsageData, ChatModelOption, ChatSubmitInput } from "./types";

const composerMaxInputHeight = 309;

export type ChatCommandContext = {
  setValue: (value: string) => void;
  submit: () => void;
  focus: () => void;
};

export type ChatCommand = {
  name: string;
  description: string;
  icon?: string;
  action: (context: ChatCommandContext) => void | Promise<void>;
};

export type ChatFileSelection = {
  onSelect: (files: readonly File[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
};

export type ChatPasteHandler = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement; target: Element }) => void;

export type ChatComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (input: ChatSubmitInput) => boolean | void | Promise<boolean | void>;
  /** Submit intent used for drafts entered while a response is running. Defaults to `steer`. */
  runningSubmitIntent?: "steer" | "queue";
  onStop?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  state?: ChatComposerState;
  attachments?: readonly ChatAttachment[];
  onAttachmentsChange?: (attachments: readonly ChatAttachment[]) => void;
  fileSelection?: ChatFileSelection;
  /** Handle non-file clipboard content. Pasted files already use `fileSelection`. */
  onPaste?: ChatPasteHandler;
  menuActions?: readonly ChatAction[];
  models?: readonly ChatModelOption[];
  selectedModelId?: string | null;
  onModelChange?: (modelId: string) => void;
  commands?: readonly ChatCommand[];
  contextUsage?: ChatContextUsageData;
  contextActions?: readonly ChatAction[];
  /** Additional compact controls rendered with the add/model controls. */
  footerTools?: JSX.Element;
  placeholder?: string;
  label?: string;
  inputLabel?: string;
  disabled?: boolean;
  error?: string;
  focusToken?: unknown;
  class?: string;
};

const attachmentIcon = (attachment: ChatAttachment): string =>
  attachment.icon ?? (attachment.kind === "image" ? "ti ti-photo" : attachment.kind === "resource" ? "ti ti-link" : "ti ti-file");

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const messages = useUiMessages();
  const commandListId = `k2b-chat-commands-${createUniqueId().replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const [selectedCommandIndex, setSelectedCommandIndex] = createSignal(0);
  const [dragActive, setDragActive] = createSignal(false);
  const [addingFiles, setAddingFiles] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  let composerRef: HTMLElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let sawRunning = props.state === "running";

  const state = () => props.state ?? "idle";
  const running = () => state() === "running";
  const stopping = () => state() === "stopping";
  const runningSubmitIntent = () => props.runningSubmitIntent ?? "steer";
  const attachments = () => props.attachments ?? [];
  const commands = () => props.commands ?? [];
  const commandMatches = createMemo(() => filterChatCommands(props.value, commands()));
  const commandsOpen = () => commandMatches().length > 0;
  const selectedCommand = () => commandMatches()[selectedCommandIndex()];
  const blocked = () => Boolean(props.disabled || stopping() || state() === "submitting" || addingFiles() || submitting());
  const hasDraft = () => Boolean(props.value.trim() || (!running() && attachments().length > 0));
  const canSubmit = () => !blocked() && hasDraft();
  const canSelectFiles = () => Boolean(props.fileSelection && !props.fileSelection.disabled && !running() && !blocked());
  const hasAddMenu = () => Boolean(props.fileSelection || props.menuActions?.length);
  const hasContextUsage = () => {
    const context = props.contextUsage;
    if (!context || typeof context.contextWindow !== "number" || !Number.isFinite(context.contextWindow) || context.contextWindow <= 0) {
      return false;
    }
    return [context.usage?.total, context.usage?.input, context.usage?.output].some(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
  };

  const menuItems = (): readonly DropdownItemData[] => {
    const items: DropdownItemData[] = [];
    if (props.fileSelection) {
      items.push({
        icon: addingFiles() ? "ti ti-loader-2 k2b-spin" : "ti ti-paperclip",
        label: props.fileSelection.label ?? messages().attachFiles,
        disabled: !canSelectFiles(),
        action: () => fileInputRef?.click(),
      });
    }
    for (const action of props.menuActions ?? []) {
      items.push({
        icon: action.icon,
        label: action.label,
        variant: action.variant,
        disabled: action.disabled,
        action: () => reportChatFailure(() => executeChatAction(action), props.onError),
      });
    }
    return items;
  };

  const autoResize = () => {
    if (!textareaRef) return;
    textareaRef.style.height = "auto";
    textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, composerMaxInputHeight)}px`;
  };

  const focus = () => textareaRef?.focus();

  onMount(() => {
    autoResize();
    if (props.focusToken !== undefined) focus();
  });

  createEffect(() => {
    commandMatches();
    setSelectedCommandIndex(0);
  });

  createEffect(() => {
    props.value;
    queueMicrotask(autoResize);
  });

  createEffect(() => {
    props.focusToken;
    if (props.focusToken !== undefined) queueMicrotask(focus);
  });

  createEffect(() => {
    const active = running();
    if (sawRunning && !active && !props.disabled && typeof document !== "undefined") {
      const focused = document.activeElement as HTMLElement | null;
      const insideComposer = Boolean(focused && composerRef?.contains(focused));
      const editingElsewhere = Boolean(
        focused &&
          focused !== document.body &&
          !insideComposer &&
          (focused.matches("input, textarea, select") || focused.isContentEditable || focused.closest("[role='dialog'], [popover]")),
      );
      if (!editingElsewhere) queueMicrotask(focus);
    }
    sawRunning = active;
  });

  const setAttachments = (next: readonly ChatAttachment[]) => props.onAttachmentsChange?.(next);

  const renderAttachmentCopy = (attachment: ChatAttachment) => (
    <span>
      <strong title={attachment.name}>{attachment.name}</strong>
    </span>
  );

  const runFiles = async (files: FileList | readonly File[]) => {
    if (!canSelectFiles()) return;
    const selected = Array.from(files);
    if (selected.length === 0) return;
    setAddingFiles(true);
    try {
      await props.fileSelection?.onSelect(selected);
    } catch (error) {
      (props.fileSelection?.onError ?? props.onError)?.(error);
    } finally {
      setAddingFiles(false);
      if (fileInputRef) fileInputRef.value = "";
      queueMicrotask(focus);
    }
  };

  const submit = async () => {
    if (!canSubmit()) return;
    const intent = running() ? runningSubmitIntent() : "send";
    const previousValue = props.value;
    const previousAttachments = attachments();
    const input: ChatSubmitInput = {
      intent,
      text: previousValue.trim(),
      attachments: intent === "send" ? previousAttachments : [],
    };

    setSubmitting(true);
    try {
      await runChatSubmission({
        clear: () => {
          props.onValueChange("");
          if (intent === "send") setAttachments([]);
        },
        perform: () => props.onSubmit(input),
        restore: () => {
          props.onValueChange(previousValue);
          if (intent === "send") setAttachments(previousAttachments);
        },
        onError: props.onError,
      });
    } finally {
      setSubmitting(false);
      queueMicrotask(() => {
        autoResize();
        focus();
      });
    }
  };

  const executeCommand = async (command: ChatCommand) => {
    props.onValueChange("");
    try {
      await command.action({
        setValue: props.onValueChange,
        submit: () => void submit(),
        focus,
      });
    } catch (error) {
      props.onError?.(error);
    }
    queueMicrotask(() => {
      autoResize();
      focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const matches = commandMatches();
    if (matches.length > 0) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedCommandIndex((index) => nextChatCommandIndex(index, matches.length, event.key === "ArrowUp" ? -1 : 1));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const command = selectedCommand();
        if (command) void executeCommand(command);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        props.onValueChange("");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section
      ref={composerRef}
      class={`k2b-chat-composer ${props.class ?? ""}`}
      data-running={running() ? "true" : undefined}
      data-drag-active={dragActive() ? "true" : undefined}
      role="group"
      aria-label={props.label ?? messages().messageComposer}
    >
      <Show when={commandsOpen()}>
        <div id={commandListId} class="k2b-chat-composer__commands" role="listbox" aria-label={messages().commands}>
          <For each={commandMatches()}>
            {(command, index) => (
              <button
                id={`${commandListId}-${index()}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index() === selectedCommandIndex()}
                data-active={index() === selectedCommandIndex() ? "true" : undefined}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void executeCommand(command)}
              >
                <i class={command.icon ?? "ti ti-slash"} aria-hidden="true" />
                <span>
                  <strong>/{command.name}</strong>
                  <small>{command.description}</small>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={attachments().length > 0}>
        <div class="k2b-chat-composer__attachments" role="list" aria-label={messages().attachments} tabIndex={0}>
          <For each={attachments()}>
            {(attachment) => (
              <div class="k2b-chat-composer__attachment" role="listitem">
                <div
                  class="k2b-chat-composer__attachment-content"
                  classList={{ "k2b-chat-composer__attachment-content--action": Boolean(attachment.action) }}
                >
                  <Show
                    when={attachment.href}
                    fallback={
                      <div class="k2b-chat-composer__attachment-identity">
                        <Show
                          when={attachment.kind === "image" && attachment.previewUrl}
                          fallback={<i class={attachmentIcon(attachment)} aria-hidden="true" />}
                        >
                          <img src={attachment.previewUrl} alt={attachment.alt ?? ""} />
                        </Show>
                        {renderAttachmentCopy(attachment)}
                      </div>
                    }
                  >
                    {(href) => (
                      <a
                        class="k2b-chat-composer__attachment-link"
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={messages().openInNewTab({ name: attachment.name })}
                      >
                        <Show
                          when={attachment.kind === "image" && attachment.previewUrl}
                          fallback={<i class={attachmentIcon(attachment)} aria-hidden="true" />}
                        >
                          <img src={attachment.previewUrl} alt={attachment.alt ?? ""} />
                        </Show>
                        {renderAttachmentCopy(attachment)}
                      </a>
                    )}
                  </Show>
                  <Show when={attachment.action}>
                    {(action) => (
                      <button
                        type="button"
                        class="k2b-chat-composer__attachment-action"
                        disabled={blocked() || action().disabled}
                        onClick={() => reportChatFailure(() => executeChatAction(action()), props.onError)}
                      >
                        <Show when={action().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                        {action().label}
                      </button>
                    )}
                  </Show>
                </div>
                <Show when={props.onAttachmentsChange}>
                  <button
                    type="button"
                    class="k2b-chat-composer__attachment-remove"
                    aria-label={messages().removeNamed({ name: attachment.name })}
                    disabled={blocked()}
                    onClick={() => setAttachments(attachments().filter((candidate) => candidate.id !== attachment.id))}
                  >
                    <i class="ti ti-x" aria-hidden="true" />
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div
        class="k2b-chat-composer__input"
        role="group"
        aria-label={messages().messageInput}
        onDragEnter={(event) => {
          if (!canSelectFiles() || !event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!canSelectFiles() || !event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          setDragActive(false);
          if (canSelectFiles() && event.dataTransfer.files.length) void runFiles(event.dataTransfer.files);
        }}
      >
        <Show when={dragActive()}>
          <div class="k2b-chat-composer__drop" aria-hidden="true">
            {messages().dropFilesToAttach}
          </div>
        </Show>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: popup attributes are conditional with the combobox role */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={props.value}
          disabled={blocked()}
          placeholder={props.placeholder ?? (running() ? messages().addGuidance : messages().writeMessage)}
          aria-label={props.inputLabel ?? messages().message}
          role={commandsOpen() ? "combobox" : undefined}
          aria-autocomplete={commandsOpen() ? "list" : undefined}
          aria-controls={commandsOpen() ? commandListId : undefined}
          aria-expanded={commandsOpen() ? "true" : undefined}
          aria-activedescendant={selectedCommand() ? `${commandListId}-${selectedCommandIndex()}` : undefined}
          onInput={(event) => {
            props.onValueChange(event.currentTarget.value);
            autoResize();
          }}
          onPaste={(event) => {
            const clipboardData = event.clipboardData;
            if (canSelectFiles() && clipboardData?.files.length) {
              event.preventDefault();
              void runFiles(clipboardData.files);
              return;
            }
            props.onPaste?.(event);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <Show when={props.error}>
        <div class="k2b-chat-composer__error" role="alert">
          <i class="ti ti-alert-circle" aria-hidden="true" />
          {props.error}
        </div>
      </Show>

      <footer class="k2b-chat-composer__footer">
        <div class="k2b-chat-composer__tools">
          {props.footerTools}
          <Show when={hasAddMenu()}>
            <Dropdown.Root position="top-right" width="12rem" label={messages().addToChat} items={menuItems()} disabled={blocked()}>
              <Dropdown.Trigger
                appearance="plain"
                class="k2b-chat-composer__icon-action"
                label={messages().addToChat}
                title={messages().addToChat}
              >
                <i class="ti ti-plus" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
          <Show when={props.fileSelection}>
            <input
              ref={fileInputRef}
              class="k2b-sr-only"
              type="file"
              tabIndex={-1}
              aria-hidden="true"
              accept={props.fileSelection?.accept}
              multiple={props.fileSelection?.multiple ?? true}
              onChange={(event) => {
                if (event.currentTarget.files?.length) void runFiles(event.currentTarget.files);
              }}
            />
          </Show>
          <Show when={(props.models?.length ?? 0) > 0}>
            <SelectChip
              aria-label={messages().chooseModel}
              position="top-right"
              class="k2b-chat-composer__model"
              menuWidth="15rem"
              placeholder={messages().model}
              value={() => props.selectedModelId ?? ""}
              options={(props.models ?? []).map((model) => ({
                value: model.id,
                label: model.label,
                description: model.description,
                icon: model.icon,
                image: model.image,
              }))}
              disabled={blocked() || running() || !props.onModelChange}
              onValueChange={(modelId) => {
                props.onModelChange?.(modelId);
                queueMicrotask(focus);
              }}
            />
          </Show>
        </div>

        <div class="k2b-chat-composer__submit">
          <For each={props.contextActions}>
            {(action) => (
              <button
                type="button"
                class="k2b-chat-composer__icon-action"
                data-tone={action.variant === "danger" ? "danger" : undefined}
                disabled={action.disabled}
                aria-label={action.label}
                title={action.label}
                onClick={() => reportChatFailure(() => executeChatAction(action), props.onError)}
              >
                <i class={action.icon ?? "ti ti-dots"} aria-hidden="true" />
              </button>
            )}
          </For>
          <Show when={hasContextUsage() ? props.contextUsage : undefined}>{(usage) => <ContextUsage {...usage()} />}</Show>
          <Show
            when={running() && !hasDraft() && props.onStop}
            fallback={
              <button
                type="button"
                class="k2b-chat-composer__send"
                disabled={!canSubmit()}
                aria-label={
                  submitting()
                    ? running()
                      ? runningSubmitIntent() === "queue"
                        ? messages().queueing
                        : messages().steering
                      : messages().sending
                    : running()
                      ? runningSubmitIntent() === "queue"
                        ? messages().queueMessage
                        : messages().steerResponse
                      : messages().sendMessage
                }
                title={
                  running()
                    ? runningSubmitIntent() === "queue"
                      ? messages().queueMessage
                      : messages().steerResponse
                    : messages().sendMessage
                }
                onClick={() => void submit()}
              >
                <i class={submitting() ? "ti ti-loader-2 k2b-spin" : "ti ti-arrow-up"} aria-hidden="true" />
              </button>
            }
          >
            <button
              type="button"
              class="k2b-chat-composer__stop"
              disabled={stopping()}
              aria-label={stopping() ? messages().stopping : messages().stopResponse}
              title={stopping() ? messages().stopping : messages().stopResponse}
              onClick={() => reportChatFailure(() => props.onStop?.(), props.onError)}
            >
              <i class={stopping() ? "ti ti-loader-2 k2b-spin" : "ti ti-player-stop"} aria-hidden="true" />
            </button>
          </Show>
        </div>
      </footer>
    </section>
  );
}
