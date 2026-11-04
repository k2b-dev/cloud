import { type DateContext, dates, i18n } from "@k2b/stdlib";
import type { StatusTone } from "@k2b/ui";
import { messageForwardTextOf } from "../../forward-text";
import type { MessageDeliveryState, MessageDetail } from "../../service/messages";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import type { MailReadingFormat } from "./mail-user-preferences";

type PlainMessageSegment = {
  kind: "content" | "quote";
  text: string;
};

export type PlainTextLinkSegment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

export type MessageBodyFormat = "html" | "plain";
export type MessageColors = "adapted" | "original";

export const resolveMessageColors = (preferred: MailReadingFormat, override: MessageColors | null): MessageColors =>
  override ?? (preferred === "html" ? "original" : "adapted");

export { attachmentPreviewKind } from "../../attachment-preview-policy";

export const formatMailMessageDateTime = (input: string | Date, context: DateContext): string =>
  `${dates.formatTime(input, context)} ${dates.formatDate(input, context)}`;

const QUOTED_LINE = /^\s*>/u;
const SIGNATURE_DELIMITER = /^-- ?$/u;
/** Lines such as "---------- Forwarded message ---------" that mail programs put above a forwarded original. */
export const FORWARD_MARKER =
  /forwarded message|weitergeleitete nachricht|anfang der weitergeleiteten nachricht|message transf[ée]r[ée]|mensaje reenviado|messaggio inoltrato|doorgestuurd bericht/iu;
/** The verb of an attribution such as "On Monday, Alex wrote:" or "Am Montag schrieb Alex:". */
export const ATTRIBUTION_VERB = /wrote|schrieb|écrit|escribió|scrisse|schreef|skrev/iu;
/** A short paragraph that ends with a colon and names who wrote the quote below it. */
export const isAttribution = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.length <= 300 && trimmed.split("\n").length <= 3 && trimmed.endsWith(":") && ATTRIBUTION_VERB.test(trimmed);
};
const PLAIN_WEB_URL = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const CID_SOURCE = /\bsrc=(["'])cid:([^"']+)\1/giu;
const REMOTE_IMAGE_ATTRIBUTE =
  /\bdata-mail-remote-image=(["'])([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\1/giu;

// Hydration stores a Content-ID without NUL, which Postgres cannot hold, so a `cid:` source that
// encodes one as %00 drops it too.
export const normalizeContentId = (value: string): string => value.replaceAll("\u0000", "").trim().replace(/^<|>$/gu, "").toLowerCase();

const contentIdFromSource = (rawContentId: string): string => {
  try {
    return normalizeContentId(decodeURIComponent(rawContentId));
  } catch {
    // Malformed percent escapes cannot match a normalized MIME Content-ID.
    return normalizeContentId(rawContentId);
  }
};

const escapeHtmlAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const referencedContentIds = (html: string): string[] => {
  const ids = new Set<string>();
  for (const match of html.matchAll(CID_SOURCE)) {
    const normalized = match[2] ? contentIdFromSource(match[2]) : "";
    if (normalized) ids.add(normalized);
  }
  return [...ids];
};

const MAX_INLINE_IMAGE_COUNT = 32;
const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * The attachments an HTML body shows in place: images its `cid:` sources name, within the count and byte budget the
 * message frame loads. The attachment list leaves exactly these out, so an image never appears twice.
 */
export const inlineBodyImages = <T extends { contentId: string | null; contentType: string; sizeBytes: number }>(
  html: string,
  attachments: readonly T[],
): T[] => {
  const referenced = new Set(referencedContentIds(html));
  let selectedBytes = 0;
  return attachments
    .filter((attachment) => {
      if (!attachment.contentId || !attachment.contentType.toLowerCase().startsWith("image/")) return false;
      if (!referenced.has(normalizeContentId(attachment.contentId))) return false;
      if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) return false;
      if (selectedBytes + attachment.sizeBytes > MAX_INLINE_IMAGE_BYTES) return false;
      selectedBytes += attachment.sizeBytes;
      return true;
    })
    .slice(0, MAX_INLINE_IMAGE_COUNT);
};

/**
 * Replaces unloadable `cid:` sources with the normalized Content-ID, so the
 * message frame can show inline images delivered by the parent later.
 */
export const markCidImageSources = (html: string): string =>
  html.replace(
    CID_SOURCE,
    (_source, _quote: string, rawContentId: string) => `data-mail-cid="${escapeHtmlAttribute(contentIdFromSource(rawContentId))}"`,
  );

export const referencedRemoteImageIds = (html: string): string[] => {
  const ids = new Set<string>();
  for (const match of html.matchAll(REMOTE_IMAGE_ATTRIBUTE)) {
    const id = match[2]?.toLowerCase();
    if (id) ids.add(id);
  }
  return [...ids];
};

/** Splits text into runs of `>` quoted lines and other lines; blank lines between quoted lines stay in the quote. */
const splitQuotedLineRuns = (value: string): PlainMessageSegment[] => {
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  const nextNonEmptyIsQuoted = new Array<boolean>(lines.length).fill(false);
  let nextIsQuoted = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    nextNonEmptyIsQuoted[index] = nextIsQuoted;
    const line = lines[index] ?? "";
    if (line.trim()) nextIsQuoted = QUOTED_LINE.test(line);
  }
  const segments: PlainMessageSegment[] = [];
  let currentKind: PlainMessageSegment["kind"] | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentKind || currentLines.length === 0) return;
    const text = currentLines.join("\n");
    if (text) segments.push({ kind: currentKind, text });
    currentLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const kind: PlainMessageSegment["kind"] =
      QUOTED_LINE.test(line) || (line.trim() === "" && currentKind === "quote" && nextNonEmptyIsQuoted[index]) ? "quote" : "content";
    if (kind !== currentKind) {
      flush();
      currentKind = kind;
    }
    currentLines.push(line);
  }
  flush();
  return segments;
};

