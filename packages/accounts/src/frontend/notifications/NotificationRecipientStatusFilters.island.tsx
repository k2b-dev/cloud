import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection } from "@k2b/ui";
import { useAccountsMessages } from "../messages";

type Props = {
  batchId: string;
  status: string;
};

const buildUrl = (batchId: string, status: string) => {
  const query = new URLSearchParams();
  if (status) query.set("recipient_status", status);
  const search = query.toString();
  return search ? `/app/accounts/notifications/${batchId}?${search}` : `/app/accounts/notifications/${batchId}`;
};

export default function NotificationRecipientStatusFilters(props: Props) {
  const messages = useAccountsMessages();
  const options = (): FilterChipSection[] => [
    {
      options: [
        { value: "pending", label: messages().pending, icon: "ti ti-clock" },
        { value: "sending", label: messages().sending, icon: "ti ti-loader-2" },
        { value: "sent", label: messages().sent, icon: "ti ti-check" },
        { value: "skipped", label: messages().skipped, icon: "ti ti-ban" },
        { value: "error", label: messages().error, icon: "ti ti-alert-triangle" },
      ],
    },
  ];
  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={messages().recipientStatus}
        icon="ti ti-circle-check"
        options={options()}
        value={props.status ? [props.status] : []}
        onValueChange={(value) => navigateTo(buildUrl(props.batchId, value[0] ?? ""))}
        isActive={props.status.length > 0}
        defaultValue={[]}
      />
    </div>
  );
}
