import { StatusBadge, type StatusTone } from "@k2b/ui";
import type { InventoryState } from "../contracts";
import { useFilesMessages } from "./messages";

export function DirectoryStatus(props: { status: InventoryState }) {
  const t = useFilesMessages();
  const tones: Record<InventoryState, StatusTone> = {
    existing: "ok",
    missing: "warning",
    unassigned: "neutral",
    conflict: "error",
    unknown: "degraded",
  };
  return <StatusBadge tone={tones[props.status]} label={t()[props.status]} />;
}

export function IssueMessage(props: { code: string | null }) {
  const t = useFilesMessages();
  const message = () => {
    switch (props.code) {
      case "local_linux_disabled":
        return t().linuxDisabled;
      case "freeipa_disabled":
        return t().freeipaDisabled;
      case "area_disabled":
        return t().areaDisabled;
      case "not_configured":
        return t().notConfigured;
      case "missing":
      case "not_found":
        return t().missingDescription;
      case "unassigned":
        return t().unassignedDescription;
      case "ownership_mismatch":
        return t().ownershipMismatch;
      case "identity_missing":
      case "identity_unknown":
        return t().identityUnknown;
      case "identity_ineligible":
        return t().identityIneligible;
      case "identity_incomplete":
        return t().identityIncomplete;
      case "not_directory":
        return t().notDirectory;
      case "forbidden":
        return t().forbidden;
      case "reserved_path":
        return t().reservedPath;
      case "binding_conflict":
      case "conflict":
        return t().conflictDescription;
      default:
        return t().unavailable;
    }
  };
  return <>{message()}</>;
}
