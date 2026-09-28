import { BottomSheet, Button, Checkbox, DetailPanel, IconButton, StatusBadge, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import type { ShiftAssignment, UpcomingSlot, Venue, VenueDashboard } from "../../../contracts";
import { venueMessages } from "../../../messages";
import { formatVenueSpan } from "../../../time-format";
import { assignmentSelectionId, slotSelectionId } from "../../schedule-url";
import { ProgressBar, SlotStateLabel, slotState } from "./schedule";
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

export type ShiftDetailProps = {
  selection: ShiftSelection;
  venue: Venue;
  userId: string;
  pending: (key: string) => boolean;
  onTake: (slot: UpcomingSlot, followingWeeks: boolean) => void;
  onLeave: (assignment: ShiftAssignment) => void;
  onRemove: (assignment: ShiftAssignment) => void;
};

function useShiftDetail(props: ShiftDetailProps) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [followingWeeks, setFollowingWeeks] = createSignal(false);
  // The choice belongs to one shift; selecting another starts without it.
  createEffect(
    on(
      () => props.selection.eventId,
      () => setFollowingWeeks(false),
      { defer: true },
    ),
  );
  const permissions = () => shiftDetailPermissions(props.selection, props.venue, props.userId);
  const title = () =>
    props.selection.kind === "slot" ? props.selection.slot.template.title : (props.selection.assignment.templateTitle ?? t().freeTime);
  const times = () =>
    props.selection.kind === "slot"
      ? [props.selection.slot.startsAt, props.selection.slot.endsAt]
      : [props.selection.assignment.startsAt, props.selection.assignment.endsAt];
  const span = () => formatVenueSpan(times()[0]!, times()[1]!, props.venue.timezone, locale());
  const icon = () => (props.selection.kind === "slot" ? "ti ti-calendar-event" : "ti ti-clock-plus");
  const hasActions = () => permissions().take || permissions().leave !== null;

  /** Take or Leave, with the following-weeks choice next to Take. `size` is the surface's button size. */
  const primaryActions = (size: "sm" | "md") => (
    <div class="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <Show when={permissions().take && props.selection.kind === "slot" ? props.selection.slot : null}>
        {(slot) => (
          <>
            <Checkbox label={t().alsoFollowingWeeks({ count: FOLLOWING_WEEKS })} value={followingWeeks} onValueChange={setFollowingWeeks} />
            <Button
              type="button"
              size={size}
              loading={props.pending(slotActionKey(slot()))}
              onClick={() => props.onTake(slot(), followingWeeks())}
            >
              <i class="ti ti-user-plus" aria-hidden="true" /> {t().join}
            </Button>
          </>
        )}
      </Show>
      <Show when={permissions().leave}>
        {(own) => (
          <>
            <StatusBadge tone="ok" icon="ti ti-check" label={t().joined} />
            <Button
              type="button"
              variant="secondary"
              size={size}
              loading={props.pending(assignmentActionKey(own()))}
              onClick={() => props.onLeave(own())}
            >
              {t().leave}
            </Button>
          </>
        )}
      </Show>
    </div>
  );

  const facts = (size: "sm" | "md") => (
    <>
      <Show
        when={props.selection.kind === "slot" ? props.selection.slot : null}
        fallback={
          // A sign-up outside every shift: free time, or a shift that was paused or moved since.
          <DetailPanel.Summary title={title()}>
            <p class="text-sm text-dimmed">
              {props.selection.kind === "assignment" && props.selection.assignment.templateId
                ? t().unscheduledShiftDescription
                : t().freeTimeDescription}
            </p>
          </DetailPanel.Summary>
        }
      >
        {(slot) => (
          <DetailPanel.Summary title={t().staffing}>
            <ProgressBar slot={slot()} />
          </DetailPanel.Summary>
        )}
      </Show>
      <DetailPanel.Section title={t().people} icon="ti ti-users" meta={String(shiftPeople(props.selection).length)}>
        <Show when={shiftPeople(props.selection).length > 0} fallback={<p class="text-sm text-dimmed">{t().noOneYet}</p>}>
          <ul class="grid gap-1" aria-label={t().people}>
            <For each={shiftPeople(props.selection)}>
              {(person) => (
                <li class="flex min-h-10 items-center justify-between gap-3 text-sm" data-shift-person={person.id}>
                  <span class="min-w-0">
                    <span class="block font-medium text-primary [overflow-wrap:anywhere]">
                      {person.userId === props.userId ? t().personYou({ name: person.userDisplayName }) : person.userDisplayName}
                    </span>
                    <Show when={person.note}>
                      {(note) => <span class="block text-xs text-dimmed [overflow-wrap:anywhere]">{note()}</span>}
                    </Show>
                  </span>
                  <Show when={permissions().remove(person)}>
                    <Button
                      type="button"
                      variant="secondary"
                      size={size}
                      aria-label={t().removePerson({ name: person.userDisplayName })}
                      loading={props.pending(assignmentActionKey(person))}
                      onClick={() => props.onRemove(person)}
                    >
                      {t().remove}
                    </Button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DetailPanel.Section>
      <VenueTimeZoneNote timeZone={props.venue.timezone} times={times()} />
    </>
  );

  const state = () => (props.selection.kind === "slot" ? slotState(props.selection.slot, t()) : null);
  return { t, title, span, icon, hasActions, primaryActions, facts, state };
}

/** The shift detail next to the calendar, from 1024 px on. */
export function ShiftDetailPanel(props: ShiftDetailProps & { onClose: () => void }) {
  const detail = useShiftDetail(props);
  return (
    <DetailPanel>
      <DetailPanel.Header
        icon={detail.icon()}
        title={detail.title()}
        subtitle={detail.span()}
        meta={<Show when={detail.state()}>{(state) => <SlotStateLabel state={state()} class="text-xs" />}</Show>}
        actions={
          <IconButton size="sm" variant="ghost" label={detail.t().closeShiftDetails} onClick={props.onClose}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        }
        primaryActions={detail.hasActions() ? detail.primaryActions("sm") : undefined}
      />
      <DetailPanel.Body scrollPreserveKey="venue-shift-detail">{detail.facts("sm")}</DetailPanel.Body>
    </DetailPanel>
  );
}

/**
 * The same detail as a bottom sheet below 1024 px. Its actions use the default button size, so they keep a
 * touch-sized target.
 */
export function ShiftDetailSheet(props: ShiftDetailProps & { onDismiss: () => void | Promise<void> }): JSX.Element {
  const detail = useShiftDetail(props);
  return (
    <BottomSheet onDismiss={props.onDismiss} dismissLabel={detail.t().closeShiftDetails}>
      <BottomSheet.Header
        title={detail.title()}
        subtitle={detail.span()}
        icon={detail.icon()}
        close={props.onDismiss}
        closeLabel={detail.t().closeShiftDetails}
      />
      <BottomSheet.Body>
        <div class="flex flex-col gap-3" data-shift-detail-sheet="">
          <Show when={detail.state()}>{(state) => <SlotStateLabel state={state()} class="text-sm font-medium" />}</Show>
          {detail.facts("md")}
        </div>
      </BottomSheet.Body>
      <Show when={detail.hasActions()}>
        <BottomSheet.Footer>{detail.primaryActions("md")}</BottomSheet.Footer>
      </Show>
    </BottomSheet>
  );
}
