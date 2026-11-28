import type { AiModelSlot } from "@k2b/cloud/shared";
import { capped } from "../_area/capped";
import type { AiAreaQuery } from "./area";
import { type AiCatalogIndex, findAiVariant } from "./presentation";

/** One provider's models as the providers table and its detail count them, and the classes and tools they fill. */
export type AiProviderFacts = { models: number; enabled: number; slots: AiModelSlot[] };

/**
 * What KI › Providers shows of the catalog, shaped on the server so the island gets only that: the open provider's
 * models that match `mq` (the first `ROW_CAP`), the open model, and the models and variants the class assignments
 * point at, so a model's classes resolve; per provider its counts and the classes and tools its models fill; for the
 * open provider how many models match and the provider model ids it already has.
 */
export const aiProvidersView = (index: AiCatalogIndex, query: Pick<AiAreaQuery, "p" | "m" | "mq">) => {
  const slotsOf = new Map<string, AiModelSlot[]>();
  const assigned = new Set<string>();
  for (const slot of Object.keys(index.assignments) as AiModelSlot[]) {
    const found = findAiVariant(index, index.assignments[slot]?.variantId);
    if (!found) continue;
    slotsOf.set(found.model.id, [...(slotsOf.get(found.model.id) ?? []), slot]);
    assigned.add(found.variant.id);
  }
  const providers: Record<string, AiProviderFacts> = {};
  for (const model of index.models) {
    const facts = providers[model.providerId] ?? { models: 0, enabled: 0, slots: [] };
    providers[model.providerId] = facts;
    facts.models += 1;
    if (model.enabled) facts.enabled += 1;
    for (const slot of slotsOf.get(model.id) ?? []) if (!facts.slots.includes(slot)) facts.slots.push(slot);
  }
  const own = query.p ? index.models.filter((model) => model.providerId === query.p) : [];
  const needle = (query.mq ?? "").toLowerCase();
  const matching = needle ? own.filter((model) => `${model.label} ${model.providerModel} ${model.id}`.toLowerCase().includes(needle)) : own;
  const rows = capped(matching).map((model) => model.id);
  const sent = new Set([...rows, ...slotsOf.keys(), ...own.filter((model) => model.id === query.m).map((model) => model.id)]);
  return {
    models: index.models.filter((model) => sent.has(model.id)),
    variants: index.variants.filter((variant) => assigned.has(variant.id)),
    catalog: { total: index.models.length, providers },
    /** The open provider's model list: its rows, how many models match the search, and what it already offers. */
    list: { rows, matching: matching.length, existing: own.map((model) => model.providerModel) },
  };
};
