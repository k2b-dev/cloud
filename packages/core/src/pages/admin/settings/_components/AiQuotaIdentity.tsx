import { useLocale } from "@k2b/ui";
import { quotaMessages } from "./ai-quota-messages";
const icons = {
  user: "ti ti-user",
  group: "ti ti-users",
  authenticated: "ti ti-world",
  service_account: "ti ti-robot",
  public: "ti ti-world",
};
export const quotaIdentityIcon = (type: keyof typeof icons) => icons[type];
export default function AiQuotaIdentity(props: { type: keyof typeof icons; label: string }) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  return (
    <div class="flex min-w-0 items-center gap-3">
      <i class={`${quotaIdentityIcon(props.type)} text-lg text-dimmed`} aria-hidden="true" />
      <div class="min-w-0">
        <div class="text-sm font-medium text-primary">{props.type === "authenticated" ? t().allUsers : props.label}</div>
        <div class="text-xs text-dimmed">{t()[props.type]}</div>
      </div>
    </div>
  );
}
