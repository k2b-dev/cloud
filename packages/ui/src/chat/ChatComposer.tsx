import {
  batch,
  children,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Dropdown, type DropdownItem as DropdownItemData } from "../actions/Dropdown";
import { dialogHistorySettled, holdDialogHistory } from "../feedback/dialog-core";
import { Tooltip } from "../feedback/Tooltip";
import { replaceTextareaRange } from "../inputs/editor-dom";
import {
  completedEmojiShortcode,
  type EmojiIndex,
  emojiInTone,
  emojiName,
  emojiShortcodeQuery,
  loadEmojiIndex,
  suggestEmoji,
} from "../inputs/emoji/emoji-index";
import { FileDropTarget } from "../inputs/FileDropTarget";
import { toggleBulletList, toggleInlineMarker } from "../inputs/markdown/actions";
import { openCodeFence } from "../inputs/markdown/code-zone";
import { type MarkdownToolbarMessages, useMarkdownToolbarMessages } from "../inputs/markdown/toolbar-messages";
import { SelectChip } from "../inputs/SelectChip";
import { useSelectMessages } from "../inputs/select-messages";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { ChatContextUsage as ContextUsage } from "./ChatPrimitives";
import {
  chatCommandKey,
  conversationEnterAction,
  executeChatAction,
  nextChatCommandIndex,
  reportChatFailure,
  runChatSubmission,
} from "./chat-behavior";
import { useChatMessages } from "./chat-messages";
import { chatCommandListModel, parseChatCommandQuery } from "./command-search";
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
const commandDoneMs = 3_000;
/** Emoji suggestions for a `:shortcode`, as many as fit the list without scrolling on a phone. */
const emojiSuggestionLimit = 8;
// Keep editor undo text within approximately 2 MiB, plus the current edit.
const composerUndoBudgetChars = 1_000_000;

export type ChatCommandContext = {
  setValue: (value: string) => void;
  submit: () => void;
  focus: () => void;
  openModelSelection: () => Promise<string | null>;
};

/**
 * An action can cancel and restore its token, report a short completion message, or hand back a reference chosen in a
 * dialog: `mention` takes the token's place exactly as a `mention` row does, and Ctrl/⌘+Z brings the token back.
 */
export type ChatCommandResult = void | "cancelled" | { done: string } | { mention: ChatAttachment };

/** The draft as a successful `open` leaves it: without the `/…` token, with its references moved along. Save this one. */
export type ChatCommandDraft = { value: string; mentions: readonly ChatMention[] };

/**
 * How an `open` row ends: on success (`void`) the token leaves as for an action; `"cancelled"` changes nothing; `failed`
 * keeps the list open and the draft unchanged, and its text replaces the row's description until the row runs again.
 */
export type ChatCommandOpenResult = void | "cancelled" | { failed: string };

/** A fixed place in the slash list. Sections keep the given order, also while searching. */
export type ChatCommandSection = {
  id: string;
  label: string;
  /** Rows come from `searchCommands`: loading keeps a heading spinner; empty placeholders reserve the first search or retained rows. */
  searched?: boolean;
  /** Only while searching or narrowed: absent from the overview (empty query), including its loading placeholder. */
  searchOnly?: boolean;
  /** Only in the overview (empty query, no scope): absent while searching or narrowed, such as recently used rows. */
  overviewOnly?: boolean;
  /**
   * Its local rows are fixed when the list opens: a row that arrives while the list is open waits for the next opening,
   * so a section above others whose rows load in the background never pushes a visible row down. Rows that go away
   * still leave at once.
   */
  fixedWhileOpen?: boolean;
  /**
   * Local rows still on their way, such as Commands from a catalog: the section ends with placeholder rows, three in
   * the overview and one while searching, and its heading shows a spinner. Make it the last section, so rows that
   * arrive only fill the end of the list and no visible row moves.
   */
  pending?: boolean;
};
/** First-word narrowing; Tab writes `words[0]` followed by a space. */
export type ChatCommandScope = { id: string; title: string; words: readonly string[] };
/** Passed as the third argument to `searchCommands`. */
export type ChatCommandSearch = {
  scope?: string;
  /** One list opening, unchanged across queries and narrowing; retries start another opening. */
  opening: number;
};

export type ChatCommand = {
  /** Section id; unknown or missing ids render in a trailing part without a heading. */
  section?: string;
  /** Tab writes this scope's first word; a row without an action or mention also narrows on Enter. */
  scope?: string;
  /** Absent from the overview; appears when searched, including its unavailable reason. */
  hiddenUntilSearch?: boolean;
  /** A chosen value, independent of the row marked by keyboard navigation. */
  selected?: boolean;
  /** Retry discovery in a new opening, retaining the token and currently displayed rows. */
  searchAgain?: boolean;
  /** Stays in every search of its section, after the matches, such as a row that retries loading the section. */
  persistent?: boolean;
  /** Application name, searchable but not displayed. */
  app?: string;
  /**
   * Used recently by this person. While searching, a matching row moves one step up the ranking ladder of its section
   * and comes before rows of equal rank. The overview keeps consumer order.
   */
  recent?: boolean;
  /** Stable row key for option ids, marking and de-duplication. Defaults to `name`. */
  id?: string;
  name: string;
  description: string;
  icon?: string;
  /** Extra search words, for example in German and English. */
  keywords?: readonly string[];
  /** Unavailable now; this short reason replaces the description. */
  reason?: string;
  /** Shown in the status line while the action runs. */
  busyLabel?: string;
  /** Failures restore an unchanged draft and appear once in the status line, without calling `onError`. */
  action?: (context: ChatCommandContext) => ChatCommandResult | Promise<ChatCommandResult>;
  /**
   * Leaves the composer, such as opening another app. Runs with the token and the list in place: the row shows
   * `busyLabel` (default "Opening …") with a spinner instead of its description, and editing waits. A rejection ends like
   * an action's: the token stays, the list closes and the status line names the reason. Closing the list, such as with
   * Escape, cancels: `signal` aborts and the row ends at once. `signal` also aborts when the opening ends any other way
   * than by success, so the opener can save the draft with its token again. A new `draftKey` cancels too, unless the
   * opener calls `follow()` right before changing it itself: that next change keeps the opening, moves its busy line
   * to the status line, and Escape still cancels. See `ChatCommandOpenResult`.
   */
  open?: (draft: ChatCommandDraft, signal: AbortSignal, follow: () => void) => Promise<ChatCommandOpenResult>;
  /** Selecting a reference inserts its display name and retains its opaque payload. */
  mention?: ChatAttachment;
  /**
   * Opens the composer's own file selection, as "Attach files" in the add menu does, within the key or click that chose
   * the row, so the device's file dialog can still open. The token leaves; choosing nothing brings it back.
   */
  attachFiles?: boolean;
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

export type ChatComposerReply = {
  /** Name of the answered message's author. */
  author: string;
  /** Plain text of the answered message; it shows at most two lines. */
  text: string;
  onCancel: () => void;
  onSelect?: () => void;
};

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
  /** The add menu's entries after "Attach files". Not shown with `addOpensCommands`. */
  menuActions?: readonly ChatAction[];
  /**
   * "+" opens the slash list with a search field on top instead of the add menu, for keyboards where "/" is hard to
   * reach, such as a phone's. The search field filters, narrows and chooses as typing after "/" does, and a reference
   * lands where the field's caret was when "+" was pressed. Escape, "+" again, Back on a phone or a press outside
   * closes the list without acting on what lies below, and the field gets its focus and selection back. `menuActions`
   * do not show then: offer them as `commands`, and file selection as a row with `attachFiles`.
   */
  addOpensCommands?: boolean;
  models?: readonly ChatModelOption[];
  selectedModelId?: string | null;
  onModelChange?: (modelId: string) => void;
  /** Compact application-owned details immediately after the model selector. */
  modelDetails?: JSX.Element;
  commands?: readonly ChatCommand[];
  commandSections?: readonly ChatCommandSection[];
  commandScopes?: readonly ChatCommandScope[];
  searchCommands?: (query: string, signal: AbortSignal, search: ChatCommandSearch) => Promise<readonly ChatCommand[]>;
  /**
   * The last row for typed text or a scope, built at once from the query, such as "Search Cloud for “q3”". It is no
   * match: unscoped it follows "Nothing found for …"; in a scope it ends the scope's rows. Not called for the overview.
   */
  commandFallback?: (search: { query: string; scope?: string }) => ChatCommand | undefined;
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
   * `"conversation"` is the composer for messages between people: one row with attach, a pill-shaped field and Send,
   * without the assistant prompt's footer. The field starts with one line and grows to a third of its nearest size
   * container, a hint line of fixed height sits above it, its buttons keep it focused, and Enter breaks the line
   * inside an open code block and on touch-only devices. The default is the assistant prompt.
   */
  variant?: "default" | "conversation";
  /** `"enter"` (default): Enter sends and Shift+Enter breaks the line. `"mod-enter"`: Enter breaks the line. Ctrl/⌘+Enter always sends. */
  sendKey?: "enter" | "mod-enter";
  /**
   * Adds "Aa", which opens one row above the field with Bold, Italic and Bullet list (Ctrl/⌘+B, Ctrl/⌘+I, Ctrl/⌘+Shift+8);
   * the field and its controls stay put. Other Markdown is typed by hand.
   */
  formatting?: boolean;
  /** An emoji button at a fixed place. Touch-only devices hide it; their keyboard has emoji. */
  emoji?: ChatComposerEmoji;
  /** A microphone at a fixed place: a tap dictates, holding it or its menu asks for a voice message. */
  microphone?: ChatComposerMicrophone;
  /** One line above the field. The conversation variant always keeps its height; the default shows it only with content. */
  hint?: JSX.Element;
  /**
   * The message this draft answers, shown above the field on the same quiet tint as a quote in a message, with a
   * button that cancels the reply. `onSelect` makes the quote a button, for example to jump to the original.
   */
  reply?: ChatComposerReply;
};

