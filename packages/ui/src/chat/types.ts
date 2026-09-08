export type ChatRole = "user" | "assistant" | "system" | "tool";

export type ChatMessageStatus = "pending" | "streaming" | "complete" | "error";

export type ChatActivityTone = "neutral" | "ai" | "success" | "danger";

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
};
