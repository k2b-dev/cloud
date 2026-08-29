import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection } from "@k2b/ui";
import { useAccountsMessages } from "../messages";

type Props = {
  search: string;
  kind: string;
  status: string;
};

const buildUrl = (params: { search?: string; kind?: string; status?: string; page?: number }) => {
  const query = new URLSearchParams();
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.kind?.trim()) query.set("kind", params.kind.trim());
  if (params.status?.trim() && params.status !== "active") query.set("status", params.status.trim());
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const search = query.toString();
  return search ? `/app/accounts/service-accounts?${search}` : "/app/accounts/service-accounts";
};

export default function ServiceAccountsFilters(props: Props) {
  const messages = useAccountsMessages();
  const kindOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "user_delegated", label: messages().userBound, icon: "ti ti-user-key" },
        { value: "resource_bound", label: messages().resourceBound, icon: "ti ti-box" },
      ],
    },
  ];
  const statusOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "active", label: messages().active, icon: "ti ti-check" },
        { value: "revoked", label: messages().revoked, icon: "ti ti-key-off" },
      ],
    },
  ];
  const navigate = (patch: Partial<Props>) => {
    navigateTo(buildUrl({ ...props, ...patch, page: 1 }));
  };

  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={messages().type}
        icon="ti ti-filter"
        options={kindOptions()}
        value={props.kind ? [props.kind] : []}
        onValueChange={(value) => navigate({ kind: value[0] ?? "" })}
        isActive={props.kind.length > 0}
        defaultValue={[]}
      />
      <FilterChip
        label={messages().status}
        icon="ti ti-circle-check"
        options={statusOptions()}
        value={props.status ? [props.status] : ["active"]}
        onValueChange={(value) => navigate({ status: value[0] ?? "active" })}
        isActive={(props.status || "active") !== "active"}
        defaultValue={["active"]}
      />
    </div>
  );
}
