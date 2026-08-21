import type { Message, Usage } from "@k2b/nessi";
import { fileIcons } from "@k2b/stdlib";
import { formatBytes as sharedFormatBytes } from "../../shared/format";
import { type AiAttachmentRef, parseAiAttachmentMarkers } from "../attachments";
import { AI_IMAGE_INPUT_MAX_BYTES, AI_TURN_ATTACHMENT_MAX_ITEMS } from "../limits";
import { type AiResourceMarker, parseAiResourceMarker } from "../resource-markers";
import { assistantVisibleTextFromMessage } from "../timeline";
import type { AiStoredMessage, AiUserContentPart } from "../types";
import { AI_IMAGE_MEDIA_TYPES, isAiImageMediaType } from "../types";

type AssistantToolResultMessage = Extract<Message, { role: "tool_result" }>;

export type AiRetryMessageInput = {
  mode?: "retry" | "details" | "concise";
  content?: AiUserContentPart[];
};

export type AiForkMessageInput = {
  title?: string;
};

export type AiComposerAttachment =
  | {
      kind: "image";
      id: string;
      name: string;
      size: number;
      mediaType: string;
      data: string;
      file: File;
    }
  | {
      // Any non-image file: uploaded into conversation files on
      // send, referenced by path — never inlined into the model context.
      kind: "file";
      id: string;
      name: string;
      size: number;
      mediaType: string;
      file: File;
      icon: string;
    }
  | {
      kind: "stored-file";
      id: string;
      name: string;
      size: number;
      mediaType: string;
      path: string;
      version: number;
      icon: string;
    }
  | {
      kind: "resource";
      id: string;
      name: string;
      ref: { type: string; id: string };
      icon: string;
      href?: string;
    };

export type PendingAiImage = Extract<AiComposerAttachment, { kind: "image" }>;
export type PendingAiVfsFile = Extract<AiComposerAttachment, { kind: "file" }>;
export type PendingAiAttachment = AiComposerAttachment;

export const MAX_ATTACHMENTS = AI_TURN_ATTACHMENT_MAX_ITEMS;
export const IMAGE_MAX_BYTES = AI_IMAGE_INPUT_MAX_BYTES;
export const VFS_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_CONTEXT_PREFIX = "Attached files for this message:";
export const TEXT_ATTACHMENT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "html",
  "css",
  "yaml",
  "yml",
  "xml",
  "log",
] as const;
export const DOCUMENT_ATTACHMENT_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "odt",
  "ppt",
  "pptx",
  "odp",
  "xlsx",
  "ods",
  "rtf",
  "epub",
  "csv",
] as const;
export const TEXT_ATTACHMENT_MEDIA_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
]);
export const FILE_INPUT_ACCEPT = [
  ...AI_IMAGE_MEDIA_TYPES,
  "text/*",
  ...Array.from(TEXT_ATTACHMENT_MEDIA_TYPES),
  ...Array.from(new Set([...TEXT_ATTACHMENT_EXTENSIONS, ...DOCUMENT_ATTACHMENT_EXTENSIONS]), (extension) => `.${extension}`),
].join(",");

/** Seconds-granular work duration ("8s", "2m 14s") — stdlib's dates.formatDuration is deliberately minute-granular. */
export const formatWorkedDuration = (ms: number): string => {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
};

export const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
};

export const textFromMessage = (message: Message): string => {
  if (message.role === "tool_result") return typeof message.result === "string" ? message.result : JSON.stringify(message.result, null, 2);
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      return "";
    })
    .join("")
    .trim();
};

export const userVisibleTextFromMessage = (message: Message): string => {
  if (message.role !== "user") return textFromMessage(message);
  return message.content
    .map((part) => {
      const text = typeof part === "string" ? part : part.type === "text" ? part.text : "";
      if (text.startsWith(ATTACHMENT_CONTEXT_PREFIX)) return "";
      if (parseAiResourceMarker(text)) return "";
      return parseAiAttachmentMarkers(text).text;
    })
    .join("")
    .trim();
};