type FormatTool = {
  id: string;
  icon: string;
  label: (messages: MarkdownToolbarMessages) => string;
  run: (textarea: HTMLTextAreaElement) => void;
  /** Ctrl/⌘ plus this `event.key`. */
  key?: string;
  /** Ctrl/⌘+Shift plus this `event.code`, the physical key, so every keyboard layout agrees. */
  shiftCode?: string;
};

/** The row stays short: what a chat message needs. Other Markdown, typed by hand, keeps working. */
const formatTools: readonly FormatTool[] = [
  { id: "bold", icon: "ti ti-bold", label: (m) => m.boldShortcut, run: (textarea) => toggleInlineMarker(textarea, "**"), key: "b" },
  { id: "italic", icon: "ti ti-italic", label: (m) => m.italicShortcut, run: (textarea) => toggleInlineMarker(textarea, "*"), key: "i" },
  { id: "bullet-list", icon: "ti ti-list", label: (m) => m.bulletListShortcut, run: toggleBulletList, shiftCode: "Digit8" },
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
/**
 * Keeps one tap from reaching the page: its pointer, touch and mouse events stop at the window, and neither focus nor a
 * click happens. A finger's tap ends with `touchend`, a scroll with `pointercancel`, a mouse's press with `click`.
 */
const swallowTap = (down: PointerEvent) => {
  const blocked = ["pointerup", "pointercancel", "touchstart", "touchend", "mousedown", "mouseup", "click", "contextmenu"] as const;
  const stop = () => {
    window.removeEventListener("pointerdown", next, true);
    for (const type of blocked) window.removeEventListener(type, block, true);
  };
  const block = (event: Event) => {
    event.stopPropagation();
    if (event.type !== "pointercancel" && event.type !== "touchstart" && event.type !== "pointerup") event.preventDefault();
    if (event.type === "click" || event.type === "touchend" || event.type === "pointercancel") stop();
  };
  // The next press is a new gesture, whatever became of this one.
  const next = (event: Event) => {
    if (event !== down) stop();
  };
  down.stopPropagation();
  down.preventDefault();
  window.addEventListener("pointerdown", next, true);
  for (const type of blocked) window.addEventListener(type, block, { capture: true, passive: false });
};

const attachmentIcon = (attachment: ChatAttachment): string =>
  attachment.icon ?? (attachment.kind === "image" ? "ti ti-photo" : attachment.kind === "resource" ? "ti ti-link" : "ti ti-file");

const hasContent = (items: unknown[]) => items.some((item) => item != null && typeof item !== "boolean" && item !== "");

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const accessory = children(() => props.accessory);
  const hasAccessory = () => hasContent(accessory.toArray());
  const hint = children(() => props.hint);
  const footer = children(() => props.footerContent);
  const messages = useUiMessages();
  const markdownToolbarMessages = useMarkdownToolbarMessages();
  const chatMessages = useChatMessages();
  const selectMessages = useSelectMessages();
  const commandListId = `k2b-chat-commands-${createUniqueId().replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const formatGroupId = `${commandListId}-format`;
  // Emoji suggestions keep their index-based selection and ids.
  const [selectedCommandIndex, setSelectedCommandIndex] = createSignal(0);
  const [activeCommandKey, setActiveCommandKey] = createSignal<string>();
  const [commandMoved, setCommandMoved] = createSignal(false);
  const commandIds = new Map<string, number>();
  let commandIdCounter = 0;
  const commandOptionId = (command: ChatCommand) => {
    const key = chatCommandKey(command);
    if (!commandIds.has(key)) commandIds.set(key, commandIdCounter++);
    return `${commandListId}-c${commandIds.get(key)}`;
  };
  const [closedAt, setClosedAt] = createSignal<number>();
  /** The list opened from "+": the field's selection when "+" was pressed, and the search field's text. */
  const [addSearch, setAddSearch] = createSignal<{ start: number; end: number }>();
  const [addQuery, setAddQuery] = createSignal("");
  let addSearchRef: HTMLInputElement | undefined;
  let addButtonRef: HTMLButtonElement | undefined;
  let addComposing = false;
  /** The `open` row running now, and why `open` rows failed in this opening, by row key. */
  const [openingRow, setOpeningRow] = createSignal<string>();
  const [openFailures, setOpenFailures] = createSignal<Readonly<Record<string, string>>>({});
  /** Cancels the `open` row running now; `key` follows announced draft moves, `label` is its busy line. */
  let openingRun: { controller: AbortController; key: unknown; label: string; follow: boolean; moved: boolean } | undefined;
  // Where the pending native edit starts; a selection replaced as a whole starts at its beginning.
  let inputStart: number | undefined;
  let inputEnd: number | undefined;
  const [commandStatus, setCommandStatus] = createSignal<{ tone: "busy" | "done" | "error"; text: string }>();
  const [announcement, setAnnouncement] = createSignal<{ text: string }>();
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const showCommandStatus = (status?: { tone: "busy" | "done" | "error"; text: string }) => {
    if (disposed) return;
    clearTimeout(statusTimer);
    setCommandStatus(status);
    if (status?.tone === "done") {
      statusTimer = setTimeout(() => setCommandStatus(undefined), commandDoneMs);
    }
  };
  onCleanup(() => {
    disposed = true;
    clearTimeout(statusTimer);
  });
  const [addingFiles, setAddingFiles] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  let shellRef: HTMLDivElement | undefined;
  let composerRef: HTMLElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let measureRef: HTMLTextAreaElement | undefined;
  let microphoneRef: HTMLDivElement | undefined;
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
  const [searchResultsQuery, setSearchResultsQuery] = createSignal<string>();
  const [searchResultsScope, setSearchResultsScope] = createSignal<string>();
  const [suggestionAnnouncement, setSuggestionAnnouncement] = createSignal<{ text: string }>();
  const [searching, setSearching] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [executing, setExecuting] = createSignal(false);
  const [modelOpen, setModelOpen] = createSignal<boolean>();
  const [choosingModel, setChoosingModel] = createSignal(false);
  let resolveModel: ((id: string | null) => void) | undefined;
  const finishModelSelection = (id: string | null) => {
    const resolve = resolveModel;
    resolveModel = undefined;
    if (choosingModel()) {
      setModelOpen(false);
      // Let the controlled close reach Dropdown before returning normal clicks to its own state.
      queueMicrotask(() => {
        if (!choosingModel()) setModelOpen(undefined);
      });
    }
    setChoosingModel(false);
    resolve?.(id);
  };
  const blockedBesidesCommand = () => Boolean(props.disabled || stopping() || state() === "submitting" || addingFiles() || submitting());
  const usableModelControl = () =>
    !conversation() && !footer() && !blockedBesidesCommand() && !running() && Boolean(props.models?.length && props.onModelChange);
  const openModelSelection = (): Promise<string | null> => {
    if (!usableModelControl()) return Promise.resolve(null);
    finishModelSelection(null);
    return new Promise((resolve) => {
      resolveModel = resolve;
      setChoosingModel(true);
      setModelOpen(true);
      queueMicrotask(() => {
        if (!choosingModel() || !modelOpen()) return;
        // Start on the current model, as a click on the chip would show it checked.
        const menu = composerRef?.querySelector(".k2b-chat-composer__model");
        (
          menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)') ??
          menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')
        )?.focus();
      });
    });
  };
  createEffect(() => {
    if (!usableModelControl()) finishModelSelection(null);
  });
  onCleanup(() => finishModelSelection(null));
  const [commandOpening, setCommandOpening] = createSignal(0);
  let retrySearch = false;
  let highlightRef: HTMLDivElement | undefined;
  let commandListRef: HTMLDivElement | undefined;
  const mentions = () => props.mentions ?? [];
  const locale = useLocale();
  const [emojiIndex, setEmojiIndex] = createSignal<EmojiIndex>();
  const emojiQuery = createMemo(() =>
    !props.emoji || dismissed() || composing() ? null : emojiShortcodeQuery(props.value, caret(), selectionEnd()),
  );
  // The emoji data loads with the first `:shortcode`; a failed load only means no suggestions.
  createEffect(() => {
    if (emojiQuery() && !emojiIndex()) loadEmojiIndex().then(setEmojiIndex, () => undefined);
  });
  const emojiMatches = createMemo(() => {
    const token = emojiQuery();
    const index = emojiIndex();
    return token && index ? suggestEmoji(index, token.query, emojiSuggestionLimit) : [];
  });
  const emojiOpen = () => emojiMatches().length > 0;
  // From "+", the search field's text is the query of an empty token at the field's stored caret.
  const caretCommandToken = createMemo(() => {
    const search = addSearch();
    if (!search) return chatCommandQuery(props.value, caret(), selectionEnd());
    const at = Math.min(search.end, props.value.length);
    return { start: at, end: at, query: addQuery() };
  });
  const caretCommandStart = createMemo(() => caretCommandToken()?.start);
  // Retained server rows belong to one `/`: they go when it does or when another `/` starts.
  createEffect(() => {
    caretCommandStart();
    setSearchResults([]);
    setSearchResultsQuery(undefined);
  });
  // Escape closes the list for one `/` character, wherever the caret or selection goes; only that `/` going away ends it.
  createEffect(() => {
    const closed = closedAt();
    if (closed !== undefined && props.value[closed] !== "/") setClosedAt(undefined);
  });
  const commandQuery = createMemo(() => {
    const token = caretCommandToken();
    if (addSearch()) return token;
    return dismissed() || composing() || token?.start === closedAt() ? null : token;
  });
  const openingStart = createMemo(() => commandQuery()?.start);
  createEffect(() => {
    props.draftKey;
    const start = openingStart();
    if (start !== undefined) setCommandOpening((opening) => opening + 1);
  });
  // A failed `open` row says so for the rest of its list opening.
  createEffect(() => {
    props.draftKey;
    commandOpening();
    setOpenFailures({});
  });
  const parsedCommandQuery = createMemo(() => parseChatCommandQuery(commandQuery()?.query ?? "", props.commandScopes ?? []));
  const commandFallbackRow = createMemo(() => {
    const parsed = parsedCommandQuery();
    const query = parsed.query.trim();
    return commandQuery() && (query || parsed.scope) ? props.commandFallback?.({ query, scope: parsed.scope?.id }) : undefined;
  });
  const currentCommandScope = createMemo(() => parsedCommandQuery().scope?.id);
  createEffect(() => {
    currentCommandScope();
    setSearchResults([]);
    setSearchResultsQuery(undefined);
  });
  // Rows of a `fixedWhileOpen` section are the ones it had when this `/` opened the list; later ones wait for the next
  // `/`. A retry row starts another opening in the same open list, so it does not count.
  const fixedCommandKeys = createMemo(() => {
    props.draftKey;
    if (openingStart() === undefined) return undefined;
    return untrack(() => {
      const fixed = new Set((props.commandSections ?? []).filter((section) => section.fixedWhileOpen).map((section) => section.id));
      return fixed.size
        ? new Set((props.commands ?? []).filter((command) => fixed.has(command.section ?? "")).map(chatCommandKey))
        : undefined;
    });
  });
  const localCommands = createMemo(() => {
    const commands = props.commands ?? [];
    const keys = fixedCommandKeys();
    if (!keys) return commands;
    const fixed = new Set((props.commandSections ?? []).filter((section) => section.fixedWhileOpen).map((section) => section.id));
    return commands.filter((command) => !fixed.has(command.section ?? "") || keys.has(chatCommandKey(command)));
  });
  const commandModel = createMemo(() =>
    chatCommandListModel({
      query: commandQuery()?.query ?? "",
      scopes: props.commandScopes,
      sections: props.commandSections,
      commands: localCommands(),
      searchResults: searchResultsScope() === parsedCommandQuery().scope?.id ? searchResults() : [],
      searchResultsFresh: searchResultsQuery() === commandQuery()?.query && searchResultsScope() === parsedCommandQuery().scope?.id,
      searchSettled: searchResultsQuery() !== undefined && searchResultsScope() === parsedCommandQuery().scope?.id,
      searching: searching(),
      fallback: commandFallbackRow(),
    }),
  );
  const commandMatches = createMemo(() => (commandQuery() ? commandModel().rows.map((row) => row.command) : []));
  /** Rows that matched; an unscoped fallback row only follows them. */
  const foundCommandCount = () => commandMatches().length - (commandModel().fallback ? 1 : 0);
  const currentCommandQuery = createMemo(() => caretCommandToken()?.query);
  // Arrow marking belongs to one token in one draft; another draft or `/` starts at the top row again.
  createEffect(() => {
    props.draftKey;
    caretCommandStart();
    currentCommandQuery();
    setCommandMoved(false);
  });
  const commandsOpen = () =>
    Boolean(!emojiOpen() && commandQuery() && (localCommands().length || props.searchCommands || commandFallbackRow()));
  // Rows that arrive for a pending section never move a visible row of the overview: until the person types, the list
  // keeps the height it had with its placeholders and scrolls what does not fit. A list below its maximum height grows
  // upward from the field, so a change of height alone would move its first row. While searching, the rows arrive
  // with the search's own answer, which changes the list anyway.
  // From "+", the whole panel keeps the height it opened with instead.
  const commandsPending = createMemo(
    () =>
      commandsOpen() &&
      !addSearch() &&
      !parsedCommandQuery().scope &&
      !parsedCommandQuery().query.trim() &&
      commandModel().groups.some((group) => group.pendingRows > 0),
  );
  // Typing, another opening or closing the list lets it size itself again.
  const commandListSizeKey = createMemo(() => (commandsOpen() ? `${commandOpening()}\u0000${caretCommandToken()?.query}` : undefined));
  // The list's height with its placeholders, for the size key it was measured under.
  let pendingList: { height: number; key: string | undefined } | undefined;
  createEffect(() => {
    const list = commandListRef;
    if (!commandsPending() || !list || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      pendingList = { height: list.getBoundingClientRect().height, key: untrack(commandListSizeKey) };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });
  createEffect(
    on(commandsPending, (pending, wasPending) => {
      const held = pendingList;
      pendingList = undefined;
      // Only rows arriving hold the list; the person's typing or closing it does not.
      if (pending || !wasPending || !held || held.key !== commandListSizeKey() || !commandListRef?.isConnected) return;
      commandListRef.style.height = `${held.height}px`;
      commandListRef.setAttribute("data-held", "");
    }),
  );
  createEffect(
    on(
      commandListSizeKey,
      () => {
        commandListRef?.style.removeProperty("height");
        commandListRef?.removeAttribute("data-held");
      },
      { defer: true },
    ),
  );
  // Escape, a press outside, or moving the caret away closes the list; while an `open` row runs, that cancels it, so
  // nothing opens after the person backed out. Success ends the opening and closes the list in one step. A new draft
  // cancels too, unless the opener announced that next move with `follow()`: its busy line moves to the status line,
  // and Escape still cancels there. Any later unannounced draft change cancels.
  createEffect(() => {
    const draftKey = props.draftKey;
    const open = commandsOpen();
    const row = openingRow();
    const run = openingRun;
    if (!run || row === undefined) return;
    if (draftKey !== run.key) {
      if (run.follow) {
        run.follow = false;
        run.key = draftKey;
        run.moved = true;
        showCommandStatus({ tone: "busy", text: run.label });
      } else run.controller.abort();
      return;
    }
    if (!open && !run.moved) run.controller.abort();
  });
  onCleanup(() => openingRun?.controller.abort());
  // An `open` row gives the sheet's Back entry up first, so it never races the navigation it starts.
  const commandSheetHeld = createMemo(() => commandsOpen() && isTouchOnly() && openingRow() === undefined);
  createEffect(() => {
    if (!commandSheetHeld()) return;
    onCleanup(holdDialogHistory(() => closeCommandList()));
  });
  const suggestionsOpen = () => commandsOpen() || emojiOpen();
  const fieldOwnsList = () => suggestionsOpen() && !addSearch();
  // From "+", the panel keeps the height it opened with while the person types or rows arrive, so neither the search
  // field nor the first row moves; what does not fit scrolls. The space above the field still bounds it.
  const addPanelOpen = createMemo(() => addSearch() !== undefined && commandsOpen());
  createEffect(() => {
    const accessory = addPanelOpen() ? commandListRef?.parentElement : undefined;
    if (!accessory) return;
    const frame = requestAnimationFrame(() =>
      accessory.style.setProperty("--k2b-chat-command-held", `${accessory.getBoundingClientRect().height}px`),
    );
    onCleanup(() => cancelAnimationFrame(frame));
  });
  createEffect(() => {
    if (!suggestionsOpen()) return;
    let disposed = false;
    const measure = () => {
      if (disposed || !commandListRef) return;
      const accessory = commandListRef.parentElement!;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      let top = viewportTop;
      // The column a phone sheet spans: the nearest ancestor that clips sideways, or the page.
      let column: { left: number; right: number } | undefined;
      for (let parent = accessory.parentElement; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, parent.getBoundingClientRect().top);
        }
        if (!column && /(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          const left = parent.getBoundingClientRect().left + parent.clientLeft;
          column = { left, right: left + parent.clientWidth };
        }
      }
      const page = document.documentElement.clientWidth;
      const left = Math.max(0, column?.left ?? 0);
      const right = Math.min(page, column?.right ?? page);
      const slot = accessory.parentElement!.getBoundingClientRect();
      // From its place in the slot, not its box: the sheet opened from "+" rises into place, and a box measured during
      // that animation would include its offset.
      const bottom = slot.bottom - (Number.parseFloat(window.getComputedStyle(accessory).bottom) || 0);
      // On the accessory, so a panel opened from "+" is bounded as a whole, with its search field.
      accessory.style.setProperty("--k2b-chat-command-space", `${Math.max(40, bottom - top - 8)}px`);
      // Only a list that reaches the screen's top edge keeps clear of a notch or the status bar.
      accessory.style.setProperty("--k2b-chat-command-safe-top", top === viewportTop ? "env(safe-area-inset-top, 0px)" : "0px");
      accessory.style.setProperty("--k2b-chat-command-reach-left", `${Math.max(0, slot.left - left)}px`);
      accessory.style.setProperty("--k2b-chat-command-reach-right", `${Math.max(0, right - slot.right)}px`);
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
  // A press outside the command list and the field closes the list, as Escape does; the text stays. With a mouse or a
  // trackpad the press then acts as usual. On a touch-only device a tap outside the composer closes only the list: it
  // reaches nothing beneath, and the field keeps focus, so the keyboard stays open.
  // A list opened from "+" is a menu: any press outside it closes only the list, with every pointer, and the field gets
  // its focus back. "+" itself toggles with its click; a press in the field closes the list and lands there as usual.
  createEffect(() => {
    if (!commandsOpen()) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || commandListRef?.parentElement?.contains(target)) return;
      if (addSearch()) {
        if (addButtonRef?.contains(target) && !addButtonRef.disabled) return;
        if (textareaRef?.parentElement?.contains(target)) {
          // The field takes the focus before the search field goes, so a phone keeps its keyboard; the press itself
          // then places the caret.
          textareaRef.focus({ preventScroll: true });
          endAddSearch(false);
          return;
        }
        swallowTap(event);
        endAddSearch(true);
        return;
      }
      if (textareaRef?.parentElement?.contains(target)) return;
      setClosedAt(commandQuery()?.start);
      if (isTouchOnly() && !shellRef?.contains(target)) swallowTap(event);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown, true));
  });
  createEffect(() => {
    props.draftKey;
    const token = commandQuery();
    setSearchError(false);
    if (!token || !props.searchCommands) {
      setSearching(false);
      return;
    }
    running();
    const parsed = parsedCommandQuery();
    const opening = commandOpening();
    const abort = new AbortController();
    setSearching(true);
    const delay = retrySearch ? 0 : 120;
    retrySearch = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => props.searchCommands!(parsed.query, abort.signal, { scope: parsed.scope?.id, opening }))
        .then((results) => {
          if (!abort.signal.aborted) {
            batch(() => {
              setSearchResults(results);
              setSearchResultsQuery(token.query);
              setSearchResultsScope(parsed.scope?.id);
            });
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setSearchResults([]);
            setSearchResultsQuery(undefined);
            setSearchError(true);
          }
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearching(false);
        });
    }, delay);
    onCleanup(() => {
      clearTimeout(timer);
      abort.abort();
    });
  });
  let settledEmpty: { start: number; query: string } | undefined;
  // A space after "Nothing found" ends the `/…` as plain text; a search field opened from "+" just keeps its text.
  createEffect(() => {
    const token = commandQuery();
    if (!token || addSearch() || parsedCommandQuery().scope || searchError()) {
      settledEmpty = undefined;
      return;
    }
    const previous = settledEmpty;
    if (/\s$/.test(token.query) && previous?.start === token.start && previous.query.trimEnd() === token.query.trimEnd()) {
      setClosedAt(token.start);
      return;
    }
    const settled = !searching() && (!props.searchCommands || searchResultsQuery() === token.query);
    if (settled && commandModel().empty) {
      settledEmpty = { start: token.start, query: token.query };
      if (/\s$/.test(token.query)) setClosedAt(token.start);
    } else if (!searching()) settledEmpty = undefined;
  });
  let lastSuggestion: { query: string; text: string } | undefined;
  createEffect(() => {
    const model = commandModel();
    const query = commandQuery()?.query;
    if (!commandsOpen()) {
      setSuggestionAnnouncement(undefined);
      lastSuggestion = undefined;
      return;
    }
    if (searching() || searchError() || (props.searchCommands && searchResultsQuery() !== query)) return;
    const text = chatMessages().commandSuggestions({ count: model.rows.length });
    const timer = setTimeout(() => {
      if (lastSuggestion && lastSuggestion.query === query && lastSuggestion.text === text) return;
      lastSuggestion = { query: query ?? "", text };
      setSuggestionAnnouncement({ text });
    }, 350);
    onCleanup(() => clearTimeout(timer));
  });
  const history: { value: string; mentions: readonly ChatMention[]; caret: number }[] = [];
  let historyIndex = -1;
  createEffect(() => {
    props.draftKey;
    untrack(() => {
      history.length = 0;
      historyIndex = -1;
      finishModelSelection(null);
      endAddSearch(false);
      setDismissed(true);
      setClosedAt(undefined);
      setSearchResults([]);
      setSearchResultsQuery(undefined);
      // A failure belongs to the draft it happened in; success notes may follow a command into the chat it opened.
      if (commandStatus()?.tone === "error") showCommandStatus();
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
    if (commandStatus()?.tone === "error") showCommandStatus();
    // Replacing `/` can leave its position and query identical, but starts a new opening.
    if (inputStart !== undefined && inputEnd !== undefined && props.value.slice(inputStart, inputEnd).includes("/")) {
      setCommandOpening((opening) => opening + 1);
      setSearchResults([]);
      setSearchResultsQuery(undefined);
      setCommandMoved(false);
    }
    // An edit that starts at or before the closed `/` (select all, then type `/`) replaces it; the new `/` may open again.
    const closed = closedAt();
    if (closed !== undefined) {
      let same = 0;
      while (same <= closed && props.value[same] === value[same]) same++;
      if (Math.min(same, inputStart ?? same) <= closed) setClosedAt(undefined);
    }
    inputStart = undefined;
    inputEnd = undefined;
    record();
    props.onValueChange(value);
    props.onMentionsChange?.(nextMentions);
    record();
    setDismissed(false);
  };
  const restoreHistory = (direction: -1 | 1) => {
    // A field that only stays enabled to keep focus, while an `open` row runs, is not edited by undo either.
    if (editBlocked()) return;
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
    // One update, so no effect sees a half-moved selection (it would read as "no `/` here" and reopen a closed list).
    batch(() => {
      setCaret(textareaRef?.selectionStart ?? props.value.length);
      setSelectionEnd(textareaRef?.selectionEnd ?? props.value.length);
    });
  };
  /** Closes the list opened from "+"; `refocus` gives the field its focus and the selection it had when "+" was pressed. */
  const endAddSearch = (refocus: boolean) => {
    const search = addSearch();
    if (!search) return;
    addComposing = false;
    batch(() => {
      setAddSearch(undefined);
      setAddQuery("");
    });
    if (!refocus || !textareaRef) return;
    const length = textareaRef.value.length;
    textareaRef.focus();
    textareaRef.setSelectionRange(Math.min(search.start, length), Math.min(search.end, length));
    syncCaret();
  };
  /** Escape, Back, a press outside: the list closes and the text stays. */
  const closeCommandList = (refocus = true) => {
    if (addSearch()) endAddSearch(refocus);
    else setClosedAt(commandQuery()?.start);
  };
  const toggleAddSearch = () => {
    if (addSearch()) {
      endAddSearch(true);
      return;
    }
    if (blocked() || !textareaRef) return;
    const start = textareaRef.selectionStart;
    const end = textareaRef.selectionEnd;
    batch(() => {
      // Emoji suggestions for a `:shortcode` at the caret give way; they would hold the list closed.
      setDismissed(true);
      setAddQuery("");
      setAddSearch({ start, end });
    });
    // Within the press, so a phone opens its keyboard for the search field.
    addSearchRef?.focus();
  };
  const selectedCommand = createMemo(() => {
    const rows = commandMatches();
    return (commandMoved() && rows.find((command) => chatCommandKey(command) === activeCommandKey())) || rows[0];
  });
  const selectedCommandKey = createMemo(() => {
    const command = selectedCommand();
    return command ? chatCommandKey(command) : undefined;
  });
  createEffect(() => {
    if (!commandsOpen()) commandIds.clear();
    selectedCommandKey();
    setAnnouncement(undefined);
  });
  const busy = () => Boolean(props.disabled || stopping() || state() === "submitting" || executing() || addingFiles());
  const blocked = () => busy() || submitting();
  /** The conversation field stays editable while a message is sent, so it keeps the focus and a phone its keyboard. */
  const editBlocked = () => (conversation() ? busy() : blocked());
  const hasDraft = () => Boolean(props.value.trim() || (!running() && attachments().length > 0));
  /** The draft may go out now, apart from a submission that is already on its way. */
  const submittable = () => !busy() && hasDraft() && !(running() && runningSubmitIntent() === "steer" && mentions().length);
  const canSubmit = () => !submitting() && submittable();
  const canSelectFiles = () => Boolean(props.fileSelection && !props.fileSelection.disabled && !running() && !blocked());
  const hasAddMenu = () => Boolean(props.fileSelection || props.menuActions?.length);
  /** "+" opens the slash list, as long as there is one; otherwise it stays the add menu. */
  const addOpensCommands = () => Boolean(props.addOpensCommands && (props.commands?.length || props.searchCommands));
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
        label: props.fileSelection.label ?? chatMessages().attachFiles,
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
        action: () =>
          reportChatFailure(async () => {
            await executeChatAction(action);
            // Like attaching files, an add action returns to the field, unless it moved the focus somewhere on purpose.
            queueMicrotask(() => {
              const active = textareaRef?.ownerDocument.activeElement;
              if (!active || active === active.ownerDocument.body || active.closest(".k2b-chat-composer")) focus();
            });
          }, props.onError),
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
    emojiMatches();
    setSelectedCommandIndex(0);
  });

  createEffect(() => {
    const command = selectedCommand();
    const id = emojiOpen() ? `${commandListId}-${selectedCommandIndex()}` : command ? commandOptionId(command) : undefined;
    queueMicrotask(() => {
      const list = commandListRef;
      const item = id ? list?.querySelector<HTMLElement>(`[id="${id}"]`) : undefined;
      if (!list || !item?.isConnected) return;
      // Measured against the visible part of the list: a sticky section heading covers the top of it.
      const heading = item.closest(".k2b-chat-composer__command-group")?.querySelector<HTMLElement>(".k2b-chat-composer__command-heading");
      const listTop = list.getBoundingClientRect().top + list.clientTop;
      const box = item.getBoundingClientRect();
      const top = box.top - listTop - (heading?.offsetHeight ?? 0);
      const bottom = box.bottom - listTop - list.clientHeight;
      if (top < 0) list.scrollTop += top;
      else if (bottom > 0) list.scrollTop += bottom;
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

  /** `onNothing` runs when the person closes the selection without a file. */
  const chooseFiles = (onNothing?: () => void) => {
    const selection = props.fileSelection;
    if (!selection?.choose) {
      const input = fileInputRef;
      if (input && onNothing) {
        const done = new AbortController();
        input.addEventListener(
          "cancel",
          () => {
            done.abort();
            onNothing();
          },
          { signal: done.signal },
        );
        input.addEventListener("change", () => done.abort(), { signal: done.signal });
      }
      return input?.click();
    }
    const failed = (error: unknown) => {
      onNothing?.();
      (props.fileSelection?.onError ?? props.onError)?.(error);
    };
    let chosen: Promise<readonly File[]>;
    try {
      chosen = selection.choose();
    } catch (error) {
      failed(error);
      return;
    }
    chosen.then(
      // A single-file composer keeps the first chosen file, as its file dialog and drops do.
      (files) => {
        if (files.length === 0) onNothing?.();
        else void runFiles(selection.multiple === false ? files.slice(0, 1) : files);
      },
      failed,
    );
  };

  /**
   * "Attach files" from the slash list: the token leaves as one edit, and the selection opens synchronously, inside the
   * key or click that chose the row, because the device's file dialog needs that activation. Closing the selection
   * without a file brings the token back, unless the draft changed meanwhile.
   */
  const attachFilesFromCommand = (token: { start: number; end: number }, selection?: { start: number; end: number }) => {
    if (!canSelectFiles()) return;
    const key = props.draftKey;
    const previous = snapshot();
    const previousHistory = { entries: [...history], index: historyIndex };
    const nextValue = props.value.slice(0, token.start) + props.value.slice(token.end);
    edit(nextValue, reconcileChatMentions(props.value, nextValue, mentions()));
    setDismissed(true);
    chooseFiles(() => {
      if (props.draftKey !== key || props.value !== nextValue) return;
      setDismissed(true);
      props.onValueChange(previous.value);
      props.onMentionsChange?.(previous.mentions);
      history.splice(0, history.length, ...previousHistory.entries);
      historyIndex = previousHistory.index;
      queueMicrotask(() => {
        textareaRef?.setSelectionRange(selection?.start ?? token.end, selection?.end ?? token.end);
        syncCaret();
        focus();
      });
    });
    queueMicrotask(() => {
      if (props.draftKey !== key || props.value !== nextValue) return;
      textareaRef?.setSelectionRange(token.start, token.start);
      syncCaret();
    });
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
    const key = props.draftKey;
    setSubmitting(true);
    try {
      if (isTouchOnly()) {
        if (commandSheetHeld()) closeCommandList(false);
        // The sheet's Back entry leaves first, so a submit handler that navigates finds the history settled.
        await dialogHistorySettled();
        // A draft that another one replaced, or that may no longer go out, is not sent and keeps its text.
        if (disposed || props.draftKey !== key || !submittable()) return;
      }
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
      await runChatSubmission({
        clear: () => {
          props.onValueChange("");
          props.onMentionsChange?.([]);
          if (intent !== "steer") setAttachments([]);
        },
        perform: () => props.onSubmit(input),
        restore: () => {
          // Text typed while the submission ran stays, after the returned draft. Its mentions are read first, because
          // an application may already move them when the text changes.
          const typed = props.value;
          const typedMentions = mentions();
          const shift = previousValue.length + 1;
          props.onValueChange(typed ? `${previousValue}\n${typed}` : previousValue);
          props.onMentionsChange?.(
            typed
              ? [
                  ...previousMentions,
                  ...typedMentions.map((mention) => ({ ...mention, start: mention.start + shift, end: mention.end + shift })),
                ]
              : previousMentions,
          );
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

  const narrowCommand = (command: ChatCommand): boolean => {
    const scope = props.commandScopes?.find((scope) => scope.id === command.scope);
    const word = scope?.words[0];
    const token = commandQuery();
    if (!word || !token || !textareaRef) return false;
    if (addSearch()) {
      setAddQuery(`${word} `);
      return true;
    }
    replaceTextareaRange(textareaRef, token.start + 1, token.end, `${word} `);
    syncCaret();
    return true;
  };
  const executeCommand = async (command: ChatCommand, tab = false) => {
    const token = commandQuery();
    const heldHistory = commandSheetHeld();
    const addSelection = addSearch();
    const fromAdd = addSelection !== undefined;
    if (!token || blocked()) return;
    if (command.disabled || command.reason) {
      // A new object each time, so choosing the same row again inserts and announces its reason again.
      setAnnouncement(command.reason ? { text: command.reason } : undefined);
      return;
    }
    if (command.searchAgain) {
      retrySearch = true;
      setCommandOpening((opening) => opening + 1);
      return;
    }
    if (command.scope && (tab || (!command.action && !command.mention && !command.attachFiles)) && narrowCommand(command)) return;
    if (command.attachFiles) {
      if (!canSelectFiles()) return;
      // The field has the focus before the selection opens, so closing it without a file comes back there.
      endAddSearch(true);
      attachFilesFromCommand(token, addSelection);
      return;
    }
    if (command.open) {
      await openFromCommand(command, command.open, token);
      return;
    }
    // The field has the focus again before an action opens a dialog, so the dialog gives it back there.
    endAddSearch(true);
    // From "+" a reference joins the text at the caret, apart from a word right before it.
    const lead = (value: string) => (fromAdd && token.start > 0 && !/\s/.test(value[token.start - 1] ?? "") ? " " : "");
    const previous = snapshot();
    const key = props.draftKey;
    const replacement = command.mention ? lead(props.value) + command.mention.name + " " : "";
    const nextValue = props.value.slice(0, token.start) + replacement + props.value.slice(token.end);
    const nextMentions = reconcileChatMentions(props.value, nextValue, mentions());
    if (command.mention) {
      const start = token.start + lead(props.value).length;
      nextMentions.push({ start, end: start + command.mention.name.length, attachment: command.mention });
    }
    // A cancelled or failed command leaves no undo step behind: restoring puts the history back as well.
    const previousHistory = { entries: [...history], index: historyIndex };
    edit(nextValue, nextMentions);
    setDismissed(true);
    setExecuting(true);
    let submitRequested = false;
    let restored = false;
    let mentioned: { value: string; caret: number } | undefined;
    const restore = () => {
      if (props.draftKey !== key || props.value !== nextValue) return;
      setDismissed(true);
      props.onValueChange(previous.value);
      props.onMentionsChange?.(previous.mentions);
      history.splice(0, history.length, ...previousHistory.entries);
      historyIndex = previousHistory.index;
      restored = true;
    };
    showCommandStatus(command.busyLabel ? { tone: "busy", text: command.busyLabel } : undefined);
    try {
      // The sheet's Back entry leaves first, so an action that navigates or opens a dialog finds the history settled.
      if (heldHistory && command.action) {
        await dialogHistorySettled();
        // Another draft or no composer any more: the command does not run against it.
        if (disposed || props.draftKey !== key) return;
      }
      const result = await command.action?.({
        setValue: (value) => edit(value),
        submit: () => {
          submitRequested = true;
        },
        focus,
        openModelSelection,
      });
      if (result === "cancelled") {
        submitRequested = false;
        restore();
        showCommandStatus();
      } else if (result && "mention" in result) {
        // One undo step from the token to the reference, as if the row had been a reference itself.
        if (props.draftKey === key && props.value === nextValue) {
          restore();
          restored = false;
          const name = result.mention.name;
          const start = token.start + lead(previous.value).length;
          const withMention = previous.value.slice(0, token.start) + lead(previous.value) + name + " " + previous.value.slice(token.end);
          edit(withMention, [
            ...reconcileChatMentions(previous.value, withMention, previous.mentions),
            { start, end: start + name.length, attachment: result.mention },
          ]);
          setDismissed(true);
          mentioned = { value: withMention, caret: start + name.length + 1 };
          showCommandStatus();
        } else {
          // The pick is lost; say so, also when the draft moved to another key meanwhile (such as a new chat saved
          // while the dialog was open), so it never ends in silence.
          showCommandStatus({ tone: "error", text: chatMessages().commandDraftChanged });
        }
      } else if (result) {
        showCommandStatus({ tone: "done", text: result.done });
      }
    } catch (error) {
      submitRequested = false;
      restore();
      // An unmounted composer has no status line left; the app's error channel keeps the failure from going silent.
      if (disposed) props.onError?.(error);
      else
        showCommandStatus({ tone: "error", text: error instanceof Error && error.message ? error.message : chatMessages().commandFailed });
    } finally {
      if (commandStatus()?.tone === "busy") showCommandStatus();
      setExecuting(false);
    }
    if (submitRequested && props.draftKey === key) await submit();
    queueMicrotask(() => {
      if (props.draftKey !== key) return;
      if (restored || props.value === nextValue || (mentioned && props.value === mentioned.value)) {
        const position = restored ? token.end : (mentioned?.caret ?? token.start + replacement.length);
        textareaRef?.setSelectionRange(
          restored && addSelection ? addSelection.start : position,
          restored && addSelection ? addSelection.end : position,
        );
      }
      syncCaret();
      autoResize();
      focus();
    });
  };

  /**
   * Runs an `open` row with the token and the list in place. Success removes the token in one undo step; `failed`
   * stays in the row while the list is still there, otherwise the status line says it, so it never ends in silence.
   */
  const openFromCommand = async (command: ChatCommand, open: NonNullable<ChatCommand["open"]>, token: { start: number; end: number }) => {
    const key = props.draftKey;
    const row = chatCommandKey(command);
    const value = props.value;
    const nextValue = value.slice(0, token.start) + value.slice(token.end);
    const nextMentions = reconcileChatMentions(value, nextValue, mentions());
    // Still the same draft and `/…`, so the row is where the person chose it.
    const inPlace = () => !disposed && props.draftKey === key && props.value === value && commandQuery()?.start === token.start;
    const heldHistory = commandSheetHeld();
    // Closing the list or leaving the composer cancels the opening; the row ends at once, without waiting for it.
    const controller = new AbortController();
    const run = { controller, key, label: command.busyLabel ?? chatMessages().commandOpening, follow: false, moved: false };
    openingRun = run;
    const cancelled = new Promise<"cancelled">((resolve) =>
      controller.signal.addEventListener("abort", () => resolve("cancelled"), { once: true }),
    );
    setOpenFailures(({ [row]: _, ...rest }) => rest);
    setOpeningRow(row);
    setExecuting(true);
    // An opening that ends without leaving, by failure, rejection or cancelling, also aborts `signal`, so the opener
    // can put back what it saved without the token.
    const finish = (left = false) => {
      if (!left) controller.abort();
      if (openingRun === run) openingRun = undefined;
      if (commandStatus()?.tone === "busy") showCommandStatus();
      setOpeningRow(undefined);
      setExecuting(false);
    };
    let result: ChatCommandOpenResult;
    try {
      if (heldHistory) {
        await dialogHistorySettled();
        if (!inPlace()) {
          finish();
          return;
        }
      }
      result = await Promise.race([
        open({ value: nextValue, mentions: nextMentions }, controller.signal, () => {
          run.follow = true;
        }),
        cancelled,
      ]);
    } catch (error) {
      finish();
      if (disposed) {
        props.onError?.(error);
        return;
      }
      if (inPlace()) closeCommandList();
      showCommandStatus({ tone: "error", text: error instanceof Error && error.message ? error.message : chatMessages().commandFailed });
      return;
    }
    if (!result) {
      // Success: the token leaves and the list closes in the same step that ends the opening, so a phone sheet never
      // takes its Back entry again while the page navigates.
      batch(() => {
        if (!disposed && props.draftKey === key && props.value === value) {
          edit(nextValue, nextMentions);
          setDismissed(true);
        }
        endAddSearch(!disposed && props.draftKey === key);
        finish(true);
      });
      queueMicrotask(() => {
        if (disposed || props.draftKey !== key || props.value !== nextValue) return;
        textareaRef?.setSelectionRange(token.start, token.start);
        syncCaret();
        autoResize();
      });
      return;
    }
    finish();
    if (result === "cancelled") return;
    if (inPlace()) {
      setOpenFailures((failures) => ({ ...failures, [row]: result.failed }));
      setAnnouncement({ text: result.failed });
    } else if (disposed) props.onError?.(new Error(result.failed));
    else showCommandStatus({ tone: "error", text: result.failed });
  };

  /** Replaces `start`–`end` with the emoji through the editing path, so the browser's undo restores the shortcode. */
  const insertEmoji = (start: number, end: number, emoji: string) => {
    if (!textareaRef || editBlocked()) return;
    replaceTextareaRange(textareaRef, start, end, emoji);
    syncCaret();
    reportChatFailure(() => props.emoji?.onPick?.(emoji), props.onError);
  };
  const pickEmojiSuggestion = (position: number) => {
    const token = emojiQuery();
    const entry = emojiMatches()[position];
    if (!token || !entry) return;
    insertEmoji(token.start, token.end, emojiInTone(entry, props.emoji?.skinTone ?? 0));
  };
  /**
   * A typed colon loads the emoji data, and the closing colon of a known `:shortcode:` turns it into its emoji. A
   * shortcode closed before the data arrived turns when it arrives, as long as nothing changed in the meantime.
   */
  const completeShortcode = () => {
    const textarea = textareaRef;
    if (!props.emoji || !textarea) return;
    const { value, selectionStart: caret } = textarea;
    const completed = completedEmojiShortcode(value, caret);
    const convert = (index: EmojiIndex) => {
      const entry = completed && index.byShortcode.get(completed.shortcode.toLowerCase());
      if (completed && entry) insertEmoji(completed.start, completed.end, emojiInTone(entry, props.emoji?.skinTone ?? 0));
    };
    const index = emojiIndex();
    if (index) {
      convert(index);
      return;
    }
    loadEmojiIndex().then(
      (loaded) => {
        setEmojiIndex(loaded);
        const untouched = textarea.value === value && textarea.selectionStart === caret && textarea.selectionEnd === caret;
        if (untouched && textarea.matches(":focus")) convert(loaded);
      },
      () => undefined,
    );
  };

  /** Moving through and choosing in the command list, from the field or from the search field opened by "+". */
  const commandListKey = (event: KeyboardEvent): boolean => {
    if (!commandsOpen()) return false;
    const matches = commandMatches();
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const index = matches.indexOf(selectedCommand()!);
      const next = matches[nextChatCommandIndex(index, matches.length, event.key === "ArrowUp" ? -1 : 1)];
      setActiveCommandKey(next ? chatCommandKey(next) : undefined);
      setCommandMoved(true);
      setAnnouncement(undefined);
      return true;
    }
    // Ctrl/⌘+Enter sends, also while suggestions are open.
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (plain && (event.key === "Tab" || event.key === "Enter") && matches.length > 0) {
      event.preventDefault();
      const command = selectedCommand();
      // A server row answering an earlier query may no longer match; wait for fresh results. Local rows match now.
      const row = commandModel().rows.find((row) => chatCommandKey(row.command) === selectedCommandKey());
      const staleServerRow =
        row?.server && (searchResultsQuery() !== commandQuery()?.query || searchResultsScope() !== parsedCommandQuery().scope?.id);
      if (staleServerRow) return true;
      if (command) void executeCommand(command, event.key === "Tab");
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandList();
      return true;
    }
    return false;
  };

  const onAddSearchKeyDown = (event: KeyboardEvent) => {
    // Nothing chooses while an input method composes, as in the field.
    if (event.isComposing || event.keyCode === 229 || addComposing) return;
    if (event.key === "Escape" && openingRun) {
      event.preventDefault();
      openingRun.controller.abort();
      endAddSearch(true);
      return;
    }
    if (commandListKey(event)) return;
    // Ctrl/⌘+Enter sends from the search field as from the field, with the list closed first.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      endAddSearch(true);
      void submit();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // WebKit ends the composition before the keydown of the Enter that confirms it; that keydown keeps keyCode 229.
    if (event.isComposing || event.keyCode === 229 || composing()) return;
    // Escape cancels a running `open` row, also once its list is gone because the draft moved to a new chat.
    if (event.key === "Escape" && openingRun) {
      event.preventDefault();
      openingRun.controller.abort();
      if (commandsOpen()) closeCommandList();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      restoreHistory(event.shiftKey ? 1 : -1);
      return;
    }
    if (emojiOpen()) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedCommandIndex((index) => nextChatCommandIndex(index, emojiMatches().length, event.key === "ArrowUp" ? -1 : 1));
        return;
      }
      // Only a plain Enter or Tab picks: Shift+Enter still breaks the line, Shift+Tab still moves the focus back.
      const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (plain && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        pickEmojiSuggestion(selectedCommandIndex());
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (commandListKey(event)) return;
    const format = props.formatting && textareaRef ? formatShortcut(event) : undefined;
    if (format && textareaRef) {
      event.preventDefault();
      if (editBlocked()) return;
      format.run(textareaRef);
      return;
    }
    if (event.key !== "Enter") return;
    if (conversation()) {
      const action = conversationEnterAction(event, {
        sendKey: props.sendKey ?? "enter",
        touchOnly: isTouchOnly(),
        inCodeBlock: openCodeFence(props.value, textareaRef?.selectionStart ?? props.value.length) !== null,
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
    if (!textareaRef || editBlocked()) return;
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
      items.push({ icon: "ti ti-microphone", label: chatMessages().dictate, action: () => reportChatFailure(dictate, props.onError) });
    }
    if (microphone?.onVoiceMessage) {
      const record = microphone.onVoiceMessage;
      items.push({
        icon: "ti ti-player-record",
        label: chatMessages().recordVoiceMessage,
        action: () => reportChatFailure(record, props.onError),
      });
    }
    return items;
  };
  const dictationStatus = (): { icon: string; text: string } | null => {
    switch (dictation()) {
      case "listening":
        return { icon: "ti ti-microphone", text: chatMessages().dictationListening };
      case "refining":
        return { icon: "ti ti-loader-2 k2b-spin", text: chatMessages().dictationRefining };
      case "refined":
        return { icon: "ti ti-sparkles", text: chatMessages().dictationRefined };
      case "unrefined":
        return { icon: "ti ti-microphone", text: chatMessages().dictationUnrefined };
      case "interrupted":
        return { icon: "ti ti-alert-triangle", text: chatMessages().dictationInterrupted };
      default:
        return null;
    }
  };

  const fileInput = () => (
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
  );

  const addMenu = (icon: string, extraClass = "") => (
    <Dropdown.Root position="top-right" label={chatMessages().addToChat} items={menuItems()} disabled={blocked()}>
      <Dropdown.Trigger
        appearance="plain"
        class={`k2b-chat-composer__icon-action${extraClass}`}
        label={chatMessages().addToChat}
        tooltip={chatMessages().addToChat}
      >
        <i class={icon} aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );

  /** "+" as the way to the slash list on keyboards without a handy "/". */
  const addSearchButton = (extraClass = "") => (
    <Tooltip.Trigger
      ref={addButtonRef}
      type="button"
      class={`k2b-chat-composer__icon-action${extraClass}`}
      aria-label={chatMessages().addMenu}
      aria-haspopup="listbox"
      aria-expanded={addSearch() !== undefined}
      aria-controls={addSearch() ? commandListId : undefined}
      content={chatMessages().addMenu}
      disabled={blocked()}
      // The field keeps its focus and selection until the search field takes over, and a phone its keyboard.
      onMouseDown={keepFieldFocus}
      onClick={toggleAddSearch}
    >
      <i class={addingFiles() ? "ti ti-loader-2 k2b-spin" : "ti ti-plus"} aria-hidden="true" />
    </Tooltip.Trigger>
  );

  /** The conversation's attach button opens the file choice directly; other actions turn it into the add menu. */
  const attachControl = () => (
    <Show when={!addOpensCommands()} fallback={addSearchButton(" k2b-chat-composer__attach")}>
      {attachChoice()}
    </Show>
  );
  const attachChoice = () => (
    <Show
      when={props.menuActions?.length}
      fallback={
        <Show when={props.fileSelection}>
          {(selection) => (
            <Tooltip.Trigger
              type="button"
              class="k2b-chat-composer__icon-action k2b-chat-composer__attach"
              aria-label={selection().label ?? chatMessages().attachFiles}
              content={selection().label ?? chatMessages().attachFiles}
              disabled={!canSelectFiles()}
              onClick={() => chooseFiles()}
            >
              <i class={addingFiles() ? "ti ti-loader-2 k2b-spin" : "ti ti-plus"} aria-hidden="true" />
            </Tooltip.Trigger>
          )}
        </Show>
      }
    >
      {addMenu("ti ti-plus", " k2b-chat-composer__attach")}
    </Show>
  );

  const formatToggle = () => (
    <Show when={props.formatting}>
      <Tooltip.Trigger
        type="button"
        class="k2b-chat-composer__icon-action k2b-chat-composer__format-toggle"
        aria-label={chatMessages().composerFormatting}
        aria-pressed={formattingOpen()}
        aria-controls={formattingOpen() ? formatGroupId : undefined}
        content={chatMessages().composerFormatting}
        onMouseDown={keepFieldFocus}
        onClick={() => setFormattingOpen((open) => !open)}
      >
        <i class="ti ti-letter-case" aria-hidden="true" />
      </Tooltip.Trigger>
    </Show>
  );

  /** One row of fixed height. It shows every button at once, also on a phone, so nothing hides behind a scroll. */
  const formatRow = () => (
    <Show when={props.formatting && formattingOpen()}>
      <div id={formatGroupId} class="k2b-chat-composer__format" role="group" aria-label={chatMessages().composerFormatting}>
        <For each={formatTools}>
          {(tool) => (
            <Tooltip.Trigger
              type="button"
              class="k2b-chat-composer__icon-action"
              aria-label={tool.label(markdownToolbarMessages())}
              content={tool.label(markdownToolbarMessages())}
              disabled={editBlocked()}
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
  );

  const emojiButton = () => (
    <Show when={props.emoji}>
      {(emoji) => (
        <Tooltip.Trigger
          type="button"
          class="k2b-chat-composer__icon-action k2b-chat-composer__emoji"
          aria-label={chatMessages().insertEmoji}
          content={chatMessages().insertEmoji}
          disabled={editBlocked()}
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
  );

  const microphoneControl = () => (
    <Show when={props.microphone?.onDictate || props.microphone?.onVoiceMessage ? props.microphone : undefined}>
      {(microphone) => (
        <div ref={microphoneRef} class="k2b-chat-composer__microphone">
          <Tooltip.Trigger
            type="button"
            class="k2b-chat-composer__icon-action k2b-chat-composer__microphone-button"
            data-state={dictation() ?? undefined}
            disabled={microphoneDisabled()}
            aria-pressed={microphone().onDictate ? dictation() === "listening" : undefined}
            aria-haspopup={microphone().onDictate ? undefined : "menu"}
            aria-expanded={microphone().onDictate ? undefined : microphoneMenuOpen()}
            // A toggle keeps its name; the pressed state says that dictation runs.
            aria-label={microphone().onDictate ? chatMessages().dictate : chatMessages().recordVoiceMessage}
            content={
              dictation() === "listening"
                ? chatMessages().stopDictation
                : microphone().onDictate
                  ? microphone().onVoiceMessage
                    ? chatMessages().dictateOrHold
                    : chatMessages().dictate
                  : chatMessages().recordVoiceMessage
            }
            onMouseDown={keepFieldFocus}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              held = false;
              releaseHold();
              const record = microphone().onVoiceMessage;
              if (event.button !== 0 || !record || dictation() === "listening") return;
              holdTimer = setTimeout(() => {
                // The composer may have become blocked, or recording withdrawn, during the press.
                const current = props.microphone?.onVoiceMessage;
                if (!current || microphoneDisabled()) return;
                held = true;
                reportChatFailure(current, props.onError);
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
              if (dictate) {
                reportChatFailure(dictate, props.onError);
                return;
              }
              setMicrophoneMenuOpen(true);
              // From the keyboard it opens the menu like a menu button: the focus moves to the first item.
              if (event.detail === 0) {
                queueMicrotask(() => microphoneRef?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
              }
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
              label={chatMessages().microphoneOptions}
              items={microphoneItems()}
              disabled={microphoneDisabled()}
              open={microphoneMenuOpen()}
              onOpenChange={setMicrophoneMenuOpen}
            >
              <Dropdown.Trigger
                appearance="plain"
                class="k2b-chat-composer__icon-action k2b-chat-composer__microphone-menu"
                label={chatMessages().microphoneOptions}
                tooltip={chatMessages().microphoneOptions}
              >
                <i class="ti ti-chevron-up" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
        </div>
      )}
    </Show>
  );

  const sendControl = () => (
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
                  ? chatMessages().queueing
                  : chatMessages().steering
                : chatMessages().sending
              : running()
                ? runningSubmitIntent() === "queue"
                  ? chatMessages().queueMessage
                  : chatMessages().steerResponse
                : chatMessages().sendMessage
          }
          content={
            running()
              ? runningSubmitIntent() === "queue"
                ? chatMessages().queueMessage
                : chatMessages().steerResponse
              : chatMessages().sendMessage
          }
          onClick={() => void submit()}
        >
          <i class={submitting() ? "ti ti-loader-2 k2b-spin" : conversation() ? "ti ti-send" : "ti ti-arrow-up"} aria-hidden="true" />
        </Tooltip.Trigger>
      }
    >
      <Tooltip.Trigger
        type="button"
        class="k2b-chat-composer__stop"
        disabled={stopping()}
        aria-label={stopping() ? chatMessages().stopping : chatMessages().stopResponse}
        content={chatMessages().stopResponse}
        onClick={() => reportChatFailure(() => props.onStop?.(), props.onError)}
      >
        <i class={stopping() ? "ti ti-loader-2 k2b-spin" : "ti ti-player-stop"} aria-hidden="true" />
      </Tooltip.Trigger>
    </Show>
  );

  const field = () => (
    <div class="k2b-chat-composer__input" role="group" aria-label={chatMessages().messageInput}>
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
        // An `open` row keeps the field focused, so the list stays, and only read-only while it runs.
        disabled={editBlocked() && openingRow() === undefined}
        readOnly={openingRow() !== undefined}
        enterkeyhint={conversation() ? "enter" : undefined}
        placeholder={
          props.placeholder ??
          (running() ? chatMessages().addGuidance : conversation() ? chatMessages().writeConversationMessage : chatMessages().writeMessage)
        }
        aria-label={props.inputLabel ?? messages().message}
        // A list opened from "+" belongs to its search field.
        role={fieldOwnsList() ? "combobox" : undefined}
        aria-autocomplete={fieldOwnsList() ? "list" : undefined}
        aria-controls={fieldOwnsList() ? commandListId : undefined}
        aria-expanded={fieldOwnsList() ? "true" : undefined}
        aria-activedescendant={
          !fieldOwnsList()
            ? undefined
            : emojiOpen()
              ? `${commandListId}-${selectedCommandIndex()}`
              : selectedCommand()
                ? commandOptionId(selectedCommand()!)
                : undefined
        }
        onInput={(event) => {
          batch(() => {
            edit(event.currentTarget.value);
            syncCaret();
          });
          autoResize();
          const input = event as InputEvent;
          if (input.inputType === "insertText" && input.data === ":") queueMicrotask(completeShortcode);
        }}
        onPaste={(event) => {
          // Read-only while an `open` row runs: nothing may join the draft after it was saved.
          if (editBlocked()) {
            event.preventDefault();
            return;
          }
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
          inputStart = event.currentTarget.selectionStart;
          inputEnd = event.currentTarget.selectionEnd;
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
  );

  const commandRowMap = createMemo(() => new Map(commandModel().rows.map((row) => [row.command, row])));
  const commandGroupKey = (group: ReturnType<typeof commandModel>["groups"][number]) =>
    group.scopeTitle ? "scope" : group.section ? `section:${group.section.id}` : "flat";
  const renderCommandRow = (command: ChatCommand) => {
    const highlight = () => commandRowMap().get(command)?.highlight;
    const title = () => command.label ?? command.name;
    const opening = () => openingRow() === chatCommandKey(command);
    const failure = () => openFailures()[chatCommandKey(command)];
    return (
      <button
        class="k2b-chat-composer__command"
        id={commandOptionId(command)}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selectedCommand() === command}
        aria-disabled={Boolean(command.disabled || command.reason)}
        aria-busy={opening() ? "true" : undefined}
        aria-describedby={command.reason ? `${commandOptionId(command)}-reason` : undefined}
        data-reason={command.reason ? "true" : undefined}
        data-active={selectedCommand() === command ? "true" : undefined}
        onMouseDown={keepFieldFocus}
        onClick={(event) => {
          event.preventDefault();
          void executeCommand(command);
        }}
      >
        <i class={command.icon ?? "ti ti-slash"} aria-hidden="true" />
        <span class="k2b-chat-composer__command-text">
          <strong>
            <Show when={highlight()} fallback={title()}>
              {(range) => (
                <>
                  {title().slice(0, range()[0])}
                  <b>{title().slice(range()[0], range()[1])}</b>
                  {title().slice(range()[1])}
                </>
              )}
            </Show>
          </strong>
          <Show
            when={command.open && !command.reason}
            fallback={
              <Show when={command.reason ?? command.description}>
                <small id={command.reason ? `${commandOptionId(command)}-reason` : undefined}>
                  {command.reason ?? command.description}
                </small>
              </Show>
            }
          >
            {/* The busy line shares the description's place, so the row keeps its height while it opens. */}
            <span class="k2b-chat-composer__command-detail" data-state={opening() ? "busy" : failure() ? "failed" : undefined}>
              <small aria-hidden={opening() ? "true" : undefined}>{failure() ?? command.description}</small>
              <small aria-hidden={opening() ? undefined : "true"}>
                <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                {command.busyLabel ?? chatMessages().commandOpening}
              </small>
            </span>
          </Show>
        </span>
        <Show when={command.selected}>
          <span class="k2b-chat-composer__command-end">
            <i class="ti ti-check" aria-hidden="true" />
            <span class="k2b-sr-only">{chatMessages().commandSelected}</span>
          </span>
        </Show>
      </button>
    );
  };
  const replyQuote = (reply: ChatComposerReply) => (
    <>
      <span class="k2b-message-row__quote-author">
        <span class="k2b-sr-only">{chatMessages().replyingTo} </span>
        {reply.author}
      </span>
      <span class="k2b-message-row__quote-text">{reply.text}</span>
    </>
  );
  return (
    <div ref={shellRef} class="k2b-chat-composer-shell">
      <Show when={suggestionsOpen() || hasAccessory()}>
        {/* Suggestions alone float above the composer; a row of the shell's grid would add its gap and move the composer. */}
        <div class="k2b-chat-composer-slot" data-overlay={hasAccessory() ? undefined : "true"}>
          <div style={{ visibility: suggestionsOpen() ? "hidden" : undefined }} inert={suggestionsOpen()}>
            {accessory()}
          </div>
          <Show when={emojiOpen()}>
            <div class="k2b-chat-composer-accessory">
              <div
                ref={commandListRef}
                id={commandListId}
                class="k2b-chat-composer__commands"
                role="listbox"
                aria-label={chatMessages().emojiSuggestions}
              >
                <For each={emojiMatches()}>
                  {(entry, index) => (
                    <button
                      id={`${commandListId}-${index()}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index() === selectedCommandIndex()}
                      aria-label={emojiName(entry, locale())}
                      data-active={index() === selectedCommandIndex() ? "true" : undefined}
                      onMouseDown={keepFieldFocus}
                      onClick={() => pickEmojiSuggestion(index())}
                    >
                      <span class="k2b-chat-composer__emoji-glyph" aria-hidden="true">
                        {emojiInTone(entry, props.emoji?.skinTone ?? 0)}
                      </span>
                      <strong>{emojiName(entry, locale())}</strong>
                      <Show when={entry.shortcodes[0]}>{(code) => <small>:{code()}:</small>}</Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <Show when={commandsOpen()}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the search field inside is the keyboard target; a press elsewhere in the panel only keeps the focus there. */}
            <div
              class="k2b-chat-composer-accessory"
              data-commands=""
              data-search={addSearch() ? "" : undefined}
              onMouseDown={(event) => {
                if (addSearch() && event.target !== addSearchRef) event.preventDefault();
              }}
            >
              <Show when={addSearch()}>
                <label class="k2b-chat-composer__command-search">
                  <i class="ti ti-search" aria-hidden="true" />
                  <input
                    ref={addSearchRef}
                    type="text"
                    role="combobox"
                    value={addQuery()}
                    placeholder={chatMessages().commandSearch}
                    aria-label={chatMessages().commandSearchLabel}
                    aria-autocomplete="list"
                    aria-controls={commandListId}
                    aria-expanded="true"
                    aria-activedescendant={selectedCommand() ? commandOptionId(selectedCommand()!) : undefined}
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck={false}
                    // Read-only while an `open` row runs, as the field is.
                    readOnly={openingRow() !== undefined}
                    onInput={(event) => setAddQuery(event.currentTarget.value)}
                    onKeyDown={onAddSearchKeyDown}
                    onCompositionStart={() => {
                      addComposing = true;
                    }}
                    onCompositionEnd={() => {
                      addComposing = false;
                    }}
                    onFocusOut={(event) => {
                      const next = event.relatedTarget;
                      if (next instanceof Node && commandListRef?.parentElement?.contains(next)) return;
                      // Focus that leaves another way, such as with Shift+Tab, closes the list and stays where it went.
                      queueMicrotask(() => {
                        if (addSearch() && document.activeElement !== addSearchRef) endAddSearch(false);
                      });
                    }}
                  />
                </label>
              </Show>
              <div
                ref={commandListRef}
                id={commandListId}
                class="k2b-chat-composer__commands"
                role="listbox"
                aria-label={chatMessages().commands}
                aria-busy={searching() ? "true" : undefined}
              >
                <For each={commandModel().groups.map(commandGroupKey)}>
                  {(key) => {
                    const group = createMemo(() => commandModel().groups.find((group) => commandGroupKey(group) === key));
                    const headingId = () =>
                      `${commandListId}-g-${key === "scope" ? "scope" : props.commandSections?.findIndex((section) => section.id === group()?.section?.id)}`;
                    const rows = () => group()?.rows.map((row) => row.command) ?? [];
                    return (
                      <Show when={key !== "flat"} fallback={<For each={rows()}>{renderCommandRow}</For>}>
                        <div class="k2b-chat-composer__command-group" role="group" aria-labelledby={headingId()}>
                          <div class="k2b-chat-composer__command-heading" id={headingId()} role="presentation">
                            <span>{group()?.scopeTitle ?? group()?.section?.label}</span>
                            <Show when={group()?.loading}>
                              <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                            </Show>
                          </div>
                          <For each={rows()}>{renderCommandRow}</For>
                          <Index each={Array.from({ length: Math.max(group()?.placeholder ? 1 : 0, group()?.pendingRows ?? 0) })}>
                            {() => (
                              <div class="k2b-chat-composer__command-placeholder" aria-hidden="true">
                                <span />
                                <span>
                                  <span />
                                  <span />
                                </span>
                              </div>
                            )}
                          </Index>
                        </div>
                      </Show>
                    );
                  }}
                </For>
                <Show
                  when={
                    searching() && foundCommandCount() === 0 && !commandModel().groups.some((group) => group.section || group.scopeTitle)
                  }
                >
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
                <Show
                  when={
                    !searching() && !searchError() && foundCommandCount() === 0 && !commandModel().groups.some((group) => group.pendingRows)
                  }
                >
                  <div role="status">
                    {!parsedCommandQuery().query.trim()
                      ? messages().noResults
                      : chatMessages().commandsNothingFound({ query: parsedCommandQuery().query.trim() })}
                  </div>
                </Show>
                {/* After "Nothing found", so the way to search further stays in the last place. */}
                {/* Keyed: the row is built anew from each query, and its title says the query. */}
                <Show when={commandModel().fallback?.command} keyed>
                  {(command) => renderCommandRow(command)}
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
        aria-label={props.label ?? chatMessages().messageComposer}
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
                        disabled={microphoneDisabled()}
                        onMouseDown={keepFieldFocus}
                        onClick={() => reportChatFailure(restore(), props.onError)}
                      >
                        {chatMessages().restoreOriginal}
                      </button>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Show>
        <Show when={props.reply}>
          {(reply) => (
            <div class="k2b-chat-composer__reply">
              <Show when={reply().onSelect} fallback={<div class="k2b-message-row__quote">{replyQuote(reply())}</div>}>
                {(select) => (
                  <button type="button" class="k2b-message-row__quote" onClick={() => select()()}>
                    {replyQuote(reply())}
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="k2b-chat-composer__icon-action k2b-chat-composer__reply-cancel"
                aria-label={chatMessages().cancelReply}
                title={chatMessages().cancelReply}
                onMouseDown={keepFieldFocus}
                onClick={() => reply().onCancel()}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </button>
            </div>
          )}
        </Show>
        <Show when={attachments().length > 0}>
          <div class="k2b-chat-composer__attachments" role="list" aria-label={chatMessages().attachments} tabIndex={0}>
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
                          aria-label={chatMessages().openInNewTab({ name: attachment.name })}
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
                      aria-label={selectMessages().removeNamed({ name: attachment.name })}
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

        <Show
          when={conversation()}
          fallback={
            <>
              {field()}

              <Show when={props.error}>
                <div class="k2b-chat-composer__error" role="alert">
                  <i class="ti ti-alert-circle" aria-hidden="true" />
                  {props.error}
                </div>
              </Show>

              {formatRow()}

              <footer class="k2b-chat-composer__footer">
                <Show
                  when={footer()}
                  fallback={
                    <>
                      <div class="k2b-chat-composer__tools">
                        {props.footerTools}
                        <Show when={addOpensCommands()} fallback={<Show when={hasAddMenu()}>{addMenu("ti ti-plus")}</Show>}>
                          {addSearchButton()}
                        </Show>
                        {fileInput()}
                        {formatToggle()}
                        {emojiButton()}
                        <Show when={(props.models?.length ?? 0) > 0}>
                          <SelectChip
                            aria-label={chatMessages().chooseModel}
                            position="top-right"
                            class="k2b-chat-composer__model"
                            menuWidth="15rem"
                            placeholder={chatMessages().model}
                            value={() => props.selectedModelId ?? ""}
                            options={(props.models ?? []).map((model) => ({
                              value: model.id,
                              label: model.label,
                              description: model.description,
                              icon: model.icon,
                              image: model.image,
                            }))}
                            open={modelOpen()}
                            onOpenChange={(open) => {
                              if (!choosingModel()) return;
                              setModelOpen(open);
                              // Dropdown closes before committing the choice; let onValueChange settle it first.
                              if (!open)
                                queueMicrotask(() => {
                                  if (!modelOpen()) finishModelSelection(null);
                                });
                            }}
                            disabled={(choosingModel() ? blockedBesidesCommand() : blocked()) || running() || !props.onModelChange}
                            onValueChange={(modelId) => {
                              props.onModelChange?.(modelId);
                              finishModelSelection(modelId);
                              queueMicrotask(focus);
                            }}
                          />
                        </Show>
                        {props.modelDetails}
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
                        {microphoneControl()}
                        {sendControl()}
                      </div>
                    </>
                  }
                >
                  {footer()}
                </Show>
              </footer>
            </>
          }
        >
          <Show when={props.error}>
            <div class="k2b-chat-composer__error" role="alert">
              <i class="ti ti-alert-circle" aria-hidden="true" />
              {props.error}
            </div>
          </Show>
          {formatRow()}
          {/* One row: attach, the field with its tools, and Send. */}
          <div class="k2b-chat-composer__row">
            {attachControl()}
            {fileInput()}
            <div class="k2b-chat-composer__field">
              {field()}
              <div class="k2b-chat-composer__field-tools">
                {formatToggle()}
                {emojiButton()}
                {microphoneControl()}
              </div>
            </div>
            {sendControl()}
          </div>
        </Show>
        {/* Files dropped anywhere in the surrounding workspace area attach to the message. */}
        <Show when={props.fileSelection}>
          {(selection) => (
            <FileDropTarget
              label={chatMessages().dropFilesToAttach}
              accept={selection().accept}
              multiple={selection().multiple}
              disabled={!canSelectFiles()}
              onDrop={(files) => void runFiles(files)}
            />
          )}
        </Show>
      </section>
      <div class="k2b-sr-only" role="status" aria-live="polite">
        <Show when={suggestionAnnouncement()} keyed>
          {(announced) => <span>{announced.text}</span>}
        </Show>
      </div>
      <div class="k2b-chat-composer__status" role="status">
        <Show when={!suggestionsOpen() && commandStatus()}>
          {(status) => (
            <div class="k2b-chat-composer__status-line" data-tone={status().tone}>
              <i
                aria-hidden="true"
                class={
                  status().tone === "busy" ? "ti ti-loader-2 k2b-spin" : status().tone === "done" ? "ti ti-check" : "ti ti-alert-circle"
                }
              />
              <span>{status().text}</span>
            </div>
          )}
        </Show>
        <Show when={suggestionsOpen() && announcement()} keyed>
          {(announced) => <span class="k2b-sr-only">{announced.text}</span>}
        </Show>
      </div>
    </div>
  );
}
