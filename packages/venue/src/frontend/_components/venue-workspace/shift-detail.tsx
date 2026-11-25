import {
  BottomSheet,
  Button,
  Checkbox,
  DescriptionList,
  DetailPanel,
  IconButton,
  type IntentTone,
  Section,
  StatusBadge,
  type StatusTone,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import type { ShiftAssignment, UpcomingSlot, Venue, VenueDashboard } from "../../../contracts";
import { venueMessages } from "../../../messages";
import { formatVenueSpan } from "../../../time-format";
import { assignmentSelectionId, slotSelectionId } from "../../schedule-url";
import { ProgressBar, slotState, slotTarget } from "./schedule";
import { VenueTimeZoneNote } from "./time-zone-note";
import { canAdmin, canWrite } from "./utils";

/** Taking a shift from the detail can add this many following weeks as well. */
export const FOLLOWING_WEEKS = 4;

/** What the detail shows: a shift occurrence with its people, or one sign-up outside every shift, such as free time. */
export type ShiftSelection =
  | { kind: "slot"; eventId: string; slot: UpcomingSlot }
  | { kind: "assignment"; eventId: string; assignment: ShiftAssignment };

/**
 * The loaded shift a `shift` URL parameter names. A sign-up (`a:<id>`) that belongs to a loaded shift selects
 * that shift, so links from My shifts open the same detail as the calendar.
 */
export const resolveShiftSelection = (
  dashboard: Pick<VenueDashboard, "slots" | "otherAssignments">,
  selectionId: string | null,
): ShiftSelection | null => {
  if (!selectionId) return null;
  if (selectionId.startsWith("a:")) {
    const assignmentId = selectionId.slice(2);
    const slot = dashboard.slots.find((entry) => entry.assignments.some((assignment) => assignment.id === assignmentId));
    if (slot) return { kind: "slot", eventId: slotSelectionId(slot.template.id, slot.date), slot };
    const assignment = dashboard.otherAssignments.find((entry) => entry.id === assignmentId);
    return assignment ? { kind: "assignment", eventId: assignmentSelectionId(assignment.id), assignment } : null;
  }
  const slot = dashboard.slots.find((entry) => slotSelectionId(entry.template.id, entry.date) === selectionId);
  return slot ? { kind: "slot", eventId: selectionId, slot } : null;
};

/** Keys of running actions: a Take on a slot, or a Leave or Remove on one sign-up. Only actions on the same key conflict. */
export const slotActionKey = (slot: UpcomingSlot): string => `slot:${slotSelectionId(slot.template.id, slot.date)}`;
export const assignmentActionKey = (assignment: ShiftAssignment): string => `assignment:${assignment.id}`;

export type ShiftDetailPermissions = {
  /** Staff with shift sign-up, on a shift that has neither ended nor filled up, that the viewer does not have yet. */
  take: boolean;
  /** The viewer's own sign-up on a shift that has not ended. */
  leave: ShiftAssignment | null;
  /** Admins remove other people from a shift that has not ended; the server checks the same. */
  remove: (assignment: ShiftAssignment) => boolean;
};

export const shiftDetailPermissions = (
  selection: ShiftSelection,
  venue: Venue,
  userId: string,
  now = new Date(),
): ShiftDetailPermissions => {
  const endsAt = selection.kind === "slot" ? selection.slot.endsAt : selection.assignment.endsAt;
  const ended = new Date(endsAt) < now;
  const people = shiftPeople(selection);
  const leave = ended ? null : (people.find((assignment) => assignment.userId === userId) ?? null);
  return {
    take: selection.kind === "slot" && !ended && !leave && !selection.slot.full && canWrite(venue) && venue.signupMode !== "free",
    leave,
    remove: (assignment) => !ended && canAdmin(venue) && assignment.userId !== userId,
  };
};

const shiftPeople = (selection: ShiftSelection): ShiftAssignment[] =>
  selection.kind === "slot" ? selection.slot.assignments : [selection.assignment];
