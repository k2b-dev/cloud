import { prompts, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "../../../api/client";
import type { ShiftAssignment } from "../../../contracts";
import type { VenueMessages } from "../../../messages";
import { formatVenueSpan } from "../../../time-format";
import { readError } from "./utils";

/**
 * Running actions by key, so an action disables only the controls that would start the same conflicting
 * operation (the same slot or the same sign-up) and shows progress on its own button.
 */
export const createActionKeys = () => {
  const [keys, setKeys] = createSignal<ReadonlySet<string>>(new Set());
  const controllers = new Set<AbortController>();
  const pending = (key: string) => keys().has(key);
  /** Runs `action` unless one of `actionKeys` is running already; resolves to whether it completed. Errors show as a prompt. */
  const run = async (actionKeys: string[], action: (signal: AbortSignal) => Promise<void>): Promise<boolean> => {
    if (actionKeys.some(pending)) return false;
    const controller = new AbortController();
    controllers.add(controller);
    setKeys((current) => new Set([...current, ...actionKeys]));
    try {
      await action(controller.signal);
      return !controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted) prompts.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      controllers.delete(controller);
      setKeys((current) => new Set([...current].filter((key) => !actionKeys.includes(key))));
    }
  };
  const abortAll = () => {
    for (const controller of controllers) controller.abort();
  };
  return { pending, run, abortAll };
};

/**
 * Takes one shift, or with `weeks` also the same shift in the following weeks. Resolves to the number of new
 * sign-ups: the server skips weeks the viewer already has or that are full.
 */
export const takeShift = async (
  input: { venueId: string; templateId: string; date: string; weeks?: number },
  signal: AbortSignal,
  t: VenueMessages,
): Promise<number> => {
  const target = apiClient.venues[":id"].templates[":templateId"];
  const param = { id: input.venueId, templateId: input.templateId };
  if (input.weeks) {
    const res = await target["signup-weeks"].$post({ param, json: { date: input.date, weeks: input.weeks } }, { init: { signal } });
    if (!res.ok) throw new Error(await readError(res, t.signupFailed));
    return (await res.json()).length;
  }
  const res = await target.signup.$post({ param, json: { date: input.date } }, { init: { signal } });
  if (!res.ok) throw new Error(await readError(res, t.signupFailed));
  return 1;
};

/** Says how many shifts a Take added, and that nothing changed when it added none. */
export const announceTaken = (added: number, t: VenueMessages) => {
  if (added === 0) toast(t.noShiftsTaken);
  else toast.success(added === 1 ? t.shiftTaken : t.shiftsTaken({ count: added }));
};

/** Deletes a sign-up: the viewer's own, or anyone's for admins. The server enforces the same rule. */
export const cancelAssignment = async (
  input: { venueId: string; assignmentId: string },
  signal: AbortSignal,
  failure: string,
): Promise<void> => {
  const res = await apiClient.venues[":id"].assignments[":assignmentId"].$delete(
    { param: { id: input.venueId, assignmentId: input.assignmentId } },
    { init: { signal } },
  );
  if (!res.ok) throw new Error(await readError(res, failure));
};

/** Leaving is an ordinary action; only its confirmation carries the danger tone. */
export const confirmLeave = (assignment: ShiftAssignment, timeZone: string, locale: string, t: VenueMessages) =>
  prompts.confirm(
    t.leaveShiftQuestion({
      title: assignment.templateTitle ?? t.freeTime,
      date: formatVenueSpan(assignment.startsAt, assignment.endsAt, timeZone, locale),
    }),
    { title: t.leaveShift, variant: "danger", confirmText: t.leave },
  );

export const confirmRemove = (assignment: ShiftAssignment, timeZone: string, locale: string, t: VenueMessages) =>
  prompts.confirm(
    t.removeFromShiftQuestion({
      name: assignment.userDisplayName,
      title: assignment.templateTitle ?? t.freeTime,
      date: formatVenueSpan(assignment.startsAt, assignment.endsAt, timeZone, locale),
    }),
    { title: t.removeFromShift, variant: "danger", confirmText: t.remove },
  );
