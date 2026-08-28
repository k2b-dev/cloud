import { type DateContext, dates, i18n } from "@k2b/stdlib";
import type { StatusTone } from "@k2b/ui";
import type { CloudTheme } from "@valentinkolb/cloud/shared";
import type { MessageDeliveryState, MessageDetail } from "../../service/messages";
import type { MailReadingFormat } from "./mail-user-preferences";

type PlainMessageSegment = {
  kind: "content" | "quote";
  text: string;
};

export type PlainTextLinkSegment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

export type MessageBodyFormat = "html" | "plain";

export { attachmentPreviewKind } from "../../attachment-preview-policy";

export const formatMailMessageDateTime = (input: string | Date, context: DateContext): string =>
  `${dates.formatTime(input, context)} ${dates.formatDate(input, context)}`;

const QUOTED_LINE = /^\s*>/u;
const PLAIN_WEB_URL = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const CID_SOURCE = /\bsrc=(["'])cid:([^"']+)\1/giu;
const REMOTE_IMAGE_ATTRIBUTE =
  /\bdata-mail-remote-image=(["'])([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\1/giu;

export const normalizeContentId = (value: string): string => value.trim().replace(/^<|>$/gu, "").toLowerCase();

export const referencedContentIds = (html: string): string[] => {
  const ids = new Set<string>();
  for (const match of html.matchAll(CID_SOURCE)) {
    const rawContentId = match[2];
    if (!rawContentId) continue;
    let decoded = rawContentId;
    try {
      decoded = decodeURIComponent(rawContentId);
    } catch {
      // Malformed percent escapes cannot match a normalized MIME Content-ID.
    }
    const normalized = normalizeContentId(decoded);
    if (normalized) ids.add(normalized);
  }
  return [...ids];
};

export const rewriteCidSources = (html: string, urls: ReadonlyMap<string, string>): string =>
  html.replace(CID_SOURCE, (source, quote: string, rawContentId: string) => {
    let decoded = rawContentId;
    try {
      decoded = decodeURIComponent(rawContentId);
    } catch {
      // Malformed percent escapes cannot match a normalized MIME Content-ID.
    }
    const url = urls.get(normalizeContentId(decoded));
    return url ? `src=${quote}${url}${quote}` : source;
  });

export const referencedRemoteImageIds = (html: string): string[] => {
  const ids = new Set<string>();
  for (const match of html.matchAll(REMOTE_IMAGE_ATTRIBUTE)) {
    const id = match[2]?.toLowerCase();
    if (id) ids.add(id);
  }
  return [...ids];
};

export const rewriteRemoteImageSources = (html: string, urls: ReadonlyMap<string, string>): string =>
  html.replace(REMOTE_IMAGE_ATTRIBUTE, (attribute, _quote: string, rawId: string) => {
    const url = urls.get(rawId.toLowerCase());
    return url ? `src="${url}" ${attribute}` : attribute;
  });

export const splitPlainMessageSegments = (value: string): PlainMessageSegment[] => {
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

export const messagePreviewText = (plainText: string | null, forwardText: string, maxLength = 240): string => {
  const source = plainText?.trim() ? plainText : forwardText;
  const content = splitPlainMessageSegments(source).find((segment) => segment.kind === "content" && segment.text.trim())?.text ?? source;
  const normalized = content.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : normalized;
};

export const resolveMessageBodyFormat = (
  preferred: MailReadingFormat,
  override: MessageBodyFormat | null,
  theme: CloudTheme,
  htmlAvailable: boolean,
  plainAvailable: boolean,
): MessageBodyFormat | null => {
  const requested = override ?? (preferred === "automatic" ? (theme === "dark" ? "plain" : "html") : preferred);
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
