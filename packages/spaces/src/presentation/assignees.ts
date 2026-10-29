import type { ServiceAccountKind } from "@k2b/cloud/contracts";

/** Cloud's principal icons, also used for assignees and claim holders. */
export const assigneeIcon = (kind: ServiceAccountKind | undefined): string => {
  switch (kind) {
    case "agent":
      return "ti ti-robot";
    case "resource_bound":
      return "ti ti-box";
    case "user_delegated":
      return "ti ti-user-key";
    default:
      return "ti ti-key";
  }
};
