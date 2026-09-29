import { notification } from "@k2b/cloud";
import { coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { dates, i18n } from "@k2b/stdlib";
import { z } from "zod";
import { VenueResourceIdSchema } from "./contracts";
import { assignmentSelectionId, scheduleHref, slotSelectionId } from "./frontend/schedule-url";
import { formatVenueSpan, formatVenueWeekdayTime } from "./time-format";

/**
 * Venue's platform notifications. Titles carry what matters on a lock screen, because browser notifications
 * show only the title; the body adds the shift and its day for email and the notification history.
 */
const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      freeTime: "Free time",
      reminderTitle: ({ when, venue }: { when: string; venue: string }) => `Your shift ${when} · ${venue}`,
      reminderBody: ({ shift, span }: { shift: string; span: string }) =>
        `${shift}, ${span}. If you can't make it, leave the shift in Venues so someone else can take it.`,
      leftTitle: ({ person, when, venue }: { person: string; when: string; venue: string }) => `${person} left ${when} · ${venue}`,
      leftBody: ({ person, shift, span }: { person: string; shift: string; span: string }) =>
        `${person} left “${shift}”, ${span}. The spot is free again.`,
      removedTitle: ({ person, when, venue }: { person: string; when: string; venue: string }) =>
        `${person} removed from ${when} · ${venue}`,
      removedBody: ({ actor, person, shift, span }: { actor: string; person: string; shift: string; span: string }) =>
        `${actor} removed ${person} from “${shift}”, ${span}. The spot is free again.`,
      missing: ({ count }: { count: number }) => `${count} missing`,
      understaffedTitle: ({ missing, when, venue }: { missing: string; when: string; venue: string }) => `${missing} · ${when} · ${venue}`,
      closedUnlessStaffedTitle: ({ missing, when, venue }: { missing: string; when: string; venue: string }) =>
        `Closed unless staffed: ${missing} · ${when} · ${venue}`,
      understaffedBody: ({ shift, span, assigned, target }: { shift: string; span: string; assigned: number; target: string }) =>
        `“${shift}”, ${span}: ${assigned} of ${target} staffed.`,
      closedUnlessStaffedBody: "The venue opens for this shift only once it is staffed.",
      openInVenues: "Open in Venues:",
    },
    de: {
      freeTime: "Freier Zeitraum",
      reminderTitle: ({ when, venue }) => `Deine Schicht ${when} · ${venue}`,
      reminderBody: ({ shift, span }) =>
        `${shift}, ${span}. Wenn du nicht kannst, tritt in Standorte aus der Schicht aus, damit jemand anderes sie übernehmen kann.`,
      leftTitle: ({ person, when, venue }) => `${person} ist ausgetreten: ${when} · ${venue}`,
      leftBody: ({ person, shift, span }) => `${person} ist aus „${shift}“ ausgetreten, ${span}. Der Platz ist wieder frei.`,
      removedTitle: ({ person, when, venue }) => `${person} wurde entfernt: ${when} · ${venue}`,
      removedBody: ({ actor, person, shift, span }) =>
        `${actor} hat ${person} aus „${shift}“ entfernt, ${span}. Der Platz ist wieder frei.`,
      missing: ({ count }) => `${count} ${count === 1 ? "fehlt" : "fehlen"}`,
      understaffedTitle: ({ missing, when, venue }) => `${missing} · ${when} · ${venue}`,
      closedUnlessStaffedTitle: ({ missing, when, venue }) => `Bleibt ohne Besetzung zu: ${missing} · ${when} · ${venue}`,
      understaffedBody: ({ shift, span, assigned, target }) => `„${shift}“, ${span}: ${assigned} von ${target} besetzt.`,
      closedUnlessStaffedBody: "Der Standort öffnet für diese Schicht erst, wenn sie besetzt ist.",
      openInVenues: "In Standorte öffnen:",
    },
  },
});

const text = (locale: string) => messages.resolve([locale]).t;

/** The shift as notifications name it: its template's title, or free time. */
const shiftFields = {
  venueId: VenueResourceIdSchema,
  venueName: z.string(),
  timezone: z.string(),
  /** `null` for free time. */
  shiftTitle: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
};

type ShiftFields = { [K in keyof typeof shiftFields]: z.infer<(typeof shiftFields)[K]> };

/** The day a shift starts, in the Venue's time zone: the calendar day the schedule link opens. */
const shiftDate = (shift: Pick<ShiftFields, "startsAt" | "timezone">): string =>
  dates.formatDateKey(new Date(shift.startsAt), { timeZone: shift.timezone });

/** The schedule on the shift's day with its detail open; on a phone the detail opens as a sheet. */
export const shiftTargetHref = (shift: Pick<ShiftFields, "venueId" | "startsAt" | "timezone">, selection: string | null) =>
  scheduleHref(shift.venueId, { date: shiftDate(shift), shift: selection });

const describe = (shift: ShiftFields, locale: string) => ({
  venue: shift.venueName,
  shift: shift.shiftTitle ?? text(locale).freeTime,
  when: formatVenueWeekdayTime(shift.startsAt, shift.timezone, locale),
  span: formatVenueSpan(shift.startsAt, shift.endsAt, shift.timezone, locale),
});

