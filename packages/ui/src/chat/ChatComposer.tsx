import { children, createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onMount, onCleanup, untrack, Show } from "solid-js";
import { Dropdown, type DropdownItem as DropdownItemData } from "../actions/Dropdown";
import { SelectChip } from "../inputs/SelectChip";
import { useUiMessages } from "../intl/messages";
import { ChatContextUsage as ContextUsage } from "./ChatPrimitives";
import { executeChatAction, nextChatCommandIndex, reportChatFailure, runChatSubmission } from "./chat-behavior";
import type { ChatAction, ChatAttachment, ChatMention, ChatComposerState, ChatContextUsageData, ChatModelOption, ChatSubmitInput } from "./types";

import { chatCommandQuery, chatMentionSegments, reconcileChatMentions } from "./composer-document";

const composerMaxInputHeight = 309;
// Keep editor undo text within approximately 2 MiB, plus the current edit.
const composerUndoBudgetChars = 1_000_000;

export type ChatCommandContext = {
  setValue: (value: string) => void;
  submit: () => void;
  focus: () => void;
};

export type ChatCommand = {
  name: string;
  description: string;
  icon?: string;
  action?: (context: ChatCommandContext) => void | Promise<void>;
  /** Selecting a reference inserts its display name and retains its opaque payload. */
  mention?: ChatAttachment;
  label?: string;
  disabled?: boolean;
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
  /** Compact application-owned details immediately after the model selector. */
  modelDetails?: JSX.Element;
  commands?: readonly ChatCommand[];
  searchCommands?: (query: string, signal: AbortSignal) => Promise<readonly ChatCommand[]>;
  mentions?: readonly ChatMention[];
  onMentionsChange?: (mentions: readonly ChatMention[]) => void;
  /** Shared surface above the editor; suggestions temporarily replace this content. */
  accessory?: JSX.Element;
  contextUsage?: ChatContextUsageData;
  contextActions?: readonly ChatAction[];
  /** Optional action inside the context details popup. */
  contextPopupAction?: ChatAction;
  /** Additional compact controls rendered with the add/model controls. */
  footerTools?: JSX.Element;
  /** Compact application controls immediately before the send/stop button. */
  submitTools?: JSX.Element;
  /** Replaces footer controls during an application-owned interaction, preserving the editor. */
  footerContent?: JSX.Element;
  placeholder?: string;
  label?: string;
  inputLabel?: string;
  disabled?: boolean;
  error?: string;
  focusToken?: unknown;
  draftKey?: unknown;
  class?: string;
};

