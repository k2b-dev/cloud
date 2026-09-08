import { ButtonLink, NoticeCard, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { ApprovalAvailability } from "./availability";
import { appApprovalMessages } from "./messages";

export default function ApprovalStatus(props: { state: ApprovalAvailability; admin?: boolean; settingsLink?: boolean }) {
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
    <NoticeCard tone={props.state === "setup-required" || props.state === "unavailable" ? "warning" : "info"} title={title()}>
      <p>{detail()}</p>
      <Show when={props.settingsLink}>
        <ButtonLink href="/admin/settings?tab=user" variant="secondary" size="sm" class="mt-2">
          {t().configure}
        </ButtonLink>
      </Show>
    </NoticeCard>
  );
}
