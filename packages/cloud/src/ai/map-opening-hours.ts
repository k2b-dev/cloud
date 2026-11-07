/** Format the plain weekly subset only. Holidays, solar times and conditional rules stay verbatim. */
export function mapOpeningHours(schedule: string | undefined, at: string, timeZone: string | undefined, locale: string): string {
  const de = locale.startsWith("de");
  if (!schedule) return de ? "Öffnungszeiten unbekannt" : "Opening hours unknown";
  if (schedule === "24/7") return de ? "rund um die Uhr" : "open 24 hours";
  if (!timeZone) return schedule;
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let day: number;
  try {
    day = dayNames.indexOf(new Intl.DateTimeFormat("en", { timeZone, weekday: "short" }).format(new Date(at)));
  } catch {
    return schedule;
  }
  const rules = schedule
    .split(";")
    .map((rule) => /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?\s+(off|\d{1,2}:\d{2}-\d{1,2}:\d{2})$/.exec(rule.trim()));
  if (
    rules.some((rule) => {
      if (!rule) return true;
      if (rule[3] === "off") return false;
      return rule[3]!.split("-").some((part, i) => {
        const [hour, minute] = part.split(":").map(Number);
        return hour! > 24 || minute! > 59 || (hour === 24 && (i === 0 || minute !== 0));
      });
    })
  )
    return schedule;
  let hours: string | undefined;
  for (const rule of rules) {
    if (!rule) return schedule;
    const from = days.indexOf(rule[1]!);
    const to = days.indexOf(rule[2] ?? rule[1]!);
    if (from <= to ? day >= from && day <= to : day >= from || day <= to) hours = rule[3];
  }
  if (!hours) return schedule;
  if (hours === "off") return de ? "heute geschlossen" : "closed today";
  const [start, end] = hours.split("-");
  return de ? `heute ${start}–${end} Uhr` : `today ${start}–${end}`;
}
