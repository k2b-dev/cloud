import { aiSlug } from "./client";

/** Reserve global ids across both the stored catalog and this batch; explicit ids remain editable. */
export const proposeAiModelIds = (providerId: string, models: string[], existing: string[], overrides: Record<string, string>) => {
  const reserved = new Set([...existing, ...models.flatMap((model) => (!Object.hasOwn(overrides, model) ? [] : [overrides[model]!]))]);
  const result = new Map<string, string>();
  for (const model of models) {
    const explicit = Object.hasOwn(overrides, model) ? overrides[model] : undefined;
    if (explicit !== undefined) {
      result.set(model, explicit);
      continue;
    }
    const stem = aiSlug(`${providerId}-${model}`);
    let id = stem;
    for (let suffix = 2; reserved.has(id); suffix++) id = `${stem.slice(0, 120 - String(suffix).length - 1)}-${suffix}`;
    reserved.add(id);
    result.set(model, id);
  }
  return Object.fromEntries(result);
};
