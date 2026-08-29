import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection } from "@k2b/ui";
import { useAccountsMessages } from "../messages";

type ReminderFiltersProps = {
  search: string;
  status: string;
  kind: string;
};

const buildUrl = (params: { search?: string; kind?: string; status?: string; page?: number }) => {
  const query = new URLSearchParams();
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.kind?.trim()) query.set("kind", params.kind.trim());
  if (params.status?.trim()) query.set("status", params.status.trim());
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const search = query.toString();
  return search ? `/app/accounts/reminders?${search}` : "/app/accounts/reminders";
};

export default function ReminderFilters(props: ReminderFiltersProps) {
  const messages = useAccountsMessages();
  const statusOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "", label: messages().all, icon: "ti ti-list" },
        { value: "pending", label: messages().pending, icon: "ti ti-clock" },
        { value: "sent", label: messages().sent, icon: "ti ti-check" },
        { value: "error", label: messages().error, icon: "ti ti-alert-circle" },
      ],
    },
  ];
  const kindOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "", label: messages().all, icon: "ti ti-list" },
        { value: "ipa_expiry", label: "FreeIPA", icon: "ti ti-user-shield" },
        { value: "guest_expiry", label: messages().guest, icon: "ti ti-user" },
      ],
    },
  ];
  const navigate = (patch: { kind?: string; status?: string }) => {
    navigateTo(
      buildUrl({
        search: props.search,
        kind: patch.kind ?? props.kind,
        status: patch.status ?? props.status,
        page: 1,
      }),
    );
  };

  return (
    <div class="flex flex-wrap gap-2">
      <FilterChip
        label={messages().status}
        icon="ti ti-filter"
        options={statusOptions()}
        value={props.status ? [props.status] : []}
        onValueChange={(value) => navigate({ status: value[0] ?? "" })}
        isActive={props.status.length > 0}
        defaultValue={[]}
      />
      <FilterChip
        label={messages().kind}
        icon="ti ti-bell"
        options={kindOptions()}
        value={props.kind ? [props.kind] : []}
        onValueChange={(value) => navigate({ kind: value[0] ?? "" })}
        isActive={props.kind.length > 0}
        defaultValue={[]}
      />
    </div>
  );
}
