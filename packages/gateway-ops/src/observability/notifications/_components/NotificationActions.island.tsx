import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Dropdown, IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "../api-client";
import { gatewayOpsMessages } from "../../../messages";

type NotificationActionsProps = {
  id: string;
  status: "sent" | "pending" | "error";
  subject: string;
  content: string;
  recipient: string;
  error: string | null;
  isAdmin?: boolean;
};

const NotificationActions = (props: NotificationActionsProps) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const resendMutation = mutations.create<{ message: string }, void>({
    mutation: async () => {
      const res = await apiClient[":id"].resend.$post({
        param: { id: props.id },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(t.resendNotificationFailed);
      }
      return data;
    },
    onSuccess: () => {
      toast.success(t.notificationResent);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const updateMutation = mutations.create<{ message: string }, { subject: string; content: string; recipient: string }>({
    mutation: async (vars) => {
      const res = await apiClient[":id"].$patch({
        param: { id: props.id },
        json: vars,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(t.updateNotificationFailed);
      }
      return data;
    },
    onSuccess: () => {
      toast.success(t.notificationUpdated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleSend = async () => {
    const isPending = props.status === "pending";
    const confirmed = await prompts.confirm(t.sendNotificationConfirm({ resend: !isPending, recipient: props.recipient }), {
      title: isPending ? t.sendNotificationTitle : t.resendNotificationTitle,
      icon: "ti ti-send",
      confirmText: isPending ? t.send : t.resend,
      cancelText: t.cancel,
    });
    if (confirmed) {
      await resendMutation.mutate();
    }
  };

  const handleEdit = async () => {
    const result = await prompts.form({
      title: t.editNotification,
      icon: "ti ti-pencil",
      confirmText: t.save,
      fields: {
        recipient: {
          type: "text" as const,
          label: t.recipient,
          placeholder: t.emailAddress,
          icon: "ti ti-mail",
          required: true,
          default: props.recipient,
        },
        subject: {
          type: "text" as const,
          label: t.subject,
          placeholder: `${t.subject}…`,
          icon: "ti ti-heading",
          required: true,
          default: props.subject,
        },
        content: {
          type: "text" as const,
          label: t.contentHtml,
          placeholder: t.htmlContent,
          multiline: true,
          required: true,
          default: props.content,
        },
      },
    });

    if (result) {
      await updateMutation.mutate({
        recipient: result.recipient,
        subject: result.subject,
        content: result.content,
      });
    }
  };

  const showError = () => {
    if (!props.error) return;
    void prompts.dialog<void>(
      (close) => (
        <div class="flex flex-col gap-3">
          <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-zinc-100 px-3 py-2 font-mono text-[11px] leading-relaxed text-secondary dark:bg-zinc-800">
            {props.error}
          </pre>
          <div class="flex justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={() => close()}>
              {t.close}
            </Button>
          </div>
        </div>
      ),
      {
        title: t.notificationError,
        icon: "ti ti-alert-circle",
      },
    );
  };

  // Admins can always edit, non-admins only pending/error
  const canEdit = props.isAdmin || props.status !== "sent";
  const sendLabel = props.status === "pending" ? t.send : t.resend;

  return (
    <Dropdown.Root
      position="bottom-left"
      width="10rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-send",
              label: sendLabel,
              action: handleSend,
            },
            ...(canEdit
              ? [
                  {
                    icon: "ti ti-pencil",
                    label: t.edit,
                    action: handleEdit,
                  },
                ]
              : []),
            ...(props.status === "error" && props.error
              ? [
                  {
                    icon: "ti ti-alert-circle",
                    label: t.showError,
                    action: showError,
                  },
                ]
              : []),
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly type="button" size="sm" label={t.notificationActions} tooltip={t.manageNotification}>
        <i class="ti ti-dots-vertical text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default NotificationActions;