const firstNonEmptyLine = (value: string): string => value.split("\n").find((line) => line.trim()) ?? "";

/**
 * Splits plain text into visible content and the quoted history at its end. Only the last `>` block counts as
 * history: the sender wrote something of their own above it, nothing but blank lines or a "-- " signature follows
 * it, and it is either the only quote or introduced by an attribution such as "On Monday, Alex wrote:". Inline
 * answers, bottom-posted replies, a lone `>` line, quote-only messages, and forwarded originals stay visible.
 */
export const splitPlainMessageSegments = (value: string): PlainMessageSegment[] => {
  const runs = splitQuotedLineRuns(value);
  const historyIndex = runs.findLastIndex((run) => run.kind === "quote");
  const history = runs[historyIndex];
  const before = runs
    .slice(0, Math.max(0, historyIndex))
    .map((run) => run.text)
    .join("\n");
  const after = runs
    .slice(historyIndex + 1)
    .map((run) => run.text)
    .join("\n");
  const beforeLines = before.trimEnd().split("\n");
  const attributionStart = beforeLines.findLastIndex((line) => !line.trim()) + 1;
  const attributed = isAttribution(beforeLines.slice(attributionStart).join("\n"));
  const own = attributed ? beforeLines.slice(0, attributionStart).join("\n") : before;
  const isHistory =
    history !== undefined &&
    own.trim() !== "" &&
    (!after.trim() || SIGNATURE_DELIMITER.test(firstNonEmptyLine(after))) &&
    (attributed || runs.filter((run) => run.kind === "quote").length === 1) &&
    !FORWARD_MARKER.test(before) &&
    !FORWARD_MARKER.test(firstNonEmptyLine(history.text));
  const segments: PlainMessageSegment[] = [];
  const pushContent = (text: string) => {
    const previous = segments.at(-1);
    if (previous?.kind === "content") previous.text = `${previous.text}\n${text}`;
    else segments.push({ kind: "content", text });
  };
  runs.forEach((run, index) => {
    if (isHistory && index === historyIndex) segments.push(run);
    else pushContent(run.text);
  });
  return segments;
};

