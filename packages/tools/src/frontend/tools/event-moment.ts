/**
 * A typed moment of a QR calendar event as "YYYY-MM-DDTHH:MM", or `undefined` when the text is no real date and time.
 * Takes the key order ("2026-06-15 14:30", also with "T") and the German order ("15.06.2026 14:30"); a day that does
 * not exist (31.06.) or an hour past 23:59 is no moment. Before, any text went into the event and gave a broken one.
 */
export const parseEventMoment = (text: string): string | undefined => {
  const value = text.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/);
  const german = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4}),? (\d{1,2}):(\d{2})$/);
  const parts = iso
    ? { year: iso[1]!, month: iso[2]!, day: iso[3]!, hour: iso[4]!, minute: iso[5]! }
    : german
      ? { year: german[3]!, month: german[2]!, day: german[1]!, hour: german[4]!, minute: german[5]! }
      : undefined;
  if (!parts) return undefined;
  const [year, month, day, hour, minute] = [parts.year, parts.month, parts.day, parts.hour, parts.minute].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  if (hour > 23 || minute > 59) return undefined;
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
};