/** Email has no click target, so it ends with the absolute link to the same page. */
const emailWithLink = async (presentation: { title: string; body: string; targetHref: string }, locale: string) => {
  const origin = publicCloudOrigin(await coreSettings.get<string>("app.url"));
  return {
    subject: presentation.title,
    content: `${presentation.body}\n\n${text(locale).openInVenues} ${origin}${presentation.targetHref}`,
  };
};

const reminderData = z.object({ ...shiftFields, assignmentId: VenueResourceIdSchema });
const cancelledData = z.object({
  ...shiftFields,
  /** The shift's template, for its detail; `null` for free time. */
  templateId: VenueResourceIdSchema.nullable(),
  person: z.string(),
  /** The admin who removed the person; `null` when the person left. */
  removedBy: z.string().nullable(),
});
const understaffedData = z.object({
  ...shiftFields,
  shiftTitle: z.string(),
  templateId: VenueResourceIdSchema,
  assignedCount: z.number().int().nonnegative(),
  minPeople: z.number().int().positive(),
  maxPeople: z.number().int().positive().nullable(),
  /** The venue opens for this shift only once it is staffed, so the gap keeps it closed. */
  blocksOpening: z.boolean(),
});

const renderReminder = (data: z.infer<typeof reminderData>, locale: string) => {
  const shift = describe(data, locale);
  return {
    title: text(locale).reminderTitle(shift),
    body: text(locale).reminderBody(shift),
    targetHref: shiftTargetHref(data, assignmentSelectionId(data.assignmentId)),
  };
};

const renderCancelled = (data: z.infer<typeof cancelledData>, locale: string) => {
  const t = text(locale);
  const shift = describe(data, locale);
  const person = data.person;
  return {
    title: data.removedBy ? t.removedTitle({ ...shift, person }) : t.leftTitle({ ...shift, person }),
    body: data.removedBy ? t.removedBody({ ...shift, person, actor: data.removedBy }) : t.leftBody({ ...shift, person }),
    // A left slot still exists and opens with its staffing; free time is gone, so the day opens instead.
    targetHref: shiftTargetHref(data, data.templateId ? slotSelectionId(data.templateId, shiftDate(data)) : null),
  };
};

const renderUnderstaffed = (data: z.infer<typeof understaffedData>, locale: string) => {
  const t = text(locale);
  const shift = describe(data, locale);
  const missing = t.missing({ count: Math.max(1, data.minPeople - data.assignedCount) });
  const target = data.maxPeople && data.maxPeople > data.minPeople ? `${data.minPeople}–${data.maxPeople}` : String(data.minPeople);
  const body = t.understaffedBody({ ...shift, assigned: data.assignedCount, target });
  return {
    title: data.blocksOpening ? t.closedUnlessStaffedTitle({ ...shift, missing }) : t.understaffedTitle({ ...shift, missing }),
    body: data.blocksOpening ? `${body} ${t.closedUnlessStaffedBody}` : body,
    targetHref: shiftTargetHref(data, slotSelectionId(data.templateId, shiftDate(data))),
  };
};

const presentation = (label: string, description: string) => ({ baseLocale: "en", translations: { de: { label, description } } });

export const NOTIFICATIONS = {
  shiftReminder: notification({
    recipient: "user",
    label: "Shift reminders",
    description: "A reminder about 24 hours before a shift you took.",
    presentation: presentation("Schicht-Erinnerungen", "Eine Erinnerung etwa 24 Stunden vor einer Schicht, die du übernommen hast."),
    delivery: { recommended: ["browser", "email"] },
    data: reminderData,
    render: (data, { locale }) => renderReminder(data, locale),
    email: (data, { locale }) => emailWithLink(renderReminder(data, locale), locale),
  }),
  shiftCancelled: notification({
    recipient: "user",
    label: "Shift cancellations",
    description: "For venue admins: someone left an upcoming shift or an admin removed them.",
    presentation: presentation(
      "Schicht-Absagen",
      "Für Standort-Admins: Jemand ist aus einer anstehenden Schicht ausgetreten oder wurde entfernt.",
    ),
    delivery: { recommended: ["browser", "email"] },
    data: cancelledData,
    render: (data, { locale }) => renderCancelled(data, locale),
    email: (data, { locale }) => emailWithLink(renderCancelled(data, locale), locale),
  }),
  shiftUnderstaffed: notification({
    recipient: "user",
    label: "Understaffed shifts",
    description: "For venue admins: once per shift that starts within 24 hours and still misses people.",
    presentation: presentation(
      "Unterbesetzte Schichten",
      "Für Standort-Admins: einmal pro Schicht, die in den nächsten 24 Stunden beginnt und noch Leute braucht.",
    ),
    delivery: { recommended: ["browser", "email"] },
    data: understaffedData,
    render: (data, { locale }) => renderUnderstaffed(data, locale),
    email: (data, { locale }) => emailWithLink(renderUnderstaffed(data, locale), locale),
  }),
};
