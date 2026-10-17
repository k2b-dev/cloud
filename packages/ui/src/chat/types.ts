import type { JSX } from "solid-js";
import type { EmojiSkinTone } from "../inputs/emoji/emoji-index";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type ChatMessageStatus = "pending" | "streaming" | "complete" | "error";

/** `warning` marks a partial result or an outcome that is not yet known. */
export type ChatActivityTone = "neutral" | "ai" | "success" | "warning" | "danger";

/** `open` asks; `sending` while the answer is on its way; `decided` once answered; `expired` when it ran out. */
export type ChatDecisionState = "open" | "sending" | "decided" | "expired";

/** One answer of a question. Set the question's state in `onSelect` before awaiting anything, so it collapses at once. */
export type ChatDecisionAnswer = {
  label: string;
  /** Icon class, for example `ti ti-send`. */
  icon?: string;
  onSelect: () => void | Promise<void>;
};

/** Why a question is asked, or why its main answer is off. */
export type ChatDecisionReason = {
  text: JSX.Element;
  /** Icon class; the text after it starts 1.5rem from the edge. */
  icon?: string;
  /** `danger` for deletions, `warning` for outside content and limits. */
  tone?: "neutral" | "danger" | "warning";
};

export type ChatOutcomeTone = "running" | "done" | "off" | "waiting" | "warning" | "error";

/** One text of an outcome flow. */
export type ChatOutcomeLine = {
  tone: ChatOutcomeTone;
  /** What happened, as one sentence, usually with `ReferenceChip`s. */
  text: JSX.Element;
  /** A quiet second sentence, such as "You declined." */
  detail?: JSX.Element;
  /** A formatted time after the text. */
  time?: string;
  /** Replaces the tone's icon, for example `ti ti-clock-x` for an expired question. */
  icon?: string;
  /** One text link after the line, such as "Ask again". */
  action?: { label: string; onSelect: () => void | Promise<void> };
  /** Small buttons under the line. Shown while this line is current; otherwise hidden but still reserving their row. */
  actions?: JSX.Element;
};

/** A person in a preview header: the name in the text colour, then the address the message really uses. */
export type ChatPreviewPerson = { name?: string; address?: string };

/** One header row, such as "To Lea Berg lea.berg@example.com". */
export type ChatPreviewHeaderRow = {
  label: string;
  people?: readonly ChatPreviewPerson[];
  /** Further content after the people, such as "and 2 more". */
  value?: JSX.Element;
  /** Draws the label stronger, for recipients others cannot see. */
  emphasis?: boolean;
};

type ChatActionBase = {
  id: string;
  label: string;
  icon?: string;
  variant?: "danger";
  disabled?: boolean;
  /** Toggle state for persistent message actions such as feedback. */
  pressed?: boolean;
  /** Semantic foreground for selected feedback actions, without a persistent background. */
  pressedTone?: "success" | "danger";
};

/** Exactly one executable behavior for every chat action. */
export type ChatAction = ChatActionBase &
  ({ onSelect: () => void | Promise<void>; copyText?: never } | { copyText: string; onSelect?: never });

export type ChatAttachment = {
  id: string;
  name: string;
  size?: number;
  kind?: "file" | "image" | "resource";
  icon?: string;
  previewUrl?: string;
  alt?: string;
  /** Optional destination represented by this attachment. */
  href?: string;
  /** Opaque application-owned payload returned unchanged with ChatSubmitInput. */
  data?: unknown;
  /** Optional application-owned action presented below the attachment label. */
  action?: ChatAction;
};

export type ChatUsage = {
  input?: number;
  output?: number;
  total?: number;
};

export type ChatContextUsageData = {
  usage?: ChatUsage | null;
  loopUsage?: ChatUsage | null;
  contextWindow?: number;
  modelLabel?: string;
};

export type ChatModelOption = {
  id: string;
  label: string;
  description?: string;
  image?: string;
  icon?: string;
  capabilities?: readonly string[];
};

export type ChatComposerState = "idle" | "submitting" | "running" | "stopping";

export type ChatSubmitIntent = "send" | "steer" | "queue";

export type ChatSubmitInput = {
  intent: ChatSubmitIntent;
  text: string;
  attachments: readonly ChatAttachment[];
  mentions?: readonly ChatMention[];
};

/** Ranges use UTF-16 offsets into the untrimmed composer text. Payloads stay application-owned. */
export type ChatMention = { start: number; end: number; attachment: ChatAttachment };

/**
 * Live dictation as the caller runs it: `listening` while speech arrives, `refining` after the stop until the refined
 * text replaced it, `refined` afterwards, `unrefined` when the raw text stays, and `interrupted` when the connection
 * ended early and the text so far stays.
 */
export type ChatDictationState = "listening" | "refining" | "refined" | "unrefined" | "interrupted";

/** The composer's microphone. Dictation comes first; a voice message is the deliberate second action. */
export type ChatComposerMicrophone = {
  /** A tap starts or stops live dictation. Without it, a tap opens the microphone menu. */
  onDictate?: () => void;
  /** Holding the microphone, or "Record voice message" in its menu. Omit it where recording is not available. */
  onVoiceMessage?: () => void;
  /** The dictation state, shown on the microphone and in the hint line. */
  dictation?: ChatDictationState | null;
  /** Offered as "Restore original" while `dictation` is `refined`. */
  onRestoreOriginal?: () => void;
  disabled?: boolean;
};

/**
 * The composer's emoji button and `:shortcode` completion. Typing a colon and two letters suggests emoji by their
 * English or German name or GitHub shortcode; a complete `:thumbsup:` becomes 👍 when its closing colon is typed.
 */
export type ChatComposerEmoji = {
  /** Opens the emoji choice next to `anchor`, usually `EmojiPicker.Popover`; `insert` puts the chosen text at the caret. */
  onOpen: (context: { anchor: HTMLElement; insert: (text: string) => void }) => void;
  /** The skin tone of completed emoji that have one, as in the picker. */
  skinTone?: EmojiSkinTone;
  /** Called with each emoji the completion inserted, for example to remember it with `rememberEmoji`. */
  onPick?: (emoji: string) => void;
};
