import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { useAccountsMessages } from "../messages";

type DenyRequestProps = {
  requestId: string;
  email: string;
  firstName: string;
};

export default function DenyRequest(props: DenyRequestProps) {
  const messages = useAccountsMessages();
  const mutation = mutations.create<void, { reason?: string }>({
    mutation: async (vars) => {
      const res = await apiClient["account-requests"][":id"].deny.$post({
        param: { id: props.requestId },
        json: vars,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().denyRequestFailed);
      }
    },
    onSuccess: () => {
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const result = await prompts.form({
      title: messages().denyAccountRequest,
      icon: "ti ti-x",
      confirmText: messages().denyRequest,
      fields: {
        info: {
          type: "info",
          content: () => (
            <NoticeCard tone="warning" icon={false}>
              {messages().denyConfirm({ name: props.firstName, email: props.email })}
            </NoticeCard>
          ),
        },
        reason: {
          type: "text",
          multiline: true,
          label: messages().optionalReason,
          placeholder: messages().denyReasonPlaceholder,
          description: messages().denyReasonDescription,
        },
      },
    });

    if (result !== null) {
      await mutation.mutate({
        reason: result.reason || undefined,
      });
    }
  };

  return (
    <Button size="sm" variant="danger" onClick={handleClick} disabled={mutation.loading()}>
      {mutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-x" />}
      <span>{messages().deny}</span>
    </Button>
  );
}
