import { useLocale } from "@k2b/ui";
import { Bar, Button, Check, Chip, Empty, Facts, List, Notice, Pane, Progress, Row, Section, Text } from "@k2b/ui/v2";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { ShiftAssignment, UpcomingSlot, Venue } from "../../contracts";
import { formatVenueSpan } from "../../time-format";
import { slotState, slotTarget } from "../_components/venue-workspace/schedule";
import {
  assignmentActionKey,
  FOLLOWING_WEEKS,
  type ShiftSelection,
  shiftDetailPermissions,
  slotActionKey,
} from "../_components/venue-workspace/shift-detail";
import { useVenueWords } from "./messages";

/** A slot state as a chip: covered is ok, missing waits, urgent is wrong, ended is plain. */
export const slotChip = (slot: UpcomingSlot, t: ReturnType<ReturnType<typeof useVenueWords>["t"]>) => {
  const state = slotState(slot, t);
  const status = { success: "ok", warning: "warn", danger: "bad" } as const;
  const tone = state.tone === "success" || state.tone === "warning" || state.tone === "danger" ? status[state.tone] : undefined;
  return tone ? <Chip status={tone}>{state.label}</Chip> : <Chip>{state.label}</Chip>;
};

/**
 * The open shift beside the calendar (on the phone: its own page with the way back). It names the shift, its staffing
 * and its people; the one deed is Join (with the following weeks) or Leave, and admins remove others.
 */
export default function ShiftDetailPane(props: {
  selection: ShiftSelection;
  venue: Venue;
  userId: string;
  closeHref: string;
  pending: (key: string) => boolean;
  onTake: (slot: UpcomingSlot, followingWeeks: boolean) => void;
  onLeave: (assignment: ShiftAssignment) => void;
  onRemove: (assignment: ShiftAssignment) => void;
}) {
  const { t, words } = useVenueWords();
  const locale = useLocale();
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
  const slot = () => (props.selection.kind === "slot" ? props.selection.slot : null);
  const people = () => (props.selection.kind === "slot" ? props.selection.slot.assignments : [props.selection.assignment]);
  const title = () =>
    slot()?.template.title ?? (props.selection.kind === "assignment" ? (props.selection.assignment.templateTitle ?? t().freeTime) : "");
  const times = () => (props.selection.kind === "slot" ? props.selection.slot : props.selection.assignment);
  const span = () => {
    const formatted = formatVenueSpan(times().startsAt, times().endsAt, props.venue.timezone, locale());
    return slot()?.template.date ? `${formatted} · ${t().oneOffShift}` : formatted;
  };
  return (
    <Pane
      detail
      label={title()}
      scrollKey="venue-shift"
      back={{ label: words().backToSchedule, href: props.closeHref }}
      head={
        <Bar
          start={<Text type="lead">{title()}</Text>}
          end={
            <>
              <Show when={permissions().take ? slot() : null}>
                {(current) => (
                  <Button
                    variant="primary"
                    icon="user-plus"
                    keep
                    busy={props.pending(slotActionKey(current()))}
                    onClick={() => props.onTake(current(), current().template.date === null && followingWeeks())}
                  >
                    {t().join}
                  </Button>
                )}
              </Show>
              <Show when={permissions().leave}>
                {(own) => (
                  <Button keep busy={props.pending(assignmentActionKey(own()))} onClick={() => props.onLeave(own())}>
                    {t().leave}
                  </Button>
                )}
              </Show>
              <Button variant="ghost" icon="x" label={t().closeShiftDetails} href={props.closeHref} />
            </>
          }
        />
      }
    >
      <Show
        when={slot()}
        fallback={
          <Notice tone="note" icon="clock-plus" title={t().aboutSignUp}>
            {props.selection.kind === "assignment" && props.selection.assignment.templateId
              ? t().unscheduledShiftDescription
              : t().freeTimeDescription}
          </Notice>
        }
      >
        {(current) => (
          <Section icon="calendar-event" title={t().properties} summary={span()}>
            <Facts
              items={[
                { label: t().staffing, value: t().staffed({ assigned: current().assignedCount, target: slotTarget(current()) }) },
                { label: words().kind, value: slotChip(current(), t()) },
              ]}
            />
            <Progress
              value={current().assignedCount}
              of={current().maxPeople ?? Math.max(current().minPeople, current().assignedCount, 1)}
              label={t().staffed({ assigned: current().assignedCount, target: slotTarget(current()) })}
            />
            <Show when={permissions().take && current().template.date === null}>
              <Check label={t().alsoFollowingWeeks({ count: FOLLOWING_WEEKS })} checked={followingWeeks()} onChange={setFollowingWeeks} />
            </Show>
          </Section>
        )}
      </Show>
      <Section icon="users" title={t().people} count={people().length}>
        <Show when={people().length > 0} fallback={<Empty icon="user-plus" text={t().noOneYet} />}>
          <List label={t().people}>
            <For each={people()}>
              {(person) => (
                <Row
                  avatar={{ name: person.userDisplayName }}
                  lines={
                    person.note
                      ? [
                          person.userId === props.userId ? t().personYou({ name: person.userDisplayName }) : person.userDisplayName,
                          person.note,
                        ]
                      : [person.userId === props.userId ? t().personYou({ name: person.userDisplayName }) : person.userDisplayName]
                  }
                  action={
                    permissions().remove(person)
                      ? {
                          label: t().removePerson({ name: person.userDisplayName }),
                          icon: "user-minus",
                          disabled: props.pending(assignmentActionKey(person)),
                          onClick: () => props.onRemove(person),
                        }
                      : undefined
                  }
                />
              )}
            </For>
          </List>
        </Show>
      </Section>
    </Pane>
  );
}
