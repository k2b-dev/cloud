import type { FilterChipSection } from "@k2b/ui";
import type { VenueView } from "./types";

export const views: Array<{ id: VenueView; label: string; icon: string }> = [
  { id: "shifts", label: "Schedule", icon: "ti ti-calendar-event" },
  { id: "my-shifts", label: "My shifts", icon: "ti ti-user-check" },
  { id: "feedback", label: "Feedback", icon: "ti ti-message-star" },
];

export const feedbackRangeOptions: FilterChipSection[] = [
  {
    options: [
      { value: "7", label: "Last 7 days", icon: "ti ti-calendar-week" },
      { value: "14", label: "Last 14 days", icon: "ti ti-calendar" },
      { value: "30", label: "Last 30 days", icon: "ti ti-calendar-month" },
    ],
  },
];

export const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayOptions = weekdays.map((label, id) => ({ id: String(id), label }));
export const DOUBLE_CLICK_CONFIRM_COOKIE = "venue_skip_shift_double_click_confirm";