/** VFS attachments referenced by this user message (rendered as chips). */
export const vfsAttachmentsFromMessage = (message: Message): (AiAttachmentRef & { name: string; icon: string })[] => {
  if (message.role !== "user") return [];
  return message.content.flatMap((part) => {
    const text = typeof part === "string" ? part : part.type === "text" ? part.text : "";
    return parseAiAttachmentMarkers(text).attachments.map((attachment) => {
      const name = attachment.path.slice(attachment.path.lastIndexOf("/") + 1);
      return { ...attachment, name, icon: fileIcons.getFileIcon({ name, type: "file", mimeType: attachment.mediaType }) };
    });
  });
};

export const resourcesFromMessage = (message: Message): AiResourceMarker[] => {
  if (message.role !== "user") return [];
  return message.content.flatMap((part) => {
    const text = typeof part === "string" ? part : part.type === "text" ? part.text : "";
    const resource = parseAiResourceMarker(text);
    return resource ? [resource] : [];
  });
};

export const isAttachmentContextPart = (part: AiUserContentPart): boolean => {
  const text = typeof part === "string" ? part : part.type === "text" ? part.text : "";
  if (text.startsWith(ATTACHMENT_CONTEXT_PREFIX)) return true;
  if (parseAiResourceMarker(text)) return true;
  return parseAiAttachmentMarkers(text).attachments.length > 0 && !parseAiAttachmentMarkers(text).text;
};

export const userContentWithEditedVisibleText = (message: Message, text: string): AiUserContentPart[] => {
  if (message.role !== "user") return text.trim() ? [{ type: "text", text: text.trim() }] : [];
  const preserved = message.content.filter((part) => {
    if (typeof part === "string") return isAttachmentContextPart(part);
    return isAttachmentContextPart(part);
  });
  const visible = text.trim();
  return visible ? [{ type: "text", text: visible }, ...preserved] : preserved;
};

export const imageSrc = (part: { mediaType: string; data: string }) => `data:${part.mediaType};base64,${part.data}`;

export const cleanFileName = (name: string): string => name.replace(/[\r\n]+/g, " ").trim() || "untitled";

export const textAttachmentSummariesFromMessage = (message: Message) => {
  if (message.role !== "user") return [];
  return message.content.flatMap((part) => {
    const text = typeof part === "string" ? part : part.type === "text" ? part.text : "";
    if (!text.startsWith(ATTACHMENT_CONTEXT_PREFIX)) return [];
    return text
      .split("\n")
      .map((line) => /^--- file: (.+?) \((.+?), (.+?)\) ---$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => ({
        name: match[1] ?? "file",
        mediaType: match[2] ?? "text/plain",
        size: match[3] ?? "",
        icon: fileIcons.getFileIcon({ name: match[1] ?? "file", type: "file", mimeType: match[2] ?? "text/plain" }),
      }));
  });
};

export type AiLatestUsageSnapshot = {
  request: Usage;
  loop: Usage;
  modelProfileId: string | null;
};

export const latestUsageSnapshot = (messages: AiStoredMessage[]): AiLatestUsageSnapshot | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    const request = entry?.loopAggregate?.turns.findLast((turn) => Boolean(turn.usage))?.usage ?? entry?.usage;
    if (request) {
      return {
        request,
        loop: entry?.loopAggregate?.usage ?? entry?.usage ?? request,
        modelProfileId: entry?.modelProfileId ?? null,
      };
    }
  }
  return null;
};

export const latestUsage = (messages: AiStoredMessage[]): Usage | null => latestUsageSnapshot(messages)?.request ?? null;

export const latestLoopUsage = (messages: AiStoredMessage[]): Usage | null => latestUsageSnapshot(messages)?.loop ?? null;

