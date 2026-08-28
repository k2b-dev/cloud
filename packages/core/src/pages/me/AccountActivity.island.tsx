import { navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import type { AccountActivity as AccountActivityEntry } from "@valentinkolb/cloud/contracts";
import { type AccountMessages, accountMessages } from "./messages";

type ActivityDays = 7 | 30 | 90;

type Props = {
  initialItems: AccountActivityEntry[];
  days: ActivityDays;
  surface?: "paper" | "section";
};

const activityLabel = (entry: AccountActivityEntry, t: AccountMessages): string =>
  ({
    "accounts.user.change_own_password": t.activityPasswordChanged,
    "accounts.user.remove_self": t.activityAccountDeleted,
    "accounts.user.update": t.activityProfileUpdated,
    "accounts.request.create": t.activityRequestSubmitted,
    "accounts.request.withdraw": t.activityRequestWithdrawn,
    "accounts.user.extend_account": t.activityAccountExtended,
    "service_account_credential.create": t.activityApiKeyCreated,
    "service_account_credential.revoke": t.activityApiKeyRevoked,
    "service_account_credential.authenticate": t.activityApiKeyUsed,
    "webauthn_credential.create": t.activityPasskeyAdded,
    "webauthn_credential.delete": t.activityPasskeyRemoved,
    "webauthn_credential.authenticate": t.activityPasskeyUsed,
  })[entry.action] ?? entry.label;

const outcomeClass = (outcome: AccountActivityEntry["outcome"]): string => {
  if (outcome === "allowed") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (outcome === "denied") return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
};

const setActivityDays = (value: string) => {
  const params = new URLSearchParams(window.location.search);
  if (value === "30") params.delete("activityDays");
  else params.set("activityDays", value);
  const query = params.toString();
  navigateTo(query ? `/me/security?${query}` : "/me/security");
};

export default function AccountActivity(props: Props) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const rootClass = () => (props.surface === "section" ? "min-w-0" : "paper p-5");
  const rangeOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "7", label: t().last7Days, icon: "ti ti-calendar-week" },
        { value: "30", label: t().last30Days, icon: "ti ti-calendar-month" },
        { value: "90", label: t().last90Days, icon: "ti ti-calendar-stats" },
      ],
    },
  ];
  const columns = (): DataTableColumn<AccountActivityEntry>[] => [
    { id: "time", header: t().time, value: (entry) => entry.createdAt, cellClass: "whitespace-nowrap" },
    { id: "activity", header: t().activity, value: (entry) => activityLabel(entry, t()), cellClass: "min-w-[9rem]" },
    { id: "status", header: t().status, value: (entry) => entry.outcome, cellClass: "whitespace-nowrap" },
    { id: "context", header: t().context, value: (entry) => entry.context, cellClass: "min-w-[10rem]" },
  ];
  const outcomeLabel = (outcome: AccountActivityEntry["outcome"]) =>
    outcome === "allowed" ? t().outcomeAllowed : outcome === "denied" ? t().outcomeDenied : t().outcomeFailed;

  return (
    <section class={rootClass()}>
      <div class="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-primary">
            <i class="ti ti-clipboard-list text-sm" />
            {t().accountActivity}
          </h2>
          <p class="mt-1 text-xs text-dimmed">{t().accountActivityDescription}</p>
        </div>
        <FilterChip
          label={t().timeRange}
          icon="ti ti-calendar"
          options={rangeOptions()}
          value={[String(props.days)]}
          onValueChange={(value) => setActivityDays(value[0] ?? "30")}
          isActive={props.days !== 30}
          defaultValue={["30"]}
          position="bottom-right"
          iconOnly
        />
      </div>

      <div class="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
        <DataTable
          rows={props.initialItems}
          columns={columns()}
          getRowId={(entry) => String(entry.id)}
          density="compact"
          highlightColumns={false}
          class="max-h-[22rem] overflow-auto"
          tableClass="w-full min-w-[34rem] text-xs"
          empty={
            <div class="flex flex-col items-center gap-1">
              <i class="ti ti-clipboard-list text-lg text-dimmed" />
              <span>{t().noActivityInRange}</span>
            </div>
          }
          renderCell={({ row: entry, col, render }) => {
            if (col.id === "time") return <span class="text-dimmed">{dates.formatDateTime(entry.createdAt, { locale: locale() })}</span>;
            if (col.id === "activity") return <span class="font-medium text-primary">{activityLabel(entry, t())}</span>;
            if (col.id === "status") return <span class={`tag ${outcomeClass(entry.outcome)}`}>{outcomeLabel(entry.outcome)}</span>;
            if (col.id === "context")
              return entry.context ? <span class="text-secondary">{entry.context}</span> : <span class="text-dimmed">-</span>;
            return render(entry);
          }}
        />
      </div>
    </section>
  );
}
