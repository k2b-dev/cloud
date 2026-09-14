import type { PulseCurrentState, PulseRecordedEvent } from "../../contracts";

type SignalIdentity = {
  metric?: string;
  key?: string;
  kind?: string;
  resourceKey?: string | null;
  resourceType?: string | null;
  sourceId?: string | null;
  dimensions: Record<string, string>;
};

export const stateRowId = (state: PulseCurrentState): string => JSON.stringify([state.key, state.variantKey]);

export const eventGroupId = (event: PulseRecordedEvent): string => [event.kind, signalSubject(event)].join(":");

export const stateGroupId = (state: PulseCurrentState): string => [state.key, state.sourceId ?? ""].join(":");

export const signalResourceKey = (params: SignalIdentity): string | null => params.resourceKey ?? null;

export const signalSubject = (params: SignalIdentity): string => params.resourceKey ?? "resource";

export const dimensionsSummary = (dimensions: Record<string, string>, limit = 3): string =>
  Object.entries(dimensions)
    .filter(([key]) => !["host", "instance", "collector"].includes(key))
    .slice(0, limit)
    .map(([key, value]) => `${key}=${value}`)
    .join(" · ");
