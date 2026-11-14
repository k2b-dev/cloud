import { type GeneratedCodeSdk, generateCodeSdk } from "@k2b/cloud/code";
import type { CapabilityManifest } from "@k2b/cloud/contracts";

/** Platform tools generate the @sdk pair from the installation's current capability catalog. */
export function resourceCodeSdk(manifests: CapabilityManifest[]): GeneratedCodeSdk {
  return generateCodeSdk(manifests, {
    mode: "resource",
    owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "workshop-owner" } },
  });
}
