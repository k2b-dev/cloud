import type { ServiceAccountKind } from "../contracts/shared";
import type { accessMessages } from "./messages";

/**
 * The one icon and label for each service-account kind, shared by the
 * permission editor rows, the principal picker, and entity search so the same
 * account never appears under different names.
 *
 * Apps bundle their own copy of this mapping, so a kind added later by Core
 * falls back to the key icon without a label instead of breaking the list.
 */
export const serviceAccountKindDisplay = (
  kind: ServiceAccountKind,
  t: ReturnType<typeof accessMessages.resolve>["t"],
): { icon: string; label?: string } => {
  switch (kind) {
    case "agent":
      return { icon: "ti-robot", label: t.agentServiceAccount };
    case "user_delegated":
      return { icon: "ti-user-key", label: t.userBoundServiceAccount };
    case "resource_bound":
      return { icon: "ti-box", label: t.resourceBoundServiceAccount };
    case "standalone":
      return { icon: "ti-key", label: t.standaloneServiceAccount };
    default:
      return { icon: "ti-key" };
  }
};