const attachmentIcon = (attachment: ChatAttachment): string =>
  attachment.icon ?? (attachment.kind === "image" ? "ti ti-photo" : attachment.kind === "resource" ? "ti ti-link" : "ti ti-file");

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const accessory = children(() => props.accessory);
  const hasAccessory = () => accessory.toArray().some(item => item != null && typeof item !== "boolean" && item !== "");
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
  const [caret, setCaret] = createSignal(0);
  const [selectionEnd, setSelectionEnd] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [searchResults, setSearchResults] = createSignal<readonly ChatCommand[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [executing, setExecuting] = createSignal(false);
  let highlightRef: HTMLDivElement | undefined;
  let commandListRef: HTMLDivElement | undefined;
  const mentions = () => props.mentions ?? [];
  const commandQuery = createMemo(() => dismissed() || composing() ? null : chatCommandQuery(props.value, caret(), selectionEnd()));
  const commandMatches = createMemo(() => {
    const token = commandQuery();
    if (!token) return [];
    return [...(props.commands ?? []).filter(command => command.name.toLowerCase().includes(token.query.toLowerCase())), ...searchResults()];
  });
  const commandsOpen = () => Boolean(commandQuery() && (props.commands?.length || props.searchCommands));
  createEffect(() => {
    if (!commandsOpen()) return;
    let disposed = false;
    const measure = () => {
      if (disposed || !commandListRef) return;
      let top = window.visualViewport?.offsetTop ?? 0;
      for (let parent = commandListRef.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(window.getComputedStyle(parent).overflowY)) {
          top = Math.max(top, parent.getBoundingClientRect().top);
        }
      }
      const bottom = commandListRef.parentElement!.getBoundingClientRect().bottom;
      commandListRef.style.setProperty("--k2b-chat-command-space", `${Math.max(40, bottom - top - 8)}px`);
    };
    queueMicrotask(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    onCleanup(() => {
      disposed = true;
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
    });
  });
  createEffect(() => {
    const token = commandQuery();
    setSearchResults([]);
    setSearchError(false);
    if (!token || !props.searchCommands) { setSearching(false); return; }
    const abort = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      Promise.resolve(props.searchCommands!(token.query, abort.signal)).then(results => {
        if (!abort.signal.aborted) setSearchResults(results);
      }).catch(() => { if (!abort.signal.aborted) setSearchError(true); }).finally(() => {
        if (!abort.signal.aborted) setSearching(false);
      });
    }, 120);
    onCleanup(() => { clearTimeout(timer); abort.abort(); });
  });
  const history: { value: string; mentions: readonly ChatMention[]; caret: number }[] = [];
  let historyIndex = -1;
  createEffect(() => { props.draftKey; untrack(() => { history.length = 0; historyIndex = -1; setDismissed(true); }); });
  const snapshot = () => ({ value: props.value, mentions: [...mentions()], caret: textareaRef?.selectionStart ?? 0 });
  const sameMentions = (a: readonly ChatMention[], b: readonly ChatMention[]) => a.length === b.length && a.every((item, index) => item.start === b[index]?.start && item.end === b[index]?.end && item.attachment === b[index]?.attachment);
  const record = () => {
    if (history[historyIndex]?.value !== props.value || !sameMentions(history[historyIndex]?.mentions ?? [], mentions())) {
      history.splice(historyIndex + 1);
      history.push(snapshot());
      let size = history.reduce((total, entry) => total + entry.value.length, 0);
      while (history.length > 2 && size > composerUndoBudgetChars) size -= history.shift()!.value.length;
      historyIndex = history.length - 1;
    }
  };
  const edit = (value: string, nextMentions = reconcileChatMentions(props.value, value, mentions())) => {
    record();
    props.onValueChange(value);
    props.onMentionsChange?.(nextMentions);
    record();
    setDismissed(false);
  };
  const restoreHistory = (direction: -1 | 1) => {
    record();
    const next = history[historyIndex + direction];
    if (!next) return;
    historyIndex += direction;
    props.onValueChange(next.value);
    props.onMentionsChange?.(next.mentions);
    queueMicrotask(() => { textareaRef?.setSelectionRange(next.caret, next.caret); syncCaret(); });
  };
  const syncCaret = () => {
    setCaret(textareaRef?.selectionStart ?? props.value.length);
    setSelectionEnd(textareaRef?.selectionEnd ?? props.value.length);
  };
  const selectedCommand = () => commandMatches()[selectedCommandIndex()];
  const blocked = () => Boolean(props.disabled || stopping() || state() === "submitting" || executing() || addingFiles() || submitting());
  const hasDraft = () => Boolean(props.value.trim() || (!running() && attachments().length > 0));
  const canSubmit = () => !blocked() && hasDraft() && !(running() && runningSubmitIntent() === "steer" && mentions().length);
  const canSelectFiles = () => Boolean(props.fileSelection && !props.fileSelection.disabled && !running() && !blocked());
  const hasAddMenu = () => Boolean(props.fileSelection || props.menuActions?.length);
  const hasContextUsage = () => {
    if (props.contextPopupAction) return true;
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
    const index = selectedCommandIndex();
    commandMatches();
    queueMicrotask(() => {
      const list = commandListRef;
      const item = list?.querySelector<HTMLElement>(`[id="${commandListId}-${index}"]`);
      if (!list || !item?.isConnected) return;
      if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
      }
    });
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
    const previousMentions = mentions();
    const input: ChatSubmitInput = {
      intent,
      text: previousValue,
      mentions: previousMentions,
      attachments: intent !== "steer" ? previousAttachments : [],
    };

    setSubmitting(true);
    try {
      await runChatSubmission({
        clear: () => {
          props.onValueChange("");
          props.onMentionsChange?.([]);
          if (intent !== "steer") setAttachments([]);
        },
        perform: () => props.onSubmit(input),
        restore: () => {
          props.onValueChange(previousValue);
          props.onMentionsChange?.(previousMentions);
          if (intent !== "steer") setAttachments(previousAttachments);
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
    const token = commandQuery();
    if (!token || command.disabled || blocked()) return;
    const previous = snapshot();
    const key = props.draftKey;
    const replacement = command.mention ? command.mention.name + " " : "";
    const nextValue = props.value.slice(0, token.start) + replacement + props.value.slice(token.end);
    const nextMentions = reconcileChatMentions(props.value, nextValue, mentions());
    if (command.mention) nextMentions.push({ start: token.start, end: token.start + command.mention.name.length, attachment: command.mention });
    edit(nextValue, nextMentions);
    setDismissed(true);
    setExecuting(true);
    let submitRequested = false;
    try {
      await command.action?.({ setValue: value => edit(value), submit: () => { submitRequested = true; }, focus });
    } catch (error) {
      submitRequested = false;
      if (props.draftKey === key && props.value === nextValue) { props.onValueChange(previous.value); props.onMentionsChange?.(previous.mentions); }
      props.onError?.(error);
    } finally { setExecuting(false); }
    if (submitRequested && props.draftKey === key) await submit();
    queueMicrotask(() => {
      if (props.draftKey !== key) return;
      textareaRef?.setSelectionRange(token.start + replacement.length, token.start + replacement.length);
      syncCaret(); autoResize(); focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || composing()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault(); restoreHistory(event.shiftKey ? 1 : -1); return;
    }
    const matches = commandMatches();
    if (commandsOpen()) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedCommandIndex((index) => nextChatCommandIndex(index, matches.length, event.key === "ArrowUp" ? -1 : 1));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && matches.length > 0) {
        event.preventDefault();
        const command = selectedCommand();
        if (command) void executeCommand(command);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div class="k2b-chat-composer-shell">
    <Show when={commandsOpen() || hasAccessory()}>
      <div class="k2b-chat-composer-slot">
      <div style={{ visibility: commandsOpen() ? "hidden" : undefined }} inert={commandsOpen()}>{accessory()}</div>
      <Show when={commandsOpen()}><div class="k2b-chat-composer-accessory">
        <div ref={commandListRef} id={commandListId} class="k2b-chat-composer__commands" role="listbox" aria-label={messages().commands}>
          <For each={commandMatches()}>{(command, index) =>
            <button id={`${commandListId}-${index()}`} type="button" role="option" tabIndex={-1}
              aria-selected={index() === selectedCommandIndex()} aria-disabled={command.disabled}
              data-active={index() === selectedCommandIndex() ? "true" : undefined}
              onPointerDown={event => event.preventDefault()} onClick={() => void executeCommand(command)}>
              <i class={command.icon ?? "ti ti-slash"} aria-hidden="true" />
              <strong>{command.label ?? `/${command.name}`}</strong><small>{command.description}</small>
            </button>
          }</For>
          <Show when={searching()}><div role="status" class="k2b-chat-composer__loading"><i class="ti ti-loader-2 k2b-spin" aria-hidden="true" /><strong>{messages().loading}</strong></div></Show>
          <Show when={searchError()}><div role="status"><i class="ti ti-alert-circle" /> {messages().error}</div></Show>
          <Show when={!searching() && !searchError() && commandMatches().length === 0}><div role="status">{messages().noResults}</div></Show>
        </div>
      </div></Show>
      </div>
    </Show>
    <section
      ref={composerRef}
      class={`k2b-chat-composer ${props.class ?? ""}`}
      data-running={running() ? "true" : undefined}
      data-drag-active={dragActive() ? "true" : undefined}
      role="group"
      aria-label={props.label ?? messages().messageComposer}
    >
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
        <Show when={mentions().length > 0}><div ref={highlightRef} class="k2b-chat-composer__highlight" aria-hidden="true">
          <For each={chatMentionSegments(props.value, mentions())}>{part => <span classList={{ "k2b-chat-composer__mention": Boolean(part.mention) }}>{part.text}</span>}</For>{"\n"}
        </div></Show>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: popup attributes are conditional with the combobox role */}
        <textarea
          ref={textareaRef}
          classList={{ "k2b-chat-composer__textarea--highlighted": mentions().length > 0 }}
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
            edit(event.currentTarget.value);
            syncCaret(); autoResize();
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
          onSelect={syncCaret}
          onBlur={() => setDismissed(true)}
          onClick={() => { setDismissed(false); syncCaret(); }}
          onKeyUp={syncCaret}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => { setComposing(false); syncCaret(); }}
          onScroll={() => { if (highlightRef && textareaRef) highlightRef.scrollTop = textareaRef.scrollTop; }}
          onBeforeInput={event => {
            if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
              event.preventDefault(); restoreHistory(event.inputType === "historyUndo" ? -1 : 1);
            }
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
        <Show
          when={props.footerContent}
          fallback={
            <>
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
                {props.modelDetails}
              </div>

              <div class="k2b-chat-composer__submit">
                <For each={props.contextActions}>
                  {(action) => (
                    <button
                      type="button"
                      class="k2b-chat-composer__icon-action"
                      data-tone={action.variant === "danger" ? "danger" : undefined}
                      disabled={action.disabled}
                      aria-pressed={action.pressed}
                      aria-label={action.label}
                      title={action.label}
                      onClick={() => reportChatFailure(() => executeChatAction(action), props.onError)}
                    >
                      <i class={action.icon ?? "ti ti-dots"} aria-hidden="true" />
                    </button>
                  )}
                </For>
                <Show when={hasContextUsage() ? (props.contextUsage ?? {}) : undefined}>
                  {(usage) => <ContextUsage {...usage()} action={props.contextPopupAction} onActionError={props.onError} />}
                </Show>
                {props.submitTools}
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
            </>
          }
        >
          {(content) => content()}
        </Show>
      </footer>
    </section>
    </div>
  );
}
