import type { PulseCurrentState, PulseRecordedEvent } from "../../contracts";
import { eventGroupId, signalSubject, stateGroupId } from "./signal-helpers";
import type { ActivityEventGroup, ActivityStateGroup } from "./types";

const newestEventFirst = (left: PulseRecordedEvent, right: PulseRecordedEvent): number => Date.parse(right.ts) - Date.parse(left.ts);

const newestStateFirst = (left: PulseCurrentState, right: PulseCurrentState): number =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt);

export const buildActivityEventGroups = (events: PulseRecordedEvent[]): ActivityEventGroup[] => {
  const groups = new Map<string, ActivityEventGroup>();
  for (const event of events) {
    const id = eventGroupId(event);
    const current =
      groups.get(id) ??
      ({
        id,
        kind: event.kind,
        subject: signalSubject(event),
        sourceId: event.sourceId,
        latest: event,
        rows: [],
      } satisfies ActivityEventGroup);
    current.rows.push(event);
    if (Date.parse(event.ts) > Date.parse(current.latest.ts)) current.latest = event;
    groups.set(id, current);
  }
  for (const group of groups.values()) group.rows.sort(newestEventFirst);
  return [...groups.values()].sort((left, right) => newestEventFirst(left.latest, right.latest));
};

export const buildActivityStateGroups = (states: PulseCurrentState[]): ActivityStateGroup[] => {
  const groups = new Map<string, ActivityStateGroup>();
  for (const state of states) {
    const id = stateGroupId(state);
    const current =
      groups.get(id) ??
      ({
        id,
        key: state.key,
        sourceId: state.sourceId,
        latest: state,
        rows: [],
      } satisfies ActivityStateGroup);
    current.rows.push(state);
    if (Date.parse(state.updatedAt) > Date.parse(current.latest.updatedAt)) current.latest = state;
    groups.set(id, current);
  }
  for (const group of groups.values()) group.rows.sort(newestStateFirst);
  return [...groups.values()].sort((left, right) => newestStateFirst(left.latest, right.latest));
};
