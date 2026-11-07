/**
 * The key an idempotent effect deduplicates on.
 *
 * Derived from the run and step rather than generated, so a replay after a
 * crash presents the provider with the same key and gets the same answer
 * instead of performing the work twice.
 */
export const workflowEffectKey = (runId: string, stepKey: string): string => `workflow:${runId}:step:${stepKey}`;
