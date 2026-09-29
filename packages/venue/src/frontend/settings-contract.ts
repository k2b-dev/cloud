import { query } from "@k2b/stdlib/solid";
import { onMount } from "solid-js";

export const createVenueSettingsQuery = <T>(options: {
  venueId: string;
  initial: T;
  load: (venueId: string, signal: AbortSignal) => Promise<T>;
}) => {
  const owner = query.create({
    source: () => options.venueId,
    initial: { source: options.venueId, data: options.initial },
    load: (venueId, { abortSignal }) => options.load(venueId, abortSignal),
  });
  onMount(() => void owner.refresh());
  return owner;
};

export const settingsInteractionBlocked = (state: {
  prompting: boolean;
  writePending: boolean;
  reconciling: boolean;
  coverageError: boolean;
  childPending: boolean;
  requestCount: number;
  mutationPending: boolean;
}): boolean =>
  state.prompting ||
  state.writePending ||
  state.reconciling ||
  state.coverageError ||
  state.childPending ||
  state.requestCount > 0 ||
  state.mutationPending;

export const settingsCloseBlocked = (state: Parameters<typeof settingsInteractionBlocked>[0]): boolean =>
  settingsInteractionBlocked({ ...state, coverageError: false });

export const reconcileChangedSettings = async (changed: boolean | undefined, reconcile: () => Promise<void>): Promise<boolean> => {
  if (!changed) return false;
  await reconcile();
  return true;
};
