import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, onMount } from "solid-js";
import { apiClient } from "../api-client";
import { gatewayOpsMessages } from "../../../messages";

type SendResult = {
  sent: number;
  failed: number;
  errors: { id: string; recipient: string; error: string }[];
};

const SendAllPending = () => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const [pendingCount, setPendingCount] = createSignal<number | null>(0);

  // Fetch pending count on mount
  onMount(async () => {
    try {
      const res = await apiClient["pending-system"].count.$get();
      if (res.ok) {
        const data = await res.json();
        setPendingCount(data.count);
      }
    } catch {
      // Ignore errors
    }
  });

  const sendAllMutation = mutations.create<SendResult, void>({
    mutation: async () => {
      const res = await apiClient["pending-system"]["send-all"].$post();
      const data = await res.json();
      if (!res.ok) {
        throw new Error("message" in data ? data.message : t.sendNotificationsFailed);
      }
      return data as SendResult;
    },
    onSuccess: async (result) => {
      setPendingCount(0);

      if (result.failed === 0) {
        toast.success(t.sentNotifications({ count: result.sent }));
      } else {
        const errorList = result.errors.map((e) => `${e.recipient}: ${e.error}`).join("\n");
        await prompts.alert(t.sendResults({ sent: result.sent, failed: result.failed, errors: errorList }));
      }
      refreshCurrentPath();
    },
    onError: (err) => {
      prompts.error(err.message);
    },
  });

  const handleClick = async () => {
    const count = pendingCount();
    if (count === null || count === 0) return;

    const confirmed = await prompts.confirm(
      t.sendPendingConfirm({ count }),
      {
        title: t.sendAllPendingTitle,
        icon: "ti ti-send",
        confirmText: t.sendNotificationCount({ count }),
        cancelText: t.cancel,
      },
    );

    if (confirmed) {
      await sendAllMutation.mutate();
    }
  };

  return (
    <Button type="button" size="sm" onClick={handleClick} disabled={sendAllMutation.loading() || pendingCount() === 0}>
      {sendAllMutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-send" />}
      <span>{t.sendPendingCount({ count: pendingCount() })}</span>
    </Button>
  );
};

export default SendAllPending;
