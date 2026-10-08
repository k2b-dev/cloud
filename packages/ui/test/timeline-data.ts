import type { TimelineItem } from "../src/content/timeline-model";

/** A week in Europe/Berlin around Thursday 8 October 2026, 14:20: meetings, deadlines, all-day items, and a dense Monday. */
export const timelineZone = "Europe/Berlin";
export const timelineNow = "2026-10-08T14:20:00+02:00";
export const timelineFrom = "2026-10-07T18:00:00+02:00";
export const timelineTo = "2026-10-14T00:00:00+02:00";

const at = (day: number, time: string) => `2026-10-${String(day).padStart(2, "0")}T${time}:00+02:00`;
const band = (id: string, label: string, day: number, start: string, end: string, color: TimelineItem["color"], detail?: string) => ({
  id,
  label,
  start: at(day, start),
  end: at(day, end),
  color,
  ...(detail ? { detail } : {}),
});
const task = (id: string, label: string, day: number, time: string, color: TimelineItem["color"] = "amber"): TimelineItem => ({
  id,
  label,
  start: at(day, time),
  kind: "marker",
  checked: false,
  color,
  detail: "Task",
});

export const timelineItems: TimelineItem[] = [
  band("e1", "Team bowling night", 7, "18:30", "21:00", "emerald", "Strike Kiel"),
  band("e2", "Daily stand-up", 8, "08:30", "09:00", "emerald"),
  band("e3", "Workshop Stadtwerke Kiel", 8, "09:30", "11:00", "cyan", "Room Förde"),
  band("e4", "Harbour office offer", 8, "10:30", "11:30", "cyan"),
  band("e5", "Onboarding design review", 8, "13:00", "13:45", "emerald"),
  band("e6", "Release planning 4.2", 8, "16:00", "17:30", "violet", "Room Schlei"),
  band("e7", "Dinner with the customer team", 8, "19:00", "21:30", "cyan", "Fischhalle"),
  band("e8", "ICE 1074 to Hamburg", 9, "07:12", "09:05", "amber"),
  band("e9", "Call with Weber print shop", 9, "11:00", "11:30", "cyan"),
  band("e10", "Weekly review", 9, "14:00", "15:00", "emerald"),
  band("e11", "Daily stand-up", 12, "08:30", "09:00", "emerald"),
  band("e12", "Sprint planning", 12, "09:00", "11:00", "emerald"),
  band("e13", "UX interview", 12, "09:30", "10:30", "emerald"),
  band("e14", "Call with Weber print shop", 12, "10:00", "10:45", "cyan"),
  band("e15", "Harbour office meeting", 12, "10:15", "12:00", "cyan"),
  band("e16", "Trade fair booth sync", 12, "13:00", "14:00", "amber"),
  band("e17", "Q4 offer round", 12, "13:30", "14:30", "cyan"),
  band("e18", "Go/no-go release 4.2", 12, "15:00", "16:00", "violet"),
  band("e19", "1:1 with Lena", 12, "16:00", "16:30", "emerald"),
  band("e20", "Trade fair setup", 12, "18:30", "20:30", "amber"),
  band("e21", "Daily stand-up", 13, "08:30", "09:00", "emerald"),
  { id: "n1", label: "Server maintenance", start: at(9, "01:00"), end: at(9, "02:00"), color: "zinc" },
  { id: "a1", label: "Lena on vacation", start: "2026-10-06", end: "2026-10-10", allDay: true, color: "emerald" },
  { id: "a2", label: "October onboarding workshop", start: "2026-10-08", end: "2026-10-10", allDay: true, color: "emerald" },
  { id: "a3", label: "Hamburg trade fair", start: "2026-10-12", end: "2026-10-15", allDay: true, color: "amber" },
  task("t1", "Release planning slides", 8, "15:30", "red"),
  task("t2", "Check invoice 2026-118", 8, "17:00"),
  task("t3", "Submit travel expenses", 9, "17:00"),
  task("t4", "Approve release notes 4.2", 12, "14:45", "red"),
  task("t5", "Send booth plan to the fair", 12, "17:00"),
];
