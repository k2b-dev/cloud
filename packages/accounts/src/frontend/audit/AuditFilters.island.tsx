import { navigateTo } from "@k2b/ssr/nav";
import { Button, FilterChip, type FilterChipSection, prompts } from "@k2b/ui";
import { EntitySearch, type EntitySearchPrincipal } from "@valentinkolb/cloud/account/ui";
import type { AuditActionGroup, AuditOutcome } from "@valentinkolb/cloud/services";
import { useAccountsMessages } from "../messages";
import { actionOptions } from "./audit-labels";

type AuditFiltersProps = {
  search: string;
  actor: string;
  target: string;
  action: string;
  actionGroup: "" | AuditActionGroup;
  serviceAccountId: string;
  outcome: "" | AuditOutcome;
  provider: "" | "local" | "ipa";
  days: number;
};

const buildAuditUrl = (params: AuditFiltersProps & { page?: number }) => {
  const query = new URLSearchParams();
  if (params.search.trim()) query.set("search", params.search.trim());
  if (params.actor.trim()) query.set("actor", params.actor.trim());
  if (params.target.trim()) query.set("target", params.target.trim());
  if (params.action.trim()) query.set("action", params.action.trim());
  if (params.actionGroup) query.set("actionGroup", params.actionGroup);
  if (params.serviceAccountId.trim()) query.set("serviceAccountId", params.serviceAccountId.trim());
  if (params.outcome) query.set("outcome", params.outcome);
  if (params.provider) query.set("provider", params.provider);
  if (params.days !== 30) query.set("days", String(params.days));
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const search = query.toString();
  return search ? `/app/accounts/audit?${search}` : "/app/accounts/audit";
};

export default function AuditFilters(props: AuditFiltersProps) {
  const messages = useAccountsMessages();
  const outcomeOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "allowed", label: messages().allowed, icon: "ti ti-check" },
        { value: "denied", label: messages().denied, icon: "ti ti-ban" },
        { value: "failed", label: messages().failed, icon: "ti ti-alert-circle" },
      ],
    },
  ];
  const rangeOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "7", label: messages().last7Days, icon: "ti ti-calendar-week" },
        { value: "30", label: messages().last30Days, icon: "ti ti-calendar-month" },
        { value: "90", label: messages().last90Days, icon: "ti ti-calendar-stats" },
      ],
    },
  ];
  const providerOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "local", label: messages().local, icon: "ti ti-home-spark" },
        { value: "ipa", label: "FreeIPA", icon: "ti ti-building-fortress" },
      ],
    },
  ];
  const actionGroupOptions = (): FilterChipSection[] => [
    { options: [{ value: "service_accounts", label: messages().serviceAccounts, icon: "ti ti-user-key" }] },
  ];
  const navigate = (patch: Partial<AuditFiltersProps>) => {
    navigateTo(
      buildAuditUrl({
        ...props,
        ...patch,
        page: 1,
      }),
    );
  };

  const selectEntity = (kind: "actor" | "target") => {
    prompts.dialog<void>(
      (close) => (
        <EntitySearch
          includeUsers
          includeGroups={kind === "target"}
          placeholder={kind === "actor" ? messages().searchActor : messages().searchTarget}
          onSelect={(principal: EntitySearchPrincipal) => {
            close();
            if (principal.type === "user") {
              navigate(kind === "actor" ? { actor: principal.userId } : { target: principal.userId });
            } else if (principal.type === "group" && kind === "target") {
              navigate({ target: principal.groupId });
            }
          }}
        />
      ),
      {
        title: kind === "actor" ? messages().filterByActor : messages().filterByTarget,
        icon: kind === "actor" ? "ti ti-user-search" : "ti ti-target",
      },
    );
  };

  const selectServiceAccount = () => {
    prompts.dialog<void>(
      (close) => (
        <EntitySearch
          includeServiceAccounts
          placeholder={messages().searchServiceAccounts}
          onSelect={(principal: EntitySearchPrincipal) => {
            if (principal.type !== "service_account") return;
            close();
            navigate({ actionGroup: "service_accounts", serviceAccountId: principal.serviceAccountId });
          }}
        />
      ),
      {
        title: messages().filterByServiceAccount,
        icon: "ti ti-user-key",
      },
    );
  };

  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={messages().outcome}
        icon="ti ti-filter"
        options={outcomeOptions()}
        value={props.outcome ? [props.outcome] : []}
        onValueChange={(value) => navigate({ outcome: (value[0] as AuditFiltersProps["outcome"] | undefined) ?? "" })}
        isActive={props.outcome.length > 0}
        defaultValue={[]}
      />
      <FilterChip
        label={messages().timeRange}
        icon="ti ti-calendar"
        options={rangeOptions()}
        value={[String(props.days)]}
        onValueChange={(value) => navigate({ days: Number(value[0] ?? 30) })}
        isActive={props.days !== 30}
        defaultValue={["30"]}
      />
      <FilterChip
        label={messages().provider}
        icon="ti ti-building"
        options={providerOptions()}
        value={props.provider ? [props.provider] : []}
        onValueChange={(value) => navigate({ provider: (value[0] as AuditFiltersProps["provider"] | undefined) ?? "" })}
        isActive={props.provider.length > 0}
        defaultValue={[]}
      />
      <FilterChip
        label={messages().action}
        icon="ti ti-bolt"
        options={actionOptions(messages())}
        value={props.action ? [props.action] : []}
        onValueChange={(value) => navigate({ action: value[0] ?? "" })}
        isActive={props.action.length > 0}
        defaultValue={[]}
      />
      <FilterChip
        label={messages().area}
        icon="ti ti-category"
        options={actionGroupOptions()}
        value={props.actionGroup ? [props.actionGroup] : []}
        onValueChange={(value) => navigate({ actionGroup: (value[0] as AuditFiltersProps["actionGroup"] | undefined) ?? "" })}
        isActive={props.actionGroup.length > 0}
        defaultValue={[]}
      />
      <Button
        size="sm"
        variant={props.actor ? "primary" : "subtle"}
        aria-pressed={Boolean(props.actor)}
        onClick={() => selectEntity("actor")}
      >
        <i class="ti ti-user-search" />
        <span>{messages().actor}</span>
      </Button>
      <Button
        size="sm"
        variant={props.target ? "primary" : "subtle"}
        aria-pressed={Boolean(props.target)}
        onClick={() => selectEntity("target")}
      >
        <i class="ti ti-target" />
        <span>{messages().target}</span>
      </Button>
      <Button
        size="sm"
        variant={props.serviceAccountId ? "primary" : "subtle"}
        aria-pressed={Boolean(props.serviceAccountId)}
        onClick={selectServiceAccount}
      >
        <i class="ti ti-user-key" />
        <span>{messages().serviceAccount}</span>
      </Button>
    </div>
  );
}
