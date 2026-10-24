import { type DateContext, dates } from "@k2b/stdlib";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationSchema } from "../service/contracts";

type At = string | Date;
export const messageTime = (at: At, dateConfig: DateContext): string => dates.formatTime(at, dateConfig);
export const sameDay = (a: At, b: At, dateConfig: DateContext): boolean =>
  dates.formatDateKey(a, dateConfig) === dates.formatDateKey(b, dateConfig);
// Compare calendar dates after resolving the reader's zone, so DST days do not count as 23 or 25 hours.
const daysAgo = (at: At, now: Date, dateConfig: DateContext) =>
  (Date.parse(dates.formatDateKey(now, dateConfig)) - Date.parse(dates.formatDateKey(at, dateConfig))) / 86_400_000;
const format = (at: At, dateConfig: DateContext, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(dateConfig.locale ?? "en", { ...options, timeZone: dateConfig.timeZone }).format(new Date(at));
const sameYear = (at: At, now: Date, dateConfig: DateContext) =>
  dates.formatDateKey(at, dateConfig).slice(0, 4) === dates.formatDateKey(now, dateConfig).slice(0, 4);
export const dayLabel = (at: At, now: Date, dateConfig: DateContext): string => {
  const t = chatMessages.resolve(dateConfig.locale ? [dateConfig.locale] : []).t;
  const days = daysAgo(at, now, dateConfig);
  if (days === 0) return t.today;
  if (days === 1) return t.yesterday;
  if (days >= 2 && days <= 6) return format(at, dateConfig, { weekday: "long" });
  return format(at, dateConfig, { day: "numeric", month: "long", ...(sameYear(at, now, dateConfig) ? {} : { year: "numeric" }) });
};
export const listTime = (at: At, now: Date, dateConfig: DateContext): string => {
  const days = daysAgo(at, now, dateConfig);
  if (days === 0) return messageTime(at, dateConfig);
  if (days === 1) return chatMessages.resolve(dateConfig.locale ? [dateConfig.locale] : []).t.yesterday;
  if (days >= 2 && days <= 6) return format(at, dateConfig, { weekday: "short" });
  return format(at, dateConfig, { day: "numeric", month: "short", ...(sameYear(at, now, dateConfig) ? {} : { year: "2-digit" }) });
};
export const lastMessageLine = (conversation: z.infer<typeof ConversationSchema>, viewerId: string, locale: string): string => {
  const t = chatMessages.resolve([locale]).t;
  const message = conversation.lastMessage;
  if (!message) return t.noMessagesYet;
  const line =
    message.author.id === viewerId
      ? t.ownPreview({ text: message.preview })
      : conversation.memberCount <= 2
        ? message.preview
        : t.senderPreview({ name: message.author.name.trim().split(/\s+/u)[0] ?? "", text: message.preview });
  // In a chat with threads, the preview names the thread first: "Problems · Jonas: Done".
  return conversation.threads > 0 && message.thread ? t.threadPreview({ thread: message.thread.name, line }) : line;
};
