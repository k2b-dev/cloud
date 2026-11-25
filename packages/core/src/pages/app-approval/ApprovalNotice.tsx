import { useLocale } from "@k2b/ui";
import { Notice } from "@k2b/ui/v2";
import type { ApprovalAvailability } from "./availability";
import { appApprovalMessages } from "./messages";

/** The sign-in app's state as a v2 notice; `ApprovalStatus` is the same for v1 pages. */
export default function ApprovalNotice(props: { state: ApprovalAvailability; admin?: boolean; settingsLink?: boolean }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const title = () =>
    ({
      disabled: t().statusDisabled,
      "setup-required": t().statusSetup,
      configured: t().statusConfigured,
      unavailable: t().statusUnavailable,
    })[props.state];
  const detail = () =>
    props.state === "disabled"
      ? t().disabled
      : props.state === "configured"
        ? t().configuredHint
        : props.state === "setup-required"
          ? props.admin
            ? t().setupAdmin
            : t().setupUser
          : props.admin
            ? t().unavailableAdmin
            : t().unavailableUser;
  return (
    <Notice
      tone={props.state === "setup-required" || props.state === "unavailable" ? "warn" : "note"}
      icon={props.state === "setup-required" || props.state === "unavailable" ? undefined : "info-circle"}
      title={title()}
      actions={props.settingsLink ? [{ label: t().configure, href: "/admin/signin", forward: true }] : undefined}
    >
      {detail()}
    </Notice>
  );
}
