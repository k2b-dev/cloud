import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const timelineMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      timeline: "Timeline",
      timelineHint:
        "Arrow keys move between items, Page Up and Page Down between days, Home and End to the first and last item of a day, T to now.",
      timelineTimeRange: ({ start, end }: { start: string; end: string }) => `${start} to ${end}`,
      timelineDone: "done",
      timelineOpen: "open",
      timelineNight: ({ start, end }: { start: string; end: string }) => `Night · ${start}–${end}`,
      timelineNothingPlanned: "Nothing planned",
      timelineFree: ({ duration }: { duration: string }) => `${duration} free`,
      timelineMore: ({ count }: { count: number }) => `${count} more`,
      timelineNow: ({ time }: { time: string }) => `Now, ${time}`,
    },
    de: {
      timeline: "Zeitleiste",
      timelineHint:
        "Pfeiltasten wechseln den Eintrag, Bild auf und Bild ab den Tag, Pos1 und Ende springen zum ersten und letzten Eintrag des Tages, T zu jetzt.",
      timelineTimeRange: ({ start, end }) => `${start} bis ${end}`,
      timelineDone: "erledigt",
      timelineOpen: "offen",
      timelineNight: ({ start, end }) => `Nacht · ${start}–${end}`,
      timelineNothingPlanned: "Nichts geplant",
      timelineFree: ({ duration }) => `${duration} frei`,
      timelineMore: ({ count }) => `${count} weitere`,
      timelineNow: ({ time }) => `Jetzt, ${time}`,
    },
  },
});

export type TimelineMessages = ReturnType<(typeof timelineMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useTimelineMessages = (): (() => TimelineMessages) => {
  const locale = useLocale();
  return () => timelineMessages.resolve([locale()]).t;
};

export const checkTimelineMessages = () => timelineMessages.check();
