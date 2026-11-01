import type { DateContext } from "@k2b/stdlib";
import type { SpaceItem, SpaceItemTemplate, SpaceTaskChecklistEntry, TemplateWeekday } from "@/contracts";
import { isDateOnlyDeadline } from "@/presentation/deadline";
import type { TemplateSuggestions } from "./TemplatesSection";

type Draft = Omit<SpaceItemTemplate, "id" | "spaceId" | "createdAt" | "updatedAt">;

/** A week number in a title, such as "KW 44", "CW44", or "Week 44". */
const WEEK = /\b(KW|CW|Week|Woche)\s?(\d{1,2})\b/i;
/** A date in a title, such as "1.11.", "01.11.2026", or "2026-11-01". */
const DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.(?:\d{2,4})?)/;

const WEEKDAYS: TemplateWeekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const SHORT: Record<string, TemplateWeekday> = { Sun: "SU", Mon: "MO", Tue: "TU", Wed: "WE", Thu: "TH", Fri: "FR", Sat: "SA" };

/** The local time of day and weekday of an instant in the person's zone. */
const localParts = (iso: string, dateConfig?: DateContext) => {
  const timeZone = dateConfig?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
  const weekday = SHORT[new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(date)]!;
  return { time, weekday };
};

/**
 * A new template's values from an item: its title, description, tags, assignees with access, priority, checklist with
 * unchecked boxes, estimate or length, place, link, and time of day. The concrete date, comments, attachments, and links
 * stay behind; a week or date in the title and the weekday it was due on are only suggested.
 */
export const templateFromItem = (
  item: SpaceItem,
  options: { checklist?: readonly SpaceTaskChecklistEntry[]; assigneesWithAccess?: ReadonlySet<string>; dateConfig?: DateContext },
): { draft: Draft; suggestions: TemplateSuggestions } => {
  const isEvent = Boolean(item.startsAt && item.endsAt);
  const week = item.title.match(WEEK);
  const date = week ? null : item.title.match(DATE);
  const title: TemplateSuggestions["title"] = week
    ? { text: week[0], replacement: `${week[1]} {{week}}`, token: "week" }
    : date
      ? { text: date[0], replacement: "{{date}}", token: "date" }
      : undefined;
  const name = (title ? item.title.replace(title.text, "") : item.title)
    .replace(/\s{2,}/g, " ")
    .replace(/[\s:–-]+$/, "")
    .trim();
  const assignees = (item.assignees ?? []).filter(
    (assignee) => !options.assigneesWithAccess || options.assigneesWithAccess.has(assignee.id),
  );
  const dropped = (item.assignees ?? []).filter((assignee) => !assignees.includes(assignee)).map((assignee) => assignee.displayName);
  // A timed due date or start gives the time of day and the weekday; a date-only due date gives the weekday alone.
  const timed = isEvent ? (item.allDay ? null : item.startsAt) : item.deadline && !isDateOnlyDeadline(item.deadline) ? item.deadline : null;
  const local = timed ? localParts(timed, options.dateConfig) : null;
  const weekday =
    local?.weekday ??
    (item.deadline && isDateOnlyDeadline(item.deadline) ? WEEKDAYS[new Date(`${item.deadline}T12:00:00Z`).getUTCDay()] : undefined);
  const minutes =
    isEvent && !item.allDay ? Math.round((new Date(item.endsAt!).getTime() - new Date(item.startsAt!).getTime()) / 60_000) : null;
  return {
    draft: {
      kind: isEvent ? "event" : "task",
      name: (name || item.title).slice(0, 100),
      icon: null,
      title: item.title,
      description: item.description ?? null,
      priority: item.priority ?? null,
      tags: item.tags ?? [],
      assignees,
      assignCreator: false,
      checklist: isEvent ? [] : (options.checklist ?? []).slice(0, 100).map((entry) => entry.label.slice(0, 500)),
      estimatedDurationMinutes: isEvent ? null : (item.estimatedDurationMinutes ?? null),
      location: isEvent ? (item.location ?? null) : null,
      url: isEvent ? (item.url ?? null) : null,
      // A multi-day event becomes a one-day template: a template has no length in days.
      allDay: isEvent && item.allDay,
      durationMinutes: minutes && minutes > 0 ? minutes : null,
      timeOfDay: local?.time ?? null,
      dateRule: { type: "none" },
    },
    suggestions: { title, weekday, fromItem: { dropped } },
  };
};
