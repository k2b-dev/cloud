import { type UniversalSearchData, UniversalSearchDataSchema } from "@k2b/cloud/contracts";
import type { SelectedCapability } from "./catalog";

type CapabilityDataPresentation = { kind: "universal-search"; items: UniversalSearchData } | { kind: "generic"; data: unknown };

export const resolveCapabilityDataPresentation = (selection: SelectedCapability, data: unknown): CapabilityDataPresentation => {
  if (selection.kind === "query" && selection.operation.universalSearch) {
    const parsed = UniversalSearchDataSchema.safeParse(data);
    if (parsed.success) return { kind: "universal-search", items: parsed.data };
  }

  return { kind: "generic", data };
};
