const KEY = "k2b-notes.activity";
type Activity = Record<string, number>;
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function read(): Activity {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, count]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && typeof count === "number" && count > 0 && Number.isFinite(count),
      ),
    );
  } catch {
    return {};
  }
}
export function recordWriting(now: Date | number = new Date()): void {
  const date = new Date(now);
  const activity = read();
  const key = dayKey(date);
  activity[key] = (activity[key] ?? 0) + 1;
  const cutoff = new Date(date);
  cutoff.setDate(cutoff.getDate() - 61);
  const retained = Object.fromEntries(Object.entries(activity).filter(([day]) => day >= dayKey(cutoff) && day <= key));
  try {
    localStorage.setItem(KEY, JSON.stringify(retained));
  } catch {
    /* Activity is optional when storage is unavailable. */
  }
}
export function monthStrip(now: Date | number = new Date()): {
  month: number;
  days: { day: number; level: 0 | 1 | 2 | 3; today: boolean }[];
  activeDays: number;
} {
  const date = new Date(now);
  const activity = read();
  const days = Array.from({ length: new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() }, (_, index) => {
    const day = index + 1;
    const count = activity[dayKey(new Date(date.getFullYear(), date.getMonth(), day))] ?? 0;
    const level: 0 | 1 | 2 | 3 = count === 0 ? 0 : count <= 5 ? 1 : count <= 20 ? 2 : 3;
    return { day, level, today: day === date.getDate() };
  });
  return { month: date.getMonth() + 1, days, activeDays: days.filter((day) => day.level > 0).length };
}
