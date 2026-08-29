import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection } from "@k2b/ui";
import { useAccountsMessages } from "../messages";

type Props = {
  status: string;
};

const buildUrl = (status: string) => {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  const search = query.toString();
  return search ? `/app/accounts/notifications?${search}` : "/app/accounts/notifications";
};

export default function NotificationBatchStatusFilters(props: Props) {
  const messages = useAccountsMessages();
  const options = (): FilterChipSection[] => [
    {
      options: [
        { value: "draft", label: messages().draft, icon: "ti ti-edit" },
        { value: "ready", label: messages().ready, icon: "ti ti-player-play" },
        { value: "running", label: messages().running, icon: "ti ti-loader-2" },
        { value: "completed", label: messages().completed, icon: "ti ti-check" },
        { value: "completed_with_errors", label: messages().withErrors, icon: "ti ti-alert-triangle" },
        { value: "failed", label: messages().failed, icon: "ti ti-circle-x" },
      ],
    },
  ];
  return (
    <FilterChip
      label={messages().status}
      icon="ti ti-circle-check"
      options={options()}
      value={props.status ? [props.status] : []}
      onValueChange={(value) => navigateTo(buildUrl(value[0] ?? ""))}
      isActive={props.status.length > 0}
      defaultValue={[]}
    />
  );
}
