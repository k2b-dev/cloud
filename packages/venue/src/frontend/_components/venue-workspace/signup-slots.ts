import type { UpcomingSlot } from "../../../contracts";
import { joinedSlot } from "./utils";

/** The sign-up dialog lists shifts in steps of this many days, starting today in the venue's time zone. */
export const SIGNUP_PAGE_DAYS = 14;

/** `Only free` hides shifts that are full, except the viewer's own: those stay listed with Leave. */
export const visibleSignupSlots = (slots: readonly UpcomingSlot[], userId: string, onlyFree: boolean): UpcomingSlot[] =>
  onlyFree ? slots.filter((slot) => !slot.full || joinedSlot(slot, userId)) : [...slots];