const trimTrailingUrlPunctuation = (value: string): string => {
  let result = value.replace(/[.,;:!?]+$/gu, "");
  for (const [opening, closing] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    while (result.endsWith(closing) && result.split(opening).length < result.split(closing).length) result = result.slice(0, -1);
  }
  return result;
};

export const splitPlainTextLinks = (value: string): PlainTextLinkSegment[] => {
  const segments: PlainTextLinkSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(PLAIN_WEB_URL)) {
    const index = match.index;
    const candidate = trimTrailingUrlPunctuation(match[0]);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    } catch {
      continue;
    }
    if (index > cursor) segments.push({ kind: "text", text: value.slice(cursor, index) });
    segments.push({ kind: "link", text: candidate, href: candidate });
    cursor = index + candidate.length;
  }
  if (cursor < value.length) segments.push({ kind: "text", text: value.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text: value }];
};

/**
 * Copied plain mail text as HTML paragraphs: blank lines separate paragraphs and other line breaks stay breaks.
 * Editors then keep the text's shape without reading it as a code block, or a tab as a table column.
 */
export const plainTextClipboardHtml = (text: string): string =>
  text
    .replace(/\r\n?/gu, "\n")
    .split(/\n(?:[^\S\n]*\n)+/u)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => `<p>${paragraph.split("\n").map(escapeHtmlAttribute).join("<br>")}</p>`)
    .join("");

export const messagePreviewText = (plainText: string | null, forwardText: string | undefined, maxLength = 240): string => {
  const source = messageForwardTextOf({ plainText, forwardText });
  const content = splitQuotedLineRuns(source).find((segment) => segment.kind === "content" && segment.text.trim())?.text ?? source;
  const normalized = content.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : normalized;
};

export const resolveMessageBodyFormat = (
  preferred: MailReadingFormat,
  override: MessageBodyFormat | null,
  htmlAvailable: boolean,
  plainAvailable: boolean,
): MessageBodyFormat | null => {
  const requested = override ?? (preferred === "plain" ? "plain" : "html");
  if (requested === "html" && htmlAvailable) return "html";
  if (requested === "plain" && plainAvailable) return "plain";
  if (htmlAvailable) return "html";
  if (plainAvailable) return "plain";
  return null;
};

type MessageDelivery = NonNullable<MessageDetail["delivery"]>;
type MessageDeliveryInput = MessageDeliveryState | MessageDelivery;

const deliveryState = (input: MessageDeliveryInput): MessageDeliveryState => (typeof input === "string" ? input : input.state);

const deliveryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tryingAgain: ({ attempt, total }: { attempt: number; total: number }) => `Trying again · ${attempt}/${total}`,
      tryingAgainLater: "Trying again",
      waitingForSignIn: "Waiting for sign-in",
      scheduled: "Scheduled",
      sending: "Sending",
      sendingAttempt: ({ attempt, total }: { attempt: number; total: number }) => `Sending · ${attempt}/${total}`,
      couldNotSend: "Couldn’t send",
      deliveryUnclear: "Delivery status unclear",
      partiallySent: "Partially sent",
      sentNotSaved: "Sent, but not saved",
      needsAttention: "Needs attention",
      cancelled: "Cancelled",
      undoSend: "Undo send",
    },
    de: {
      tryingAgain: ({ attempt, total }) => `Erneuter Versuch · ${attempt}/${total}`,
      tryingAgainLater: "Wird erneut versucht",
      waitingForSignIn: "Wartet auf Anmeldung",
      scheduled: "Geplant",
      sending: "Wird gesendet",
      sendingAttempt: ({ attempt, total }) => `Wird gesendet · ${attempt}/${total}`,
      couldNotSend: "Konnte nicht gesendet werden",
      deliveryUnclear: "Versandstatus unklar",
      partiallySent: "Teilweise gesendet",
      sentNotSaved: "Gesendet, aber nicht gespeichert",
      needsAttention: "Handlungsbedarf",
      cancelled: "Abgebrochen",
      undoSend: "Senden rückgängig machen",
    },
  },
});

