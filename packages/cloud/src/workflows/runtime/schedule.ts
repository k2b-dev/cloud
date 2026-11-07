import { normalizeCronSchedule as normalizeWorkflowSchedule, type CronSchedule as WorkflowSchedule } from "../../shared/cron-schedule";

export { type CronSchedule as WorkflowSchedule, normalizeCronSchedule as normalizeWorkflowSchedule } from "../../shared/cron-schedule";

import type { WorkflowRevision } from "../contracts";
import { normalizeWorkflowInstant } from "./instant";

const opaqueKey = (prefix: string, parts: readonly string[]): string =>
  `${prefix}:${parts.map((part) => `${part.length}:${part}`).join("")}`;

export type WorkflowScheduleRegistration = {
  id: string;
  namespace: string;
  workflowId: string;
  triggerId: string;
  revision: WorkflowRevision;
  schedule: WorkflowSchedule;
};

export const workflowScheduleRegistrationId = (input: {
  namespace: string;
  workflowId: string;
  triggerId: string;
  revision: WorkflowRevision;
}): string => opaqueKey("workflow-schedule", [input.namespace, input.workflowId, input.triggerId]);

export const createWorkflowScheduleRegistration = (
  input: Omit<WorkflowScheduleRegistration, "id" | "schedule"> & WorkflowSchedule,
): WorkflowScheduleRegistration => ({
  id: workflowScheduleRegistrationId(input),
  namespace: input.namespace,
  workflowId: input.workflowId,
  triggerId: input.triggerId,
  revision: input.revision,
  schedule: normalizeWorkflowSchedule(input),
});

export const workflowScheduleSlotKey = (registrationId: string, slot: string): string => {
  return opaqueKey("workflow-schedule-slot", [registrationId, normalizeWorkflowInstant("slot", slot)]);
};

export type WorkflowScheduleReconciliation = {
  create: WorkflowScheduleRegistration[];
  update: Array<{ current: WorkflowScheduleRegistration; desired: WorkflowScheduleRegistration }>;
  remove: WorkflowScheduleRegistration[];
};

const registrationMap = (
  name: "current" | "desired",
  registrations: readonly WorkflowScheduleRegistration[],
): Map<string, WorkflowScheduleRegistration> => {
  const result = new Map<string, WorkflowScheduleRegistration>();
  for (const registration of registrations) {
    if (result.has(registration.id)) throw new Error(`${name} schedules contain duplicate id ${registration.id}`);
    result.set(registration.id, registration);
  }
  return result;
};

const schedulesMatch = (left: WorkflowSchedule, right: WorkflowSchedule): boolean => {
  try {
    const normalizedLeft = normalizeWorkflowSchedule(left);
    const normalizedRight = normalizeWorkflowSchedule(right);
    return normalizedLeft.cron === normalizedRight.cron && normalizedLeft.timezone === normalizedRight.timezone;
  } catch {
    return false;
  }
};

export const planWorkflowScheduleReconciliation = (
  desired: readonly WorkflowScheduleRegistration[],
  current: readonly WorkflowScheduleRegistration[],
): WorkflowScheduleReconciliation => {
  const desiredById = registrationMap("desired", desired);
  const currentById = registrationMap("current", current);
  const create = desired.filter((registration) => !currentById.has(registration.id)).sort((a, b) => a.id.localeCompare(b.id));
  const update = desired
    .flatMap((registration) => {
      const existing = currentById.get(registration.id);
      return existing && (existing.revision !== registration.revision || !schedulesMatch(existing.schedule, registration.schedule))
        ? [{ current: existing, desired: registration }]
        : [];
    })
    .sort((a, b) => a.desired.id.localeCompare(b.desired.id));
  const remove = current.filter((registration) => !desiredById.has(registration.id)).sort((a, b) => a.id.localeCompare(b.id));
  return { create, update, remove };
};

export interface WorkflowScheduleReconciliationPort {
  create(registration: WorkflowScheduleRegistration): Promise<void>;
  update(current: WorkflowScheduleRegistration, desired: WorkflowScheduleRegistration): Promise<void>;
  register(registration: WorkflowScheduleRegistration): Promise<void>;
  remove(registration: WorkflowScheduleRegistration): Promise<void>;
}

export const reconcileWorkflowSchedules = async (input: {
  desired: readonly WorkflowScheduleRegistration[];
  current: readonly WorkflowScheduleRegistration[];
  port: WorkflowScheduleReconciliationPort;
}): Promise<WorkflowScheduleReconciliation> => {
  const plan = planWorkflowScheduleReconciliation(input.desired, input.current);
  const changed = new Set([...plan.create.map((registration) => registration.id), ...plan.update.map((item) => item.desired.id)]);
  for (const registration of plan.create) await input.port.create(registration);
  for (const item of plan.update) await input.port.update(item.current, item.desired);
  for (const registration of input.desired.filter((item) => !changed.has(item.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    await input.port.register(registration);
  }
  for (const registration of plan.remove) await input.port.remove(registration);
  return plan;
};
