import type { PulseResourceRef } from "./contracts";
import { validateResourceIdentity } from "./telemetry-contract";

export type PulseResourceIdentity = {
  key: string;
  id: string;
  label: string;
  type: string | null;
};

const identity = (type: string, id: string, label = id): PulseResourceIdentity | null => {
  return validateResourceIdentity(type, id) ? null : { key: `${type}:${id}`, id, label, type };
};

export const explicitPulseResource = (resource: PulseResourceRef | null | undefined): PulseResourceIdentity | null => {
  if (!resource) return null;
  return identity(resource.type.trim(), resource.id.trim(), resource.label?.trim() || resource.id.trim());
};