export const messageDeliveryPresentation = (
  delivery: MessageDeliveryInput,
  locale = "en",
): { label: string; icon: string; tone: StatusTone } | null => {
  const t = deliveryMessages.resolve([locale]).t;
  const state = deliveryState(delivery);
  switch (state) {
    case "scheduled":
      if (typeof delivery !== "string" && delivery.lastErrorCode === "MAILBOX_AUTH_REQUIRED") {
        return { label: t.waitingForSignIn, icon: "ti ti-lock", tone: "warning" };
      }
      // A temporary rejection has its own retry window, so an attempt count would mislead.
      if (typeof delivery !== "string" && delivery.lastErrorCode === "SMTP_TRANSIENT_REJECTION") {
        return { label: t.tryingAgainLater, icon: "ti ti-refresh", tone: "warning" };
      }
      return typeof delivery !== "string" && delivery.lastErrorCode
        ? {
            label: t.tryingAgain({ attempt: delivery.attempt, total: delivery.maxAttempts }),
            icon: "ti ti-refresh",
            tone: "warning",
          }
        : { label: t.scheduled, icon: "ti ti-clock", tone: "neutral" };
    case "undo_window":
      return null;
    case "sending":
      return {
        label: typeof delivery === "string" ? t.sending : t.sendingAttempt({ attempt: delivery.attempt, total: delivery.maxAttempts }),
        icon: "ti ti-loader-2",
        tone: "running",
      };
    case "accepted":
    case "sent_sync_pending":
    case "sent":
    case "reconciled_accepted":
      return null;
    case "failed":
    case "reconciled_unsent":
      return { label: t.couldNotSend, icon: "ti ti-alert-circle", tone: "error" };
    case "unknown":
      return { label: t.deliveryUnclear, icon: "ti ti-alert-triangle", tone: "warning" };
    case "needs_attention":
      return {
        label:
          typeof delivery !== "string" && delivery.lastErrorCode === "SMTP_PARTIAL_ACCEPTANCE"
            ? t.partiallySent
            : typeof delivery !== "string" &&
                ["SENT_APPEND_FAILED", "SENT_COPY_LEASE_EXPIRED", "SENT_RECONCILIATION_FAILED"].includes(delivery.lastErrorCode ?? "")
              ? t.sentNotSaved
              : t.needsAttention,
        icon: "ti ti-alert-triangle",
        tone: "warning",
      };
    case "cancelled":
      return { label: t.cancelled, icon: "ti ti-ban", tone: "neutral" };
  }
};

export const messageDeliveryControlLabel = (delivery: MessageDeliveryInput, canWrite: boolean, locale = "en"): string | null => {
  const t = deliveryMessages.resolve([locale]).t;
  const state = deliveryState(delivery);
  if (state === "undo_window") return canWrite ? t.undoSend : null;
  if (state === "scheduled") return messageDeliveryPresentation(delivery, locale)?.label ?? null;
  if (["failed", "unknown", "reconciled_unsent", "needs_attention"].includes(state)) {
    return messageDeliveryPresentation(delivery, locale)?.label ?? null;
  }
  return null;
};

export const messageDeliveryAllowsResponses = (state: MessageDeliveryState): boolean =>
  state === "accepted" || state === "sent_sync_pending" || state === "sent" || state === "reconciled_accepted";

export const undoSendSecondsRemaining = (undoUntil: string | null, now: number): number | null => {
  if (!undoUntil) return null;
  const deadline = Date.parse(undoUntil);
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
};

/** Why a send failed, from its error code, as the reader and the mailbox's event feed both name it. */
export const mailSendFailureReason = (code: string | null | undefined, locale = "en"): string => {
  const t = mailConversationUiMessages.resolve([locale]).t;
  const value = code ?? "";
  if (["SMTP_NO_RECIPIENTS_ACCEPTED", "EENVELOPE"].includes(value)) return t.recipientsRejected;
  if (value.includes("AUTH") || value.includes("CREDENTIAL")) return t.authenticationFailed;
  if (value.includes("SIZE") || value === "SMTP_DSN_UNSUPPORTED") return t.unsupportedDelivery;
  if (value.includes("ACCESS") || value.includes("IDENTITY")) return t.sendingAccessChanged;
  return t.notDelivered;
};