export const copyTextFromMessage = (message: Message): string => {
  if (message.role === "user") return userVisibleTextFromMessage(message);
  if (message.role === "assistant") return assistantVisibleTextFromMessage(message);
  return textFromMessage(message);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const isCardToolName = (name: string) => name === "card" || name === "cloud_card";

export const isSurveyToolName = (name: string) => name === "survey" || name === "cloud_survey";

export const isTextEditorToolName = (name: string) => name === "text_editor" || name === "cloud_text_editor";

export const displayToolName = (name: string) => {
  if (isCardToolName(name)) return "card";
  if (isSurveyToolName(name)) return "survey";
  if (isTextEditorToolName(name)) return "text editor";
  if (name === "local_bash") return "Local Bash";
  const words = name.split("_").filter(Boolean).join(" ");
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
};

const BUILT_IN_TOOL_ICONS = new Map<string, string>([
  ["card", "ti ti-layout-cards"],
  ["cloud_card", "ti ti-layout-cards"],
  ["survey", "ti ti-forms"],
  ["cloud_survey", "ti ti-forms"],
  ["text_editor", "ti ti-edit"],
  ["cloud_text_editor", "ti ti-edit"],
  ["local_bash", "ti ti-terminal-2"],
  ["list_files", "ti ti-file-spark"],
  ["read_file", "ti ti-file-spark"],
  ["write_file", "ti ti-file-spark"],
  ["fetch_file", "ti ti-world-download"],
  ["markdown_to_pdf", "ti ti-file-type-pdf"],
  ["present", "ti ti-file-spark"],
  ["calculate", "ti ti-calculator"],
  ["web_search", "ti ti-search"],
  ["web_extract", "ti ti-world-download"],
  ["view_image", "ti ti-photo-spark"],
  ["memory", "ti ti-brain"],
  ["search_project", "ti ti-folder-search"],
  ["read_project_knowledge", "ti ti-notebook"],
  ["search_help", "ti ti-help-hexagon"],
  ["read_help", "ti ti-help-hexagon"],
  ["search_tools", "ti ti-ai-gateway"],
  ["load_tools", "ti ti-ai-gateway"],
  ["load_skill", "ti ti-sparkles"],
  ["list_apps", "ti ti-apps"],
  ["read_cloud_resource", "ti ti-ai-gateway"],
]);

export const aiToolIcon = (name: string, appIcon?: string | null): string => {
  if (appIcon) return appIcon;
  return BUILT_IN_TOOL_ICONS.get(name) ?? (/__(?:query|action)__/.test(name) ? "ti ti-ai-gateway" : "ti ti-tool");
};

export const jsonPreview = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const isWebSearchResultList = (value: unknown): value is { title?: unknown; url?: unknown; snippet?: unknown }[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => isRecord(item) && "url" in item);

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** Human-readable tool detail text: search results as a numbered list, page extracts as labeled fields, flat objects as key/value lines, JSON only as the fallback. */
export const formatToolDetailText = (toolName: string, value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;

  if (toolName === "web_search" && isWebSearchResultList(value)) {
    return value
      .map(
        (item, index) =>
          `${index + 1}. ${stringOf(item.title) || "Untitled"}\n   Url: ${stringOf(item.url)}\n   Snippet: ${stringOf(item.snippet)}`,
      )
      .join("\n\n");
  }

  if (toolName === "web_extract" && isRecord(value) && typeof value.content === "string") {
    const lines = [
      `Url: ${stringOf(value.url)}`,
      ...(value.title ? [`Title: ${stringOf(value.title)}`] : []),
      ...(value.description ? [`Description: ${stringOf(value.description)}`] : []),
    ];
    return `${lines.join("\n")}\n\n${value.content}${value.truncated === true ? " (truncated)" : ""}`;
  }

  // Flat objects read better as key/value lines than as JSON.
  if (isRecord(value) && Object.values(value).every((entry) => entry === null || typeof entry !== "object")) {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${typeof entry === "string" ? entry : JSON.stringify(entry)}`)
      .join("\n");
  }

  return jsonPreview(value);
};

/** Short row description for a finished tool call. */
export const toolBlockSummary = (result: unknown): string => {
  if (Array.isArray(result)) return `${result.length} result${result.length === 1 ? "" : "s"}`;
  if (typeof result === "string") return result.slice(0, 80);
  if (isRecord(result)) {
    if (typeof result.message === "string" && result.message.trim()) return result.message.slice(0, 80);
    return Object.keys(result).slice(0, 4).join(", ");
  }
  return "";
};

export type MemoryToolPresentation = {
  label: string;
  description: string;
  failed: boolean;
};

export type FetchFileErrorPresentation = {
  label: string;
  description: string;
};

const boundedErrorText = (value: string): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
};

/** Canonical capability failure text for the compact chat row. Raw input and output remain in the audit trail. */
export const capabilityErrorDescription = (result: unknown): string => {
  if (typeof result === "string") return boundedErrorText(result) || "The action could not be completed.";
  if (isRecord(result)) {
    const message = typeof result.message === "string" ? result.message : typeof result.error === "string" ? result.error : "";
    const code = typeof result.code === "string" ? result.code : "";
    const text = code && message && !message.startsWith(code) ? `${code}: ${message}` : message || code;
    if (text) return boundedErrorText(text);
  }
  return "The action could not be completed.";
};

/** Compact user-facing copy for fetch_file failures; the full response remains in the disclosure and audit trail. */
export const fetchFileErrorPresentation = (result: unknown): FetchFileErrorPresentation => {
  const message =
    typeof result === "string"
      ? result.trim()
      : isRecord(result) && typeof (result.error ?? result.message) === "string"
        ? String(result.error ?? result.message).trim()
        : "";
  const separator = message.indexOf(" — ");
  if (separator > 0) {
    return { label: message.slice(0, separator), description: message.slice(separator + 3) };
  }
  return {
    label: "File download failed",
    description: message || "The linked file could not be imported into this chat.",
  };
};

/** End-user copy for memory updates; full tool input/result remains available in persisted audit data. */
export const memoryToolPresentation = (args: unknown, result: unknown): MemoryToolPresentation | null => {
  if (!isRecord(args) || !["list", "search", "add", "update", "delete"].includes(String(args.action))) return null;
  if (!isRecord(result) || typeof result.ok !== "boolean" || typeof result.message !== "string") return null;

  if (!result.ok) return { label: "Memory not updated", description: result.message, failed: true };
  if (args.action === "add")
    return { label: "Remembered", description: typeof args.content === "string" ? args.content.trim() : result.message, failed: false };
  if (args.action === "update")
    return { label: "Updated memory", description: result.message.replace(/^Updated memory:\s*/, ""), failed: false };
  if (args.action === "delete")
    return { label: "Forgot memory", description: result.message.replace(/^Forgot memory:\s*/, ""), failed: false };
  return { label: args.action === "search" ? "Searched memories" : "Listed memories", description: result.message, failed: false };
};

export const toolResultSummary = (message: AssistantToolResultMessage | null | undefined): string => {
  if (!message) return "Tool result";
  const content = textFromMessage(message);
  const firstIssue = /Issues:\s*\n1\.\s*([^\n]+)/.exec(content)?.[1];
  if (firstIssue) return firstIssue;
  const firstLine = content.split("\n").find((line) => line.trim());
  if (firstLine) {
    const line = firstLine.trim();
    if (line.startsWith("{") || line.startsWith("[")) return message.isError ? "Tool failed" : "Tool result";
    return line.slice(0, 160);
  }
  return message.isError ? "Tool failed" : "Tool result";
};

export const readImageFile = (file: File): Promise<PendingAiImage> => {
  if (!isAiImageMediaType(file.type)) throw new Error(`${file.name} must be PNG, JPEG, WebP, or GIF.`);
  if (file.size > IMAGE_MAX_BYTES) throw new Error(`${file.name} is larger than ${formatBytes(IMAGE_MAX_BYTES)}.`);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}.`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({
        kind: "image",
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        size: file.size,
        mediaType: file.type,
        data,
        file,
      });
    };
    reader.readAsDataURL(file);
  });
};

/** Wrap any non-image file for deferred upload into the conversation VFS. */
export const readVfsFile = (file: File): PendingAiVfsFile => {
  if (file.size > VFS_FILE_MAX_BYTES) throw new Error(`${file.name} is larger than ${formatBytes(VFS_FILE_MAX_BYTES)}.`);
  const mediaType = file.type || "application/octet-stream";
  return {
    kind: "file",
    id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: cleanFileName(file.name),
    size: file.size,
    mediaType,
    file,
    icon: fileIcons.getFileIcon({ name: file.name, type: "file", mimeType: mediaType }),
  };
};

/** Re-exported for existing callers; the implementation is shared. */
export const formatBytes = (bytes: number): string => sharedFormatBytes(bytes);
