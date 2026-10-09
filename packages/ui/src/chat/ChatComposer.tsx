import {
  children,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Dropdown, type DropdownItem as DropdownItemData } from "../actions/Dropdown";
import { Tooltip } from "../feedback/Tooltip";
import { replaceTextareaRange } from "../inputs/editor-dom";
import { FileDropTarget } from "../inputs/FileDropTarget";
import { toggleBulletList, toggleCodeBlock, toggleInlineMarker, toggleQuote } from "../inputs/markdown/actions";
import { SelectChip } from "../inputs/SelectChip";
import { type UiMessages, useUiMessages } from "../intl/messages";
import { ChatContextUsage as ContextUsage } from "./ChatPrimitives";
import {
  conversationEnterAction,
  executeChatAction,
  isInsideCodeFence,
  nextChatCommandIndex,
  reportChatFailure,
  runChatSubmission,
} from "./chat-behavior";
import { chatCommandQuery, chatMentionSegments, reconcileChatMentions } from "./composer-document";
import type {
  ChatAction,
  ChatAttachment,
  ChatComposerEmoji,
  ChatComposerMicrophone,
  ChatComposerState,
  ChatContextUsageData,
  ChatMention,
  ChatModelOption,
  ChatSubmitInput,
} from "./types";

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
  /**
   * Chooses files for "Attach files" instead of the device's file dialog, for example to offer other sources as well.
   * Called within the menu activation, so it may still open the device's dialog; resolve `[]` when the user cancels.
   * `multiple: false` keeps the first chosen file, and a rejection reaches `onError`.
   */
  choose?: () => Promise<readonly File[]>;
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
  /**
   * `"conversation"` is the composer for messages between people. It starts with one line and grows to a third of
   * its nearest size container, keeps a hint line of fixed height above the field, keeps the field focused when its
   * buttons are pressed, and breaks the line on Enter inside an open code block and on touch-only devices. The
   * default is the assistant prompt.
   */
  variant?: "default" | "conversation";
  /** `"enter"` (default): Enter sends and Shift+Enter breaks the line. `"mod-enter"`: Enter breaks the line. Ctrl/⌘+Enter always sends. */
  sendKey?: "enter" | "mod-enter";
  /** Adds "Aa", which shows Markdown formatting buttons in the footer without changing the composer's height. */
  formatting?: boolean;
  /** An emoji button at a fixed place. Touch-only devices hide it; their keyboard has emoji. */
  emoji?: ChatComposerEmoji;
  /** A microphone at a fixed place: a tap dictates, holding it or its menu asks for a voice message. */
  microphone?: ChatComposerMicrophone;
  /** One line above the field. The conversation variant always keeps its height; the default shows it only with content. */
  hint?: JSX.Element;
};

type FormatTool = {
  id: string;
  icon: string;
  label: (messages: UiMessages) => string;
  run: (textarea: HTMLTextAreaElement) => void;
  /** Ctrl/⌘ plus this `event.key`. */
  key?: string;
  /** Ctrl/⌘+Shift plus this `event.code`, the physical key, so every keyboard layout agrees. */
  shiftCode?: string;
};

const insertComposerLink = (textarea: HTMLTextAreaElement): void => {
  const { value, selectionStart, selectionEnd } = textarea;
  const label = value.slice(selectionStart, selectionEnd);
  replaceTextareaRange(textarea, selectionStart, selectionEnd, `[${label}]()`);
  // Without a selection the label comes first, otherwise the address.
  const caret = label ? selectionStart + label.length + 3 : selectionStart + 1;
  textarea.setSelectionRange(caret, caret);
};

const formatTools: readonly FormatTool[] = [
  { id: "bold", icon: "ti ti-bold", label: (m) => m.boldShortcut, run: (textarea) => toggleInlineMarker(textarea, "**"), key: "b" },
  { id: "italic", icon: "ti ti-italic", label: (m) => m.italicShortcut, run: (textarea) => toggleInlineMarker(textarea, "_"), key: "i" },
  {
    id: "strikethrough",
    icon: "ti ti-strikethrough",
    label: (m) => m.strikethroughShortcut,
    run: (textarea) => toggleInlineMarker(textarea, "~~"),
    shiftCode: "KeyX",
  },
  { id: "code", icon: "ti ti-code", label: (m) => m.inlineCodeShortcut, run: (textarea) => toggleInlineMarker(textarea, "`"), key: "e" },
  { id: "code-block", icon: "ti ti-source-code", label: (m) => m.codeBlock, run: toggleCodeBlock },
  { id: "bullet-list", icon: "ti ti-list", label: (m) => m.bulletListShortcut, run: toggleBulletList, shiftCode: "Digit8" },
  { id: "quote", icon: "ti ti-quote", label: (m) => m.quote, run: toggleQuote },
  { id: "link", icon: "ti ti-link", label: (m) => m.insertLink, run: insertComposerLink },
];

