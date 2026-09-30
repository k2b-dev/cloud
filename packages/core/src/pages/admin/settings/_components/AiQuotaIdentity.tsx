import type { ServiceAccountKind } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import { quotaMessages } from "./ai-quota-messages";

const icons = {
  user: "ti ti-user",
  group: "ti ti-users",
  authenticated: "ti ti-world",
  service_account: "ti ti-robot",
  public: "ti ti-world",
};
// The principal picker's icon and label per kind, so a picked account looks the same in its grant row.
const serviceAccountKinds = {
  agent: { icon: "ti ti-robot", label: "agentServiceAccount" },
  user_delegated: { icon: "ti ti-user-key", label: "userBoundServiceAccount" },
  resource_bound: { icon: "ti ti-box", label: "resourceBoundServiceAccount" },
  standalone: { icon: "ti ti-key", label: "service_account" },
} as const;
// Without a known kind (usage reports, deleted accounts) the type-level icon and label apply.
const serviceAccountKind = (type: keyof typeof icons, kind?: ServiceAccountKind) =>
  type === "service_account" && kind ? serviceAccountKinds[kind] : undefined;
export const quotaIdentityIcon = (type: keyof typeof icons, kind?: ServiceAccountKind) =>
  serviceAccountKind(type, kind)?.icon ?? icons[type];
export default function AiQuotaIdentity(props: { type: keyof typeof icons; label: string; kind?: ServiceAccountKind }) {
  const locale = useLocale(),
    t = () => quotaMessages.resolve([locale()]).t;
  return (
    <div class="flex min-w-0 items-center gap-3">
      <i class={`${quotaIdentityIcon(props.type, props.kind)} text-lg text-dimmed`} aria-hidden="true" />
      <div class="min-w-0">
        <div class="text-sm font-medium text-primary">{props.type === "authenticated" ? t().allUsers : props.label}</div>
        <div class="text-xs text-dimmed">{t()[serviceAccountKind(props.type, props.kind)?.label ?? props.type]}</div>
      </div>
    </div>
  );
}
