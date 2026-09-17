import { useAdminMessages } from "./admin-messages";
import { useFilesMessages } from "./messages";
export default function AdminIssue(props: { code: string | null }) {
  const a = useAdminMessages();
  const t = useFilesMessages();
  const message = () => {
    switch (props.code) {
      case "area_disabled":
        return a().disabledHint;
      case "local_linux_disabled":
        return t().linuxDisabled;
      case "freeipa_disabled":
        return t().freeipaDisabled;
      case "not_found":
      case "missing":
        return a().missingHint;
      case "ownership_mismatch":
      case "binding_conflict":
      case "not_directory":
      case "conflict":
        return a().conflictHint;
      case "identity_missing":
        return a().identityAbsent;
      case "operation_pending":
        return a().pendingHint;
      case "retired":
        return a().retiredHint;
      case "identity_incomplete":
      case "identity_unknown":
        return a().identityHint;
      case "identity_ineligible":
        return t().identityIneligible;
      case "unassigned":
        return t().adoptDescription;
      case "unknown":
        return a().unknownHint;
      default:
        return a().connectionHint;
    }
  };
  return <>{message()}</>;
}