const formatShortcut = (event: KeyboardEvent): FormatTool | undefined => {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return undefined;
  return formatTools.find((tool) => (event.shiftKey ? tool.shiftCode === event.code : tool.key === event.key.toLowerCase()));
};

const touchOnlyQuery = "(any-pointer: coarse) and (not (any-pointer: fine))";
const isTouchOnly = () => typeof matchMedia === "function" && matchMedia(touchOnlyQuery).matches;
/** How long a press on the microphone lasts before it asks for a voice message instead of dictation. */
const microphoneHoldMs = 500;
/** Keeps the field focused (and a phone's keyboard open) when a composer button is pressed with a mouse or finger. */
const keepFieldFocus = (event: MouseEvent) => event.preventDefault();

const attachmentIcon = (attachment: ChatAttachment): string =>
  attachment.icon ?? (attachment.kind === "image" ? "ti ti-photo" : attachment.kind === "resource" ? "ti ti-link" : "ti ti-file");

const hasContent = (items: unknown[]) => items.some((item) => item != null && typeof item !== "boolean" && item !== "");

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const accessory = children(() => props.accessory);
  const hasAccessory = () => hasContent(accessory.toArray());
  const hint = children(() => props.hint);
  const messages = useUiMessages();
  const commandListId = `k2b-chat-commands-${createUniqueId().replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const formatGroupId = `${commandListId}-format`;
  const [selectedCommandIndex, setSelectedCommandIndex] = createSignal(0);
  const [addingFiles, setAddingFiles] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  let composerRef: HTMLElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let measureRef: HTMLTextAreaElement | undefined;
  let sawRunning = props.state === "running";
  const conversation = () => props.variant === "conversation";
  const [formattingOpen, setFormattingOpen] = createSignal(false);
  const [microphoneMenuOpen, setMicrophoneMenuOpen] = createSignal(false);
  const dictation = () => props.microphone?.dictation ?? null;
  const showHint = () => conversation() || dictation() !== null || hasContent(hint.toArray());

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
  const commandQuery = createMemo(() => (dismissed() || composing() ? null : chatCommandQuery(props.value, caret(), selectionEnd())));
  const commandMatches = createMemo(() => {
    const token = commandQuery();
    if (!token) return [];
    return [
      ...(props.commands ?? []).filter((command) => command.name.toLowerCase().includes(token.query.toLowerCase())),
      ...searchResults(),
    ];
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
    if (!token || !props.searchCommands) {
      setSearching(false);
      return;
    }
    const abort = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      Promise.resolve(props.searchCommands!(token.query, abort.signal))
        .then((results) => {
          if (!abort.signal.aborted) setSearchResults(results);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchError(true);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearching(false);
        });
    }, 120);
    onCleanup(() => {
      clearTimeout(timer);
      abort.abort();
    });
  });
  const history: { value: string; mentions: readonly ChatMention[]; caret: number }[] = [];
  let historyIndex = -1;
  createEffect(() => {
    props.draftKey;
    untrack(() => {
      history.length = 0;
      historyIndex = -1;
      setDismissed(true);
    });
  });
  const snapshot = () => ({ value: props.value, mentions: [...mentions()], caret: textareaRef?.selectionStart ?? 0 });
  const sameMentions = (a: readonly ChatMention[], b: readonly ChatMention[]) =>
    a.length === b.length &&
    a.every((item, index) => item.start === b[index]?.start && item.end === b[index]?.end && item.attachment === b[index]?.attachment);
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
    queueMicrotask(() => {
      textareaRef?.setSelectionRange(next.caret, next.caret);
      syncCaret();
    });
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
        action: () => chooseFiles(),
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
    if (conversation()) {
      // A hidden copy measures the text. Collapsing the field itself would shrink the composer for a frame, and
      // WebKit then clamps the scroll position of the conversation above it. CSS caps the height.
      if (!measureRef) return;
      measureRef.value = textareaRef.value;
      textareaRef.style.height = `${measureRef.scrollHeight}px`;
      return;
    }
    textareaRef.style.height = "auto";
    textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, composerMaxInputHeight)}px`;
  };

  const focus = () => textareaRef?.focus();

  onMount(() => {
    autoResize();
    if (props.focusToken !== undefined) focus();
    // The copy follows the field's width, so a narrower composer measures more lines.
    if (measureRef && typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => autoResize());
      observer.observe(measureRef);
      onCleanup(() => observer.disconnect());
    }
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

  const chooseFiles = () => {
    const selection = props.fileSelection;
    if (!selection?.choose) return fileInputRef?.click();
    selection.choose().then(
      // A single-file composer keeps the first chosen file, as its file dialog and drops do.
      (files) => void runFiles(selection.multiple === false ? files.slice(0, 1) : files),
      (error: unknown) => (props.fileSelection?.onError ?? props.onError)?.(error),
    );
  };

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
    if (command.mention)
      nextMentions.push({ start: token.start, end: token.start + command.mention.name.length, attachment: command.mention });
    edit(nextValue, nextMentions);
    setDismissed(true);
    setExecuting(true);
    let submitRequested = false;
    try {
      await command.action?.({
        setValue: (value) => edit(value),
        submit: () => {
          submitRequested = true;
        },
        focus,
      });
    } catch (error) {
      submitRequested = false;
      if (props.draftKey === key && props.value === nextValue) {
        props.onValueChange(previous.value);
        props.onMentionsChange?.(previous.mentions);
      }
      props.onError?.(error);
    } finally {
      setExecuting(false);
    }
    if (submitRequested && props.draftKey === key) await submit();
    queueMicrotask(() => {
      if (props.draftKey !== key) return;
      textareaRef?.setSelectionRange(token.start + replacement.length, token.start + replacement.length);
      syncCaret();
      autoResize();
      focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || composing()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      restoreHistory(event.shiftKey ? 1 : -1);
      return;
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
    const format = props.formatting && textareaRef ? formatShortcut(event) : undefined;
    if (format && textareaRef) {
      event.preventDefault();
      format.run(textareaRef);
      return;
    }
    if (event.key !== "Enter") return;
    if (conversation()) {
      const action = conversationEnterAction(event, {
        sendKey: props.sendKey ?? "enter",
        touchOnly: isTouchOnly(),
        inCodeBlock: isInsideCodeFence(props.value, textareaRef?.selectionStart ?? props.value.length),
      });
      if (action === "send") {
        event.preventDefault();
        void submit();
      }
      return;
    }
    const send = props.sendKey === "mod-enter" ? event.ctrlKey || event.metaKey : !event.shiftKey;
    if (send && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const insertText = (text: string) => {
    if (!textareaRef || blocked()) return;
    replaceTextareaRange(textareaRef, textareaRef.selectionStart, textareaRef.selectionEnd, text);
  };

  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  const releaseHold = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };
  onCleanup(releaseHold);
  const microphoneDisabled = () => Boolean(props.microphone?.disabled || blocked() || dictation() === "refining");
  const microphoneItems = (): readonly DropdownItemData[] => {
    const microphone = props.microphone;
    const items: DropdownItemData[] = [];
    if (microphone?.onDictate) {
      const dictate = microphone.onDictate;
      items.push({ icon: "ti ti-microphone", label: messages().dictate, action: () => reportChatFailure(dictate, props.onError) });
    }
    if (microphone?.onVoiceMessage) {
      const record = microphone.onVoiceMessage;
      items.push({
        icon: "ti ti-player-record",
        label: messages().recordVoiceMessage,
        action: () => reportChatFailure(record, props.onError),
      });
    }
    return items;
  };
  const dictationStatus = (): { icon: string; text: string } | null => {
    switch (dictation()) {
      case "listening":
        return { icon: "ti ti-microphone", text: messages().dictationListening };
      case "refining":
        return { icon: "ti ti-loader-2 k2b-spin", text: messages().dictationRefining };
      case "refined":
        return { icon: "ti ti-sparkles", text: messages().dictationRefined };
      case "unrefined":
        return { icon: "ti ti-microphone", text: messages().dictationUnrefined };
      case "interrupted":
        return { icon: "ti ti-alert-triangle", text: messages().dictationInterrupted };
      default:
        return null;
    }
  };

  return (
    <div class="k2b-chat-composer-shell">
      <Show when={commandsOpen() || hasAccessory()}>
        <div class="k2b-chat-composer-slot">
          <div style={{ visibility: commandsOpen() ? "hidden" : undefined }} inert={commandsOpen()}>
            {accessory()}
          </div>
          <Show when={commandsOpen()}>
            <div class="k2b-chat-composer-accessory">
              <div
                ref={commandListRef}
                id={commandListId}
                class="k2b-chat-composer__commands"
                role="listbox"
                aria-label={messages().commands}
              >
                <For each={commandMatches()}>
                  {(command, index) => (
                    <button
                      id={`${commandListId}-${index()}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index() === selectedCommandIndex()}
                      aria-disabled={command.disabled}
                      data-active={index() === selectedCommandIndex() ? "true" : undefined}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => void executeCommand(command)}
                    >
                      <i class={command.icon ?? "ti ti-slash"} aria-hidden="true" />
                      <strong>{command.label ?? `/${command.name}`}</strong>
                      <small>{command.description}</small>
                    </button>
                  )}
                </For>
                <Show when={searching()}>
                  <div role="status" class="k2b-chat-composer__loading">
                    <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                    <strong>{messages().loading}</strong>
                  </div>
                </Show>
                <Show when={searchError()}>
                  <div role="status">
                    <i class="ti ti-alert-circle" /> {messages().error}
                  </div>
                </Show>
                <Show when={!searching() && !searchError() && commandMatches().length === 0}>
                  <div role="status">{messages().noResults}</div>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </Show>
      <section
        ref={composerRef}
        class={`k2b-chat-composer ${props.class ?? ""}`}
        data-running={running() ? "true" : undefined}
        data-variant={conversation() ? "conversation" : undefined}
        role="group"
        aria-label={props.label ?? messages().messageComposer}
      >
        <Show when={showHint()}>
          <div class="k2b-chat-composer__hint" aria-live="polite">
            <Show when={dictationStatus()} fallback={<span class="k2b-chat-composer__hint-text">{hint()}</span>}>
              {(status) => (
                <>
                  <span class="k2b-chat-composer__dictation" data-state={dictation() ?? undefined}>
                    <i class={status().icon} aria-hidden="true" />
                    <span>{status().text}</span>
                  </span>
                  <Show when={dictation() === "refined" ? props.microphone?.onRestoreOriginal : undefined}>
                    {(restore) => (
                      <button
                        type="button"
                        class="k2b-chat-composer__hint-action"
                        onMouseDown={keepFieldFocus}
                        onClick={() => reportChatFailure(restore(), props.onError)}
                      >
                        {messages().restoreOriginal}
                      </button>
                    )}
                  </Show>
                </>
              )}
            </Show>
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

        <div class="k2b-chat-composer__input" role="group" aria-label={messages().messageInput}>
          <Show when={mentions().length > 0}>
            <div ref={highlightRef} class="k2b-chat-composer__highlight" aria-hidden="true">
              <For each={chatMentionSegments(props.value, mentions())}>
                {(part) => <span classList={{ "k2b-chat-composer__mention": Boolean(part.mention) }}>{part.text}</span>}
              </For>
              {"\n"}
            </div>
          </Show>
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: popup attributes are conditional with the combobox role */}
          <textarea
            ref={textareaRef}
            classList={{ "k2b-chat-composer__textarea--highlighted": mentions().length > 0 }}
            rows={1}
            value={props.value}
            disabled={blocked()}
            enterkeyhint={conversation() ? "enter" : undefined}
            placeholder={
              props.placeholder ??
              (running() ? messages().addGuidance : conversation() ? messages().writeConversationMessage : messages().writeMessage)
            }
            aria-label={props.inputLabel ?? messages().message}
            role={commandsOpen() ? "combobox" : undefined}
            aria-autocomplete={commandsOpen() ? "list" : undefined}
            aria-controls={commandsOpen() ? commandListId : undefined}
            aria-expanded={commandsOpen() ? "true" : undefined}
            aria-activedescendant={selectedCommand() ? `${commandListId}-${selectedCommandIndex()}` : undefined}
            onInput={(event) => {
              edit(event.currentTarget.value);
              syncCaret();
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
            onSelect={syncCaret}
            onBlur={() => setDismissed(true)}
            onClick={() => {
              setDismissed(false);
              syncCaret();
            }}
            onKeyUp={syncCaret}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => {
              setComposing(false);
              syncCaret();
            }}
            onScroll={() => {
              if (highlightRef && textareaRef) highlightRef.scrollTop = textareaRef.scrollTop;
            }}
            onBeforeInput={(event) => {
              if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
                event.preventDefault();
                restoreHistory(event.inputType === "historyUndo" ? -1 : 1);
              }
            }}
            onKeyDown={onKeyDown}
          />
          <Show when={conversation()}>
            <textarea ref={measureRef} class="k2b-chat-composer__measure" rows={1} tabIndex={-1} aria-hidden="true" readOnly />
          </Show>
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
                    <Dropdown.Root position="top-right" label={messages().addToChat} items={menuItems()} disabled={blocked()}>
                      <Dropdown.Trigger
                        appearance="plain"
                        class="k2b-chat-composer__icon-action"
                        label={messages().addToChat}
                        tooltip={messages().addToChat}
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
                  <Show when={props.formatting}>
                    <Tooltip.Trigger
                      type="button"
                      class="k2b-chat-composer__icon-action"
                      aria-label={messages().composerFormatting}
                      aria-pressed={formattingOpen()}
                      aria-controls={formattingOpen() ? formatGroupId : undefined}
                      content={messages().composerFormatting}
                      onMouseDown={keepFieldFocus}
                      onClick={() => setFormattingOpen((open) => !open)}
                    >
                      <i class="ti ti-letter-case" aria-hidden="true" />
                    </Tooltip.Trigger>
                  </Show>
                  <Show when={props.emoji}>
                    {(emoji) => (
                      <Tooltip.Trigger
                        type="button"
                        class="k2b-chat-composer__icon-action k2b-chat-composer__emoji"
                        aria-label={messages().insertEmoji}
                        content={messages().insertEmoji}
                        disabled={blocked()}
                        onMouseDown={keepFieldFocus}
                        onClick={(event) => {
                          const anchor = event.currentTarget;
                          reportChatFailure(() => emoji().onOpen({ anchor, insert: insertText }), props.onError);
                        }}
                      >
                        <i class="ti ti-mood-smile" aria-hidden="true" />
                      </Tooltip.Trigger>
                    )}
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
                  <Show when={props.formatting && formattingOpen()}>
                    <div id={formatGroupId} class="k2b-chat-composer__format" role="group" aria-label={messages().composerFormatting}>
                      <For each={formatTools}>
                        {(tool) => (
                          <Tooltip.Trigger
                            type="button"
                            class="k2b-chat-composer__icon-action"
                            aria-label={tool.label(messages())}
                            content={tool.label(messages())}
                            disabled={blocked()}
                            onMouseDown={keepFieldFocus}
                            onClick={() => {
                              if (textareaRef) tool.run(textareaRef);
                            }}
                          >
                            <i class={tool.icon} aria-hidden="true" />
                          </Tooltip.Trigger>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <div class="k2b-chat-composer__submit">
                  <For each={props.contextActions}>
                    {(action) => (
                      <Tooltip.Trigger
                        type="button"
                        class="k2b-chat-composer__icon-action"
                        data-tone={action.variant === "danger" ? "danger" : undefined}
                        disabled={action.disabled}
                        aria-pressed={action.pressed}
                        aria-label={action.label}
                        content={action.label}
                        onClick={() => reportChatFailure(() => executeChatAction(action), props.onError)}
                      >
                        <i class={action.icon ?? "ti ti-dots"} aria-hidden="true" />
                      </Tooltip.Trigger>
                    )}
                  </For>
                  <Show when={hasContextUsage() ? (props.contextUsage ?? {}) : undefined}>
                    {(usage) => <ContextUsage {...usage()} action={props.contextPopupAction} onActionError={props.onError} />}
                  </Show>
                  {props.submitTools}
                  <Show when={props.microphone?.onDictate || props.microphone?.onVoiceMessage ? props.microphone : undefined}>
                    {(microphone) => (
                      <div class="k2b-chat-composer__microphone">
                        <Tooltip.Trigger
                          type="button"
                          class="k2b-chat-composer__icon-action k2b-chat-composer__microphone-button"
                          data-state={dictation() ?? undefined}
                          disabled={microphoneDisabled()}
                          aria-pressed={microphone().onDictate ? dictation() === "listening" : undefined}
                          aria-haspopup={microphone().onDictate ? undefined : "menu"}
                          // A toggle keeps its name; the pressed state says that dictation runs.
                          aria-label={microphone().onDictate ? messages().dictate : messages().recordVoiceMessage}
                          content={
                            dictation() === "listening"
                              ? messages().stopDictation
                              : microphone().onDictate
                                ? microphone().onVoiceMessage
                                  ? messages().dictateOrHold
                                  : messages().dictate
                                : messages().recordVoiceMessage
                          }
                          onMouseDown={keepFieldFocus}
                          onContextMenu={(event) => event.preventDefault()}
                          onPointerDown={(event) => {
                            held = false;
                            releaseHold();
                            const record = microphone().onVoiceMessage;
                            if (event.button !== 0 || !record || dictation() === "listening") return;
                            holdTimer = setTimeout(() => {
                              held = true;
                              reportChatFailure(record, props.onError);
                            }, microphoneHoldMs);
                          }}
                          onPointerUp={releaseHold}
                          onPointerCancel={releaseHold}
                          onPointerLeave={releaseHold}
                          onClick={(event) => {
                            // A press that already asked for a voice message ends here; a key press never holds.
                            if (held) {
                              held = false;
                              if (event.detail > 0) return;
                            }
                            const dictate = microphone().onDictate;
                            if (dictate) reportChatFailure(dictate, props.onError);
                            else setMicrophoneMenuOpen(true);
                          }}
                        >
                          <i
                            class={
                              dictation() === "listening"
                                ? "ti ti-player-stop"
                                : dictation() === "refining"
                                  ? "ti ti-loader-2 k2b-spin"
                                  : "ti ti-microphone"
                            }
                            aria-hidden="true"
                          />
                        </Tooltip.Trigger>
                        <Show when={microphone().onVoiceMessage}>
                          <Dropdown.Root
                            position="top-left"
                            label={messages().microphoneOptions}
                            items={microphoneItems()}
                            disabled={microphoneDisabled()}
                            open={microphoneMenuOpen()}
                            onOpenChange={setMicrophoneMenuOpen}
                          >
                            <Dropdown.Trigger
                              appearance="plain"
                              class="k2b-chat-composer__icon-action k2b-chat-composer__microphone-menu"
                              label={messages().microphoneOptions}
                              tooltip={messages().microphoneOptions}
                            >
                              <i class="ti ti-chevron-up" aria-hidden="true" />
                            </Dropdown.Trigger>
                          </Dropdown.Root>
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show
                    when={running() && !hasDraft() && props.onStop}
                    fallback={
                      <Tooltip.Trigger
                        type="button"
                        class="k2b-chat-composer__send"
                        disabled={!canSubmit()}
                        onMouseDown={(event) => {
                          if (conversation()) keepFieldFocus(event);
                        }}
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
                        content={
                          running()
                            ? runningSubmitIntent() === "queue"
                              ? messages().queueMessage
                              : messages().steerResponse
                            : messages().sendMessage
                        }
                        onClick={() => void submit()}
                      >
                        <i class={submitting() ? "ti ti-loader-2 k2b-spin" : "ti ti-arrow-up"} aria-hidden="true" />
                      </Tooltip.Trigger>
                    }
                  >
                    <Tooltip.Trigger
                      type="button"
                      class="k2b-chat-composer__stop"
                      disabled={stopping()}
                      aria-label={stopping() ? messages().stopping : messages().stopResponse}
                      content={messages().stopResponse}
                      onClick={() => reportChatFailure(() => props.onStop?.(), props.onError)}
                    >
                      <i class={stopping() ? "ti ti-loader-2 k2b-spin" : "ti ti-player-stop"} aria-hidden="true" />
                    </Tooltip.Trigger>
                  </Show>
                </div>
              </>
            }
          >
            {(content) => content()}
          </Show>
        </footer>
        {/* Files dropped anywhere in the surrounding workspace area attach to the message. */}
        <Show when={props.fileSelection}>
          {(selection) => (
            <FileDropTarget
              label={messages().dropFilesToAttach}
              accept={selection().accept}
              multiple={selection().multiple}
              disabled={!canSelectFiles()}
              onDrop={(files) => void runFiles(files)}
            />
          )}
        </Show>
      </section>
    </div>
  );
}
