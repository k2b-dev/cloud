import { type CapabilityGrant, type MandatePolicyV1, MandatePolicyV1Schema } from "@k2b/cloud/services/mandates";
import { migrateLegacyRoutinePolicy } from "@k2b/cloud/services/mandates/target-migration";
import { err } from "@k2b/stdlib";
import type { MailAutomationStep } from "../contracts";

const visitSteps = (steps: MailAutomationStep[], visit: (step: MailAutomationStep) => void): void => {
  for (const step of steps) {
    visit(step);
    if (step.kind !== "if") continue;
    visitSteps(step.then, visit);
    visitSteps(step.else, visit);
  }
};

/** Each Spaces effect is limited to its configured Space and column or item. */
export const incomingAutomationMandatePolicy = (steps: MailAutomationStep[]): MandatePolicyV1 | null => {
  const grants: CapabilityGrant[] = [];
  visitSteps(steps, (step) => {
    if (step.kind !== "link_space_item" && step.kind !== "create_space_event") return;
    if (!step.spaceId || !/^[0-9A-Za-z]{6}$/.test(step.spaceId)) {
      throw err.badInput("Spaces step requires spaceId. Choose the Spaces item again, then save to confirm its Space.");
    }
    grants.push({
      appId: "spaces",
      capabilityId: step.kind === "link_space_item" ? "item.reference.add" : "event.create",
      kind: "action",
      target: { type: "spaces.space", id: step.spaceId },
      refs: {},
      fixedInput: step.kind === "link_space_item" ? { itemId: step.itemId } : { columnId: step.columnId },
    });
  });
  if (!grants.length) return null;
  return {
    version: 1,
    apps: ["spaces"],
    operations: [...new Set(grants.map((grant) => `capability.action.run:${grant.capabilityId}`))].sort(),
    actions: "preapproved",
    grants,
  };
};

/** Convert the old Mail allowlist only; unfamiliar policies need a person's confirmation. */
export const migrateIncomingAutomationPolicy = (value: unknown, steps: MailAutomationStep[]): MandatePolicyV1 | null => {
  const old = MandatePolicyV1Schema.safeParse(value);
  if (!old.success) return null;
  let configured: MandatePolicyV1 | null;
  try {
    configured = incomingAutomationMandatePolicy(steps);
  } catch {
    return null;
  }
  if (!configured) return null;
  // Existing grants may carry narrower payload restrictions. Never replace them from the steps.
  if (old.data.grants !== undefined) {
    const migrated = migrateLegacyRoutinePolicy(old.data);
    if (!migrated.ok) return null;
    const grants: CapabilityGrant[] = [];
    for (const wanted of configured.grants ?? []) {
      if (!("appId" in wanted)) return null;
      for (const prior of migrated.policy.grants ?? []) {
        if (
          !("appId" in prior) ||
          prior.appId !== wanted.appId ||
          prior.capabilityId !== wanted.capabilityId ||
          prior.kind !== wanted.kind ||
          prior.target?.type !== wanted.target?.type ||
          prior.target?.id !== wanted.target?.id ||
          Object.keys(prior.refs ?? {}).length
        )
          continue;
        if (
          Object.entries(wanted.fixedInput).some(
            ([key, value]) => Object.hasOwn(prior.fixedInput, key) && JSON.stringify(prior.fixedInput[key]) !== JSON.stringify(value),
          )
        )
          continue;
        grants.push({ ...prior, fixedInput: { ...prior.fixedInput, ...wanted.fixedInput } });
      }
      if (
        !grants.some(
          (grant) =>
            grant.capabilityId === wanted.capabilityId &&
            grant.target?.id === wanted.target?.id &&
            Object.entries(wanted.fixedInput).every(([key, value]) => grant.fixedInput[key] === value),
        )
      )
        return null;
    }
    return { ...migrated.policy, grants };
  }
  if (
    JSON.stringify(old.data) !==
    JSON.stringify({
      version: 1,
      apps: configured.apps,
      operations: configured.operations,
      actions: configured.actions,
    })
  )
    return null;
  return { ...old.data, grants: configured.grants };
};
